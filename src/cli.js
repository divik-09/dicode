import fs from 'node:fs';
import path from 'node:path';
import { runHeadless } from './headless.js';
import { setup, doctor, version } from './setup.js';
import { listSessions } from './session.js';
import { MODES } from './permissions.js';
import { userSettingsPath, updateSettingsFile, loadSettings } from './config.js';
import { getPath, setPath, parseValue } from './util.js';

const HELP = `DiCode ${version()}: an agentic coding assistant for your terminal

Usage
  dicode [prompt]                      start an interactive session (optionally with a first message)
  dicode -p "prompt"                   run once without interaction and print the result
  cat error.log | dicode -p "explain"  piped input is appended to the prompt

Options
  -p, --print                 non-interactive mode
  -c, --continue              continue the most recent conversation in this folder
  -r, --resume [id]           resume a conversation (lists them if no id is given)
  -m, --model <ref>           model, e.g. anthropic/claude-sonnet-5-5, openai/gpt-4.1, ollama/qwen2.5-coder
  --permission-mode <mode>    ${MODES.join(' | ')}
  --dangerously-skip-permissions   never ask (same as --permission-mode bypassPermissions)
  --allowedTools <rules>      e.g. "Bash(npm test:*) Edit"   (adds allow rules)
  --disallowedTools <rules>   e.g. "Bash(git push:*)"        (adds deny rules)
  --output-format <fmt>       text | json | stream-json   (with -p)
  --max-turns <n>             limit agent steps (with -p)
  --add-dir <dir>             allow edits in another directory too
  --think                     enable extended thinking
  --verbose                   show thinking and extra detail
  -v, --version · -h, --help

Commands
  dicode setup                configure provider, API key and default model
  dicode doctor [--check]     check your environment (and the model connection)
  dicode config get|set <key> [value]    edit ~/.dicode/settings.json
  dicode sessions             list conversations in this folder
`;

function parse(argv) {
  const o = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[i + 1]; if (v === undefined || v.startsWith('-')) throw new Error(`${a} needs a value`); i++; return v; };
    if (a === '-p' || a === '--print') o.print = true;
    else if (a === '-c' || a === '--continue') o.continue = true;
    else if (a === '-r' || a === '--resume') { o.resume = true; if (argv[i + 1] && !argv[i + 1].startsWith('-')) o.resumeId = argv[++i]; }
    else if (a === '-m' || a === '--model') o.model = val();
    else if (a === '--permission-mode') o.mode = val();
    else if (a === '--dangerously-skip-permissions') o.mode = 'bypassPermissions';
    else if (a === '--allowedTools' || a === '--allowed-tools') o.allowedTools = val();
    else if (a === '--disallowedTools' || a === '--disallowed-tools') o.disallowedTools = val();
    else if (a === '--output-format') o.outputFormat = val();
    else if (a === '--max-turns') o.maxTurns = Number(val());
    else if (a === '--add-dir') (o.addDirs ||= []).push(val());
    else if (a === '--think') o.think = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--check') o.check = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-') && a.length > 1) throw new Error(`Unknown option ${a}. See dicode --help.`);
    else o.positional.push(a);
  }
  return o;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv) {
  const o = parse(argv);
  if (o.version) { console.log(version()); return 0; }
  if (o.help) { console.log(HELP); return 0; }
  const root = fs.realpathSync(process.cwd());
  const [cmd, ...rest] = o.positional;

  if (cmd === 'setup') return setup({});
  if (cmd === 'doctor') return doctor({ check: o.check, root });
  if (cmd === 'sessions') {
    const list = listSessions(root);
    if (!list.length) { console.log('No conversations in this folder yet.'); return 0; }
    for (const s of list.slice(0, 30)) console.log(`${s.id}  ${new Date(s.updatedAt).toLocaleString()}  ${String(s.messages).padStart(4)} msgs  ${s.preview}`);
    return 0;
  }
  if (cmd === 'config') {
    const [verb, key, ...v] = rest;
    if (verb === 'set' && key && v.length) { updateSettingsFile(userSettingsPath(), (cur) => setPath(cur, key, parseValue(v.join(' ')))); console.log(`${key} updated in ${userSettingsPath()}`); return 0; }
    if (verb === 'get' || !verb || verb === 'list') {
      const s = loadSettings(root);
      const redact = (x) => JSON.parse(JSON.stringify(x, (k, val) => (/apiKey|token|secret/i.test(k) && typeof val === 'string' && val ? '***' : val)));
      console.log(JSON.stringify(redact(key ? getPath(s, key) : s), null, 2));
      return 0;
    }
    console.error('Usage: dicode config get [key] | dicode config set <key> <value>');
    return 1;
  }

  if (o.mode && !MODES.includes(o.mode)) throw new Error(`Unknown permission mode "${o.mode}". Use one of: ${MODES.join(', ')}`);
  const settingsOverride = {};
  if (o.model) settingsOverride.model = o.model;
  if (o.think) settingsOverride.thinking = { enabled: true, budgetTokens: 10000 };
  if (o.addDirs) settingsOverride.permissions = { additionalDirectories: o.addDirs.map((d) => path.resolve(d)) };
  const cli = { model: o.model, mode: o.mode, verbose: o.verbose, settings: settingsOverride, allowedTools: o.allowedTools, disallowedTools: o.disallowedTools, outputFormat: o.outputFormat, maxTurns: o.maxTurns };

  if (o.continue) {
    const last = listSessions(root)[0];
    if (!last) { console.error('No earlier conversation in this folder.'); return 1; }
    cli.resumeId = last.id;
  }
  if (o.resume) {
    if (o.resumeId) cli.resumeId = listSessions(root).find((s) => s.id.startsWith(o.resumeId))?.id || o.resumeId;
    else {
      const list = listSessions(root).slice(0, 20);
      if (!list.length) { console.error('No earlier conversations in this folder.'); return 1; }
      list.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${new Date(s.updatedAt).toLocaleString()}  ${s.preview}`));
      const { Prompter } = await import('./ui/input.js');
      const n = Number(await new Prompter().question('Resume which? '));
      if (!list[n - 1]) return 1;
      cli.resumeId = list[n - 1].id;
    }
  }

  const promptArg = cmd ? o.positional.join(' ') : '';
  if (o.print || !process.stdin.isTTY || !process.stdout.isTTY) {
    const piped = await readStdin();
    const prompt = [promptArg, piped && `<stdin>\n${piped.slice(0, 200000)}\n</stdin>`].filter(Boolean).join('\n\n');
    if (!prompt.trim()) { console.error('Nothing to do: give a prompt, e.g. dicode -p "explain this repo"'); return 1; }
    return runHeadless({ root, cli, prompt });
  }
  const { startRepl } = await import('./ui/repl.js');
  return startRepl({ root, cli: { ...cli, prompt: promptArg || null } });
}
