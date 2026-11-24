import { resolveProvider } from '../config.js';
import * as anthropic from './anthropic.js';
import * as openai from './openai.js';
import { isAbort, isContextOverflow, isRetryable } from './errors.js';
import { sleep } from '../util.js';

export function parseModelRef(ref) {
  const i = String(ref).indexOf('/');
  if (i < 1) throw new Error(`Model "${ref}" must look like <provider>/<model-id>, e.g. anthropic/claude-sonnet-5-5`);
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

/**
 * Call the model: retry transient errors with backoff, then fall through the fallback list.
 * Context-overflow errors are re-thrown immediately so the caller can compact and retry.
 */
export async function callModel({ settings, refs, onRetry, retries = 3, ...args }) {
  const errors = [];
  for (const ref of refs) {
    const { provider, model } = parseModelRef(ref);
    const p = resolveProvider(settings, provider);
    const impl = p.kind === 'anthropic' ? anthropic : openai;
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await impl.complete({ provider: p, model, maxTokens: settings.maxOutputTokens, thinking: p.kind === 'anthropic' ? settings.thinking : null, ...args });
        return { ...out, modelUsed: ref };
      } catch (e) {
        if (isAbort(e) || args.signal?.aborted) throw e;
        if (isContextOverflow(e)) { e.contextOverflow = true; throw e; }
        if (isRetryable(e) && attempt < retries) {
          const wait = e.retryAfter ? e.retryAfter * 1000 : Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250;
          onRetry?.({ ref, attempt: attempt + 1, wait, error: e.message });
          await sleep(wait);
          continue;
        }
        errors.push(`${ref}: ${e.message}`);
        break;
      }
    }
  }
  throw new Error(errors.length === 1 ? errors[0] : `All models failed:\n${errors.join('\n')}`);
}
