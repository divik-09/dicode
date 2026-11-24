import { spawn } from 'node:child_process';

/**
 * Hooks are shell commands from settings, run on lifecycle events with a JSON payload on stdin.
 *   { "hooks": { "PreToolUse": [{ "matcher": "Edit|Write", "command": "./scripts/check.sh" }] } }
 * Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop.
 * Exit 0 = ok. Exit 2 = block (stderr is shown to the model). Other codes = warning only.
 */
function runOne(command, payload, { cwd, timeoutSec = 60, signal }) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, DICODE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let out = '', err = '';
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const t = setTimeout(kill, timeoutSec * 1000);
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out: out.trim(), err: err.trim() }); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

const matches = (matcher, value) => {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(value); } catch { return matcher === value; }
};

export async function runHooks(settings, event, payload, { cwd, matchValue = '', signal } = {}) {
  const hooks = (settings.hooks?.[event] || []).filter((h) => h.command && matches(h.matcher, matchValue));
  const result = { blocked: false, messages: [], warnings: [] };
  for (const h of hooks) {
    const r = await runOne(h.command, { hook_event_name: event, cwd, ...payload }, { cwd, timeoutSec: h.timeoutSec, signal });
    if (r.code === 2) { result.blocked = true; result.messages.push(r.err || r.out || `blocked by hook: ${h.command}`); }
    else if (r.code !== 0) result.warnings.push(`hook "${h.command}" exited ${r.code}: ${(r.err || r.out).slice(0, 300)}`);
    else if (r.out && event === 'UserPromptSubmit') result.messages.push(r.out); // extra context for the prompt
  }
  return result;
}

export const hasHooks = (settings, event, matchValue) => (settings.hooks?.[event] || []).some((h) => h.command && matches(h.matcher, matchValue));
