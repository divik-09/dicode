import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { shortId, truncateMiddle, within, realpathLoose } from '../util.js';

const SHELL = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Collect output without unbounded memory: keep the head and a rolling tail. */
function collector(max) {
  let head = '', tail = '', dropped = 0;
  return {
    push(d) {
      const s = d.toString();
      if (head.length < max) { const room = max - head.length; head += s.slice(0, room); if (s.length > room) tail += s.slice(room); }
      else tail += s;
      if (tail.length > max) { dropped += tail.length - max; tail = tail.slice(-max); }
    },
    text: () => (dropped ? `${head}\n… [${dropped} characters dropped] …\n${tail}` : head + tail),
  };
}

const childEnv = () => ({ ...process.env, DICODE: '1', GIT_PAGER: 'cat', PAGER: 'cat', GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0', npm_config_yes: 'true' });

function killTree(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref();
}

export const Bash = {
  name: 'Bash',
  description: 'Run a shell command (bash). The working directory persists between calls. Commands are non-interactive (no stdin). Default timeout 2 min, max 10 min (timeout in ms). Use run_in_background for servers/watchers, then BashOutput to read and KillShell to stop. Output over ~30k characters is truncated. Prefer Read/Grep/Glob over cat/grep/find.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string', description: 'What this command does, in 5-10 words' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds (max 600000)' },
      run_in_background: { type: 'boolean' },
    },
    required: ['command'],
  },
  summary: (i) => i.command.length > 120 ? i.command.slice(0, 117) + '…' : i.command,
  preview: (i) => ({ kind: 'command', command: i.command, description: i.description }),
  async run({ command, timeout, run_in_background }, ctx) {
    const cfg = ctx.settings.bash;
    if (!command?.trim()) throw new Error('command is empty');
    const cwd = fs.existsSync(ctx.shell.cwd) ? ctx.shell.cwd : ctx.root;

    if (run_in_background) {
      const id = `bash_${shortId()}`;
      const child = spawn(SHELL, ['-c', command], { cwd, env: childEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const job = { id, command, child, out: collector(cfg.maxOutputChars * 4), read: 0, all: '', exitCode: null, startedAt: Date.now() };
      const onData = (d) => { job.all += d.toString(); if (job.all.length > 2e6) { job.read = Math.max(0, job.read - (job.all.length - 1e6)); job.all = job.all.slice(-1e6); } };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('close', (code) => { job.exitCode = code ?? -1; });
      child.on('error', (e) => { job.all += `\n[spawn error: ${e.message}]`; job.exitCode = -1; });
      ctx.background.set(id, job);
      return `Started background shell ${id} (pid ${child.pid}) in ${cwd}. Read its output with BashOutput({"shell_id":"${id}"}); stop it with KillShell.`;
    }

    const timeoutMs = Math.min(timeout || cfg.defaultTimeoutSec * 1000, cfg.maxTimeoutSec * 1000);
    const cwdFile = path.join(os.tmpdir(), `dicode-cwd-${process.pid}-${shortId()}`);
    const script = `${command}\n__dicode_ec=$?\npwd -P > ${shq(cwdFile)} 2>/dev/null\nexit $__dicode_ec`;
    const out = collector(cfg.maxOutputChars);
    const result = await new Promise((resolve) => {
      const child = spawn(SHELL, ['-c', script], { cwd, env: childEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let timedOut = false, done = false;
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      const onAbort = () => killTree(child);
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', out.push); child.stderr.on('data', out.push);
      const finish = (code, extra) => {
        if (done) return; done = true;
        clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort);
        resolve({ code, timedOut, extra });
      };
      child.on('error', (e) => finish(127, e.message));
      child.on('close', (code, sig) => finish(code ?? (sig ? 128 : 1)));
    });

    let note = '';
    try {
      const newCwd = fs.readFileSync(cwdFile, 'utf8').trim();
      fs.rmSync(cwdFile, { force: true });
      if (newCwd && fs.existsSync(newCwd)) {
        if (ctx.permissions.inProject(newCwd)) ctx.shell.cwd = newCwd;
        else { ctx.shell.cwd = ctx.root; note = `\n[shell cwd reset to project root ${ctx.root}; it had moved outside the project]`; }
      }
    } catch {}

    let text = truncateMiddle(out.text().trimEnd(), cfg.maxOutputChars);
    if (ctx.signal?.aborted) return `${text}\n[interrupted by user]`;
    if (result.timedOut) return `${text}\n[command timed out after ${Math.round(timeoutMs / 1000)}s and was killed]`;
    if (result.extra) text += `\n[${result.extra}]`;
    if (!text) text = '(no output)';
    if (result.code !== 0) return { text: `${text}\n[exit code ${result.code}]${note}`, isError: true };
    return text + note;
  },
};

export const BashOutput = {
  name: 'BashOutput',
  description: 'Read new output from a background shell started with run_in_background, and whether it is still running.',
  input_schema: { type: 'object', properties: { shell_id: { type: 'string' }, filter: { type: 'string', description: 'Optional regex; only matching lines are returned' } }, required: ['shell_id'] },
  readOnly: true, concurrencySafe: true,
  summary: (i) => i.shell_id,
  async run({ shell_id, filter }, ctx) {
    const job = ctx.background.get(shell_id);
    if (!job) throw new Error(`No background shell ${shell_id}. Known: ${[...ctx.background.keys()].join(', ') || 'none'}`);
    let fresh = job.all.slice(job.read);
    job.read = job.all.length;
    if (filter) { const re = new RegExp(filter); fresh = fresh.split('\n').filter((l) => re.test(l)).join('\n'); }
    const status = job.exitCode === null ? `running (${Math.round((Date.now() - job.startedAt) / 1000)}s)` : `exited with code ${job.exitCode}`;
    return `[${shell_id}: ${status}]\n${truncateMiddle(fresh, ctx.settings.bash.maxOutputChars) || '(no new output)'}`;
  },
};

export const KillShell = {
  name: 'KillShell',
  description: 'Stop a background shell.',
  input_schema: { type: 'object', properties: { shell_id: { type: 'string' } }, required: ['shell_id'] },
  summary: (i) => i.shell_id,
  async run({ shell_id }, ctx) {
    const job = ctx.background.get(shell_id);
    if (!job) throw new Error(`No background shell ${shell_id}`);
    if (job.exitCode === null) killTree(job.child);
    ctx.background.delete(shell_id);
    return `Killed ${shell_id}.`;
  },
};

export function killAllBackground(background) {
  for (const job of background.values()) if (job.exitCode === null) killTree(job.child);
  background.clear();
}
