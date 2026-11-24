import { ProviderError } from './errors.js';
import { sse } from './sse.js';

/** Put a cache breakpoint on the last block of the last message so every agent step re-uses the cached prefix. */
function withCacheBreakpoint(messages) {
  if (!messages.length) return messages;
  const out = messages.slice();
  const last = out.at(-1);
  const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((b) => ({ ...b }));
  const i = content.findLastIndex((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
  if (i >= 0) content[i] = { ...content[i], cache_control: { type: 'ephemeral' } };
  out[out.length - 1] = { ...last, content };
  return out;
}

export async function complete({ provider, model, system, messages, tools, signal, onText, onThinking, maxTokens = 16000, thinking }) {
  if (!provider.apiKey) {
    throw new ProviderError('No Anthropic API key. Run `dicode setup` or set ANTHROPIC_API_KEY.', { status: 401, provider: 'anthropic' });
  }
  const body = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: withCacheBreakpoint(messages),
    stream: true,
  };
  if (tools?.length) body.tools = tools;
  if (thinking?.enabled) {
    body.thinking = { type: 'enabled', budget_tokens: thinking.budgetTokens };
    body.max_tokens = Math.max(maxTokens, thinking.budgetTokens + 4000);
  }

  const res = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new ProviderError(`anthropic ${res.status}: ${text.slice(0, 500)}`, { status: res.status, provider: 'anthropic' });
    err.retryAfter = Number(res.headers.get('retry-after')) || 0;
    throw err;
  }

  const blocks = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = 'end_turn';
  for await (const ev of sse(res.body)) {
    let d;
    try { d = JSON.parse(ev.data); } catch { continue; }
    switch (d.type) {
      case 'message_start': {
        const u = d.message?.usage || {};
        usage.input = u.input_tokens || 0;
        usage.cacheRead = u.cache_read_input_tokens || 0;
        usage.cacheWrite = u.cache_creation_input_tokens || 0;
        break;
      }
      case 'content_block_start': {
        const cb = d.content_block;
        if (cb.type === 'tool_use') blocks[d.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {}, _json: '' };
        else if (cb.type === 'thinking') blocks[d.index] = { type: 'thinking', thinking: '', signature: '' };
        else if (cb.type === 'redacted_thinking') blocks[d.index] = { type: 'redacted_thinking', data: cb.data };
        else blocks[d.index] = { type: 'text', text: '' };
        break;
      }
      case 'content_block_delta': {
        const b = blocks[d.index];
        if (!b) break;
        const dt = d.delta;
        if (dt.type === 'text_delta') { b.text += dt.text; onText?.(dt.text); }
        else if (dt.type === 'input_json_delta') b._json += dt.partial_json;
        else if (dt.type === 'thinking_delta') { b.thinking += dt.thinking; onThinking?.(dt.thinking); }
        else if (dt.type === 'signature_delta') b.signature += dt.signature;
        break;
      }
      case 'content_block_stop': {
        const b = blocks[d.index];
        if (b?.type === 'tool_use') {
          try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b._partial = true; }
          delete b._json;
        }
        break;
      }
      case 'message_delta':
        stopReason = d.delta?.stop_reason || stopReason;
        if (d.usage?.output_tokens != null) usage.output = d.usage.output_tokens;
        break;
      case 'error': {
        const err = new ProviderError(`anthropic stream error: ${d.error?.message || 'unknown'}`, { status: d.error?.type === 'overloaded_error' ? 529 : 500, provider: 'anthropic' });
        throw err;
      }
    }
  }
  // Tool calls whose JSON never finished (output limit) are marked partial; the loop drops them.
  for (const b of blocks) if (b?.type === 'tool_use' && b._json !== undefined) { b._partial = true; delete b._json; }
  const content = blocks.filter(Boolean).filter((b) => b.type !== 'text' || b.text.length > 0);
  return { content, stopReason, usage };
}
