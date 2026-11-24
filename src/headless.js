import { Agent } from './agent.js';
import { createPermissions } from './permissions.js';
import { loadSettings } from './config.js';
import { openSession, loadSession } from './session.js';

const splitRules = (s) => (s ? String(s).split(/,(?![^(]*\))|\s+(?![^(]*\))/).map((x) => x.trim()).filter(Boolean) : []);

/**
 * Non-interactive run (dicode -p). Anything that would need a permission prompt is denied unless allowed by
 * --allowedTools, settings rules, or --permission-mode. Output formats: text | json | stream-json.
 */
export async function runHeadless({ root, cli, prompt }) {
  const settings = loadSettings(root, { ...cli, settings: { ...(cli.settings || {}), ...(cli.maxTurns ? { maxSteps: cli.maxTurns } : {}) } });
  for (const r of splitRules(cli.allowedTools)) settings.permissions.allow.push(r);
  for (const r of splitRules(cli.disallowedTools)) settings.permissions.deny.push(r);
  const permissions = createPermissions({ settings, root, mode: cli.mode, headless: true });
  const fmt = cli.outputFormat || 'text';
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  let messages = [];
  let session;
  if (cli.resumeId) { messages = loadSession(root, cli.resumeId).messages; session = openSession(root, cli.resumeId); }
  else session = openSession(root);

  let plan = null;
  const ui = {
    onEvent(e) {
      if (fmt === 'stream-json') {
        if (e.type === 'tool_start') emit({ type: 'tool_use', id: e.id, name: e.name, input: e.input });
        else if (e.type === 'tool_end') emit({ type: 'tool_result', id: e.id, name: e.name, is_error: !e.ok, output: e.output.slice(0, 4000) });
        else if (e.type === 'text') emit({ type: 'text_delta', text: e.text });
        else if (e.type === 'step_end') emit({ type: 'step_end', stop_reason: e.stopReason });
        else if (['notice', 'error', 'compacted', 'retry', 'todos'].includes(e.type)) emit({ ...e, summary: undefined });
      } else if (cli.verbose) {
        if (e.type === 'tool_start') process.stderr.write(`⏺ ${e.name}(${e.summary})\n`);
        else if (e.type === 'tool_end' && !e.ok) process.stderr.write(`  ⎿ ${e.output.split('\n')[0]}\n`);
        else if (e.type === 'notice' || e.type === 'error') process.stderr.write(`${e.text || e.message}\n`);
      }
    },
    approvePlan: async (p) => { plan = p; return { approved: false, feedback: 'This is a non-interactive run, so the plan cannot be approved. Stop now and give the plan as your final answer.' }; },
  };

  const agent = new Agent({ settings, root, permissions, session, ui, model: cli.model, messages });
  session.meta({ cwd: root, model: agent.model, startedAt: Date.now(), headless: true });
  const onSig = () => agent.abort();
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  const t0 = Date.now();
  let r;
  try { r = await agent.run(prompt); } finally { process.off('SIGINT', onSig); process.off('SIGTERM', onSig); agent.dispose(); }

  const text = plan && !r.text ? plan : r.text;
  const isError = !!r.error || r.interrupted;
  const result = {
    type: 'result', subtype: r.error ? 'error' : r.interrupted ? 'interrupted' : 'success', is_error: isError,
    result: r.error ? r.error.message : text, session_id: session.id, num_turns: r.steps, duration_ms: Date.now() - t0,
    usage: { input_tokens: agent.usage.input, output_tokens: agent.usage.output, cache_read_input_tokens: agent.usage.cacheRead, cache_creation_input_tokens: agent.usage.cacheWrite },
    total_cost_usd: agent.usage.costKnown ? Number(agent.usage.cost.toFixed(6)) : null,
    ...(plan ? { plan } : {}),
  };
  if (fmt === 'json' || fmt === 'stream-json') emit(result);
  else if (r.error) process.stderr.write(`Error: ${r.error.message}\n`);
  else process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
  return isError ? 1 : 0;
}
