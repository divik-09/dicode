import { ProviderError } from './errors.js';

export function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      for (const r of m.content.filter((b) => b.type === 'tool_result')) {
        const text = Array.isArray(r.content) ? r.content.map((c) => (c.type === 'text' ? c.text : '[image omitted]')).join('\n') : String(r.content ?? '');
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: text });
      }
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

export async function complete({ provider, model, system, messages, tools, signal, onText, maxTokens = 16000 }) {
  const body = { model, max_tokens: maxTokens, messages: toOpenAIMessages(system, messages) };
  if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const headers = { 'content-type': 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const res = await fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new ProviderError(`${provider.name} ${res.status}: ${(await res.text()).slice(0, 500)}`, { status: res.status, provider: provider.name });
  const j = await res.json();
  const choice = j.choices?.[0];
  if (!choice) throw new ProviderError(`${provider.name}: empty response`, { status: 502, provider: provider.name });
  const content = [];
  if (choice.message?.content) { content.push({ type: 'text', text: choice.message.content }); onText?.(choice.message.content); }
  for (const c of choice.message?.tool_calls || []) {
    let input = {}, partial = false;
    try { input = JSON.parse(c.function.arguments || '{}'); } catch { partial = true; }
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input, ...(partial ? { _partial: true } : {}) });
  }
  const stopReason = choice.finish_reason === 'length' ? 'max_tokens' : content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  return { content, stopReason, usage: { input: j.usage?.prompt_tokens || 0, output: j.usage?.completion_tokens || 0, cacheRead: 0, cacheWrite: 0 } };
}
