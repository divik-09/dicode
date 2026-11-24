import fs from 'node:fs';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { userSettingsPath, updateSettingsFile, loadSettings, resolveProvider, homeDir } from './config.js';
import { parseModelRef, callModel } from './providers/index.js';
import { which } from './util.js';
import { findMemoryFiles } from './prompt.js';
import { c, line } from './ui/term.js';

function ask(q, { secret = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (secret && process.stdin.isTTY) {
      const orig = rl._writeToOutput.bind(rl);
      process.stdout.write(q);
      rl._writeToOutput = (s) => { if (/[\r\n]/.test(s)) orig(s); };
      rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
    } else rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
  });
}

export async function setup(flags = {}) {
  line(c.bold(`\n✻ DiCode setup`) + c.dim(`  (writes ${userSettingsPath()})\n`));
  const providers = [['anthropic', 'Anthropic (Claude), recommended', 'claude-sonnet-5-5'], ['openai', 'OpenAI', ''], ['openrouter', 'OpenRouter', ''], ['ollama', 'Ollama (local)', 'qwen2.5-coder']];
  let pick = providers.find((p) => p[0] === flags.provider);
  if (!pick) {
    providers.forEach((p, i) => line(`  ${i + 1}. ${p[1]}`));
    pick = providers[(Number(await ask('Provider [1]: ')) || 1) - 1] || providers[0];
  }
  const [name, , defModel] = pick;
  let key = flags.apiKey || '';
  if (!key && name !== 'ollama') key = await ask(`${pick[1].split(',')[0]} API key (hidden, Enter to use the environment variable instead): `, { secret: true });
  const model = flags.model || (await ask(`Model id${defModel ? ` [${defModel}]` : ''}: `)) || defModel;
  if (!model) { line(c.red('A model id is required.')); return 1; }
  updateSettingsFile(userSettingsPath(), (cur) => {
    cur.model = `${name}/${model}`;
    if (key) { cur.providers = cur.providers || {}; cur.providers[name] = { ...(cur.providers[name] || {}), apiKey: key }; }
    return cur;
  });
  try { fs.chmodSync(homeDir(), 0o700); } catch {}
  line(c.green(`✓ Saved. Default model: ${name}/${model}`));
  if (!flags.skipCheck) await doctor({ check: true, quiet: true });
  line(`\nNext: ${c.cyan('cd your-project && dicode')}\n`);
  return 0;
}

export async function doctor({ check = false, quiet = false, root = process.cwd() } = {}) {
  let problems = 0;
  const ok = (m) => !quiet && line(`${c.green('✓')} ${m}`);
  const warn = (m) => line(`${c.yellow('!')} ${m}`);
  const bad = (m) => { problems++; line(`${c.red('✗')} ${m}`); };
  if (!quiet) line(c.bold('dicode doctor\n'));
  const major = Number(process.versions.node.split('.')[0]);
  major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node}: DiCode needs Node 20+`);
  fs.existsSync('/bin/bash') || fs.existsSync('/bin/sh') ? ok('POSIX shell available') : bad('No /bin/sh: on Windows, run DiCode inside WSL');
  which('git') ? ok('git found') : warn('git not found: Glob falls back to a slower walk and git context is unavailable');
  which('rg') ? ok('ripgrep found (fast Grep)') : warn('ripgrep (rg) not found: Grep uses a slower built-in search. Install it for big repos.');
  let s;
  try { s = loadSettings(root); ok('Settings parse'); } catch (e) { bad(`Settings error: ${e.message}`); return 1; }
  let provider;
  try {
    const ref = parseModelRef(s.model);
    provider = resolveProvider(s, ref.provider);
    provider.apiKey || ref.provider === 'ollama' ? ok(`Model ${s.model}: credentials found`) : bad(`Model ${s.model}: no API key (run dicode setup or set ${ref.provider.toUpperCase()}_API_KEY)`);
  } catch (e) { bad(e.message); }
  if (!quiet) {
    const mem = findMemoryFiles(root);
    mem.length ? ok(`Instruction files: ${mem.map((m) => m.file).join(', ')}`) : warn('No DICODE.md here yet (run /init inside DiCode)');
    s._trusted ? ok(`This folder is trusted`) : warn('This folder is not trusted yet (you will be asked on first run)');
    if (s.permissions.defaultMode === 'bypassPermissions') warn('defaultMode is bypassPermissions: DiCode will never ask before acting');
  }
  if (check && provider && !problems) {
    process.stdout.write(c.dim('Testing the model connection… '));
    try {
      await callModel({ settings: { ...s, maxOutputTokens: 16, thinking: { enabled: false } }, refs: [s.model], system: 'Reply with OK.', messages: [{ role: 'user', content: 'ping' }], tools: [], retries: 0 });
      line(c.green('works'));
    } catch (e) { line(c.red('failed')); bad(e.message.split('\n')[0].slice(0, 200)); }
  }
  if (!quiet) line(problems ? c.red(`\n${problems} problem(s)`) : c.green('\nAll good'));
  return problems ? 1 : 0;
}

export function version() {
  const j = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return j.version;
}
export const hasGit = () => spawnSync('git', ['--version']).status === 0;
