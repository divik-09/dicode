import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../agent.js';
import { createPermissions, suggestBashRule, EDIT_TOOLS, MODES } from '../permissions.js';
import { loadSettings, isTrusted, trust, resolveProvider } from '../config.js';
import { openSession, loadSession } from '../session.js';
import { parseModelRef } from '../providers/index.js';
import { findMemoryFiles } from '../prompt.js';
import { runCommand, commandNames } from '../commands.js';
import { Bash } from '../tools/bash.js';
import { fmtTokens } from '../util.js';
import { Renderer } from './render.js';
import { Prompter, watchInterrupt } from './input.js';
import { c, line, out, box, renderDiff, formatLine } from './term.js';

const MODE_TAG = {
  default: '',
  acceptEdits: c.magenta('⏵⏵ accept edits ') + c.dim('· '),
  plan: c.cyan('⏸ plan mode ') + c.dim('· '),
  bypassPermissions: c.red('⚠ bypass permissions ') + c.dim('· '),
};
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

export async function startRepl({ root, cli }) {
  let settings = loadSettings(root, cli);
  const prompter = new Prompter({});

  // ---- folder trust (project hooks / allow-rules only apply in trusted folders)
  if (!settings._trusted && !cli.trustProject) {
    line(box('Do you trust the files in this folder?', `${c.bold(root)}\n\nDiCode will read, edit and run commands here (with your approval).\nTrusting the folder also lets its .dicode/settings.json add hooks and permission rules.`, c.yellow));
    const a = (await prompter.question(`${c.bold('Trust this folder?')} ${c.dim('[Y/n] ')}`))?.trim().toLowerCase();
    if (a === null || a === undefined || a.startsWith('n')) { line(c.dim('Okay, exiting.')); return 0; }
    trust(root);
    settings = loadSettings(root, cli);
  }

  const permissions = createPermissions({ settings, root, mode: cli.mode });
  const renderer = new Renderer({ verbose: cli.verbose });
  let session;
  let messages = [];
  if (cli.resumeId) { messages = loadSession(root, cli.resumeId).messages; session = openSession(root, cli.resumeId); }
  else session = openSession(root);

  const ui = {};
  const agent = new Agent({ settings, root, permissions, session, ui, model: cli.model, messages });
  session.meta({ cwd: root, model: agent.model, startedAt: Date.now() });

  // ---- interrupt handling: Esc / Ctrl+C while the agent works
  let stopWatch = null;
  const interrupt = {
    start() { if (!stopWatch) stopWatch = watchInterrupt(() => agent.abort()); },
    stop() { stopWatch?.(); stopWatch = null; },
  };

  ui.onEvent = (e) => renderer.onEvent(e);

  ui.askPermission = async (req) => {
    renderer.pause();
    interrupt.stop();
    const { tool, input, preview } = req;
    let title = tool, body = '', question = 'Do you want to proceed?', alwaysLabel;
    if (tool === 'Bash') {
      title = 'Bash command';
      body = `${c.bold(input.command)}${input.description ? `\n${c.dim(input.description)}` : ''}${req.cwd && req.cwd !== root ? c.dim(`\nin ${req.cwd}`) : ''}`;
      alwaysLabel = `Yes, and don't ask again for ${c.bold(suggestBashRule(input.command).slice(5, -1))} commands in this project`;
    } else if (EDIT_TOOLS.has(tool)) {
      const created = preview?.created;
      title = created ? 'Create file' : tool === 'Write' ? 'Overwrite file' : 'Edit file';
      body = `${c.bold(preview?.file || input.file_path)}\n` + (created
        ? String(input.content ?? input.new_string ?? input.edits?.[0]?.new_string ?? '').split('\n').slice(0, 20).map((l) => c.green('+' + l)).join('\n')
        : renderDiff(preview?.text || '', { max: 40, indent: '' }));
      question = `Do you want to ${created ? 'create' : 'make this edit to'} ${c.bold(path.basename(input.file_path))}?`;
      alwaysLabel = permissions.inProject(path.resolve(root, input.file_path)) ? `Yes, and allow all edits this session ${c.dim('(shift+tab)')}` : 'Yes, and allow edits in that folder this session';
    } else if (tool === 'WebFetch') {
      title = 'Fetch';
      body = input.url;
      try { alwaysLabel = `Yes, and don't ask again for ${c.bold(new URL(input.url).hostname)}`; } catch { alwaysLabel = 'Yes, always'; }
    } else if (['Read', 'Glob', 'Grep', 'LS'].includes(tool)) {
      title = 'Read outside the project';
      body = input.file_path || input.path;
      alwaysLabel = 'Yes, and allow reading that folder this session';
    } else body = JSON.stringify(input, null, 2).slice(0, 2000);

    line(box(title, body, c.orange));
    line(question);
    line(`  ${c.cyan('1.')} Yes`);
    line(`  ${c.cyan('2.')} ${alwaysLabel || 'Yes, always'}`);
    line(`  ${c.cyan('3.')} No, and tell DiCode what to do differently ${c.dim('(esc)')}`);
    let decision = null, feedback = '';
    while (!decision) {
      const a = await prompter.question(c.dim('  › '));
      if (a === null) { decision = 'deny'; agent.abort(); break; }
      const v = a.trim().toLowerCase();
      if (v === '' || v === '1' || v === 'y' || v === 'yes') decision = 'allow';
      else if (v === '2' || v === 'a' || v === 'always') decision = 'always';
      else if (v === '3' || v === 'n' || v === 'no') {
        decision = 'deny';
        feedback = (await prompter.question(c.dim('  What should DiCode do instead? (Enter to just say no) ')))?.trim() || '';
      } else line(c.dim('  Type 1, 2 or 3.'));
    }
    if (agent.running) { interrupt.start(); renderer.start(); }
    return { decision, feedback };
  };

  ui.approvePlan = async (plan) => {
    renderer.pause();
    interrupt.stop();
    const state = { code: false };
    line(box('Ready to code? Here is the plan', plan.split('\n').map((l) => formatLine(l, state)).join('\n'), c.cyan));
    line(`  ${c.cyan('1.')} Yes, and auto-accept edits`);
    line(`  ${c.cyan('2.')} Yes, and approve each edit`);
    line(`  ${c.cyan('3.')} No, keep planning`);
    let r = null;
    while (!r) {
      const a = await prompter.question(c.dim('  › '));
      const v = a?.trim();
      if (a === null) { r = { approved: false, feedback: 'The user pressed Esc.' }; agent.abort(); }
      else if (v === '1' || v === '') r = { approved: true, mode: 'acceptEdits' };
      else if (v === '2') r = { approved: true, mode: 'default' };
      else if (v === '3') r = { approved: false, feedback: (await prompter.question(c.dim('  What should change? '))) || '' };
    }
    if (agent.running) { interrupt.start(); renderer.start(); }
    return r;
  };

  // ---- helpers for commands
  const app = {
    agent, permissions, settings, root, prompter,
    get session() { return session; },
    newSession() { agent.clear(); session = openSession(root); agent.session = session; session.meta({ cwd: root, model: agent.model, startedAt: Date.now() }); },
    resume(id) { agent.clear(); agent.messages = loadSession(root, id).messages; session = openSession(root, id); agent.session = session; },
    async withInterrupt(fn) {
      const ac = new AbortController();
      const stop = watchInterrupt(() => ac.abort());
      renderer.start();
      try { return await fn(ac.signal); } finally { stop(); renderer.pause(); }
    },
  };

  // ---- tab completion for /commands and @files
  prompter.completer = (lineText) => {
    if (/^\/\w*$/.test(lineText)) {
      const hits = commandNames(root).map((n) => '/' + n).filter((n) => n.startsWith(lineText));
      return [hits, lineText];
    }
    const m = /(?:^|\s)@([^\s]*)$/.exec(lineText);
    if (m) {
      const partial = m[1];
      const dir = partial.includes('/') ? partial.slice(0, partial.lastIndexOf('/') + 1) : '';
      let ents = [];
      try { ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch {}
      const hits = ents.filter((e) => !e.name.startsWith('.') || partial.startsWith(dir + '.')).map((e) => '@' + dir + e.name + (e.isDirectory() ? '/' : '')).filter((x) => x.startsWith('@' + partial));
      return [hits, '@' + partial];
    }
    return [[], lineText];
  };
  prompter.onShiftTab = () => {
    const cycle = MODES.slice(0, 3);
    const next = cycle[(cycle.indexOf(permissions.mode) + 1) % cycle.length] || 'default';
    permissions.setMode(next);
    agent.invalidatePrompt();
  };

  /** Expand @file mentions into attached content. */
  function expandMentions(text) {
    const attached = [];
    const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
    let m;
    while ((m = re.exec(text))) {
      const rel = m[1].replace(/\\ /g, ' ').replace(/[.,;:!?)]+$/, '');
      const abs = path.resolve(root, rel);
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        const names = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 200).map((e) => e.name + (e.isDirectory() ? '/' : ''));
        attached.push({ type: 'text', text: `<directory path="${rel}">\n${names.join('\n')}\n</directory>` });
        line(c.dim(`  ⎿  Attached folder listing ${rel}`));
      } else if (IMAGE.test(abs) && st.size < 5e6) {
        attached.push({ type: 'image', source: { type: 'base64', media_type: `image/${path.extname(abs).slice(1).replace('jpg', 'jpeg').toLowerCase()}`, data: fs.readFileSync(abs).toString('base64') } });
        line(c.dim(`  ⎿  Attached image ${rel}`));
      } else if (st.size < 256 * 1024) {
        const body = fs.readFileSync(abs, 'utf8');
        attached.push({ type: 'text', text: `<file path="${rel}">\n${body.split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')}\n</file>` });
        agent.readFiles.set(abs, st.mtimeMs);
        line(c.dim(`  ⎿  Attached ${rel} (${body.split('\n').length} lines)`));
      } else line(c.yellow(`  ⎿  ${rel} is too large to attach; DiCode can Read it in parts.`));
    }
    return attached.length ? [{ type: 'text', text }, ...attached] : text;
  }

  function statusLine() {
    const u = agent.usage;
    const pct = Math.min(100, Math.round((agent.contextTokens / settings.contextWindow) * 100));
    const parts = [agent.model.split('/').pop(), `${pct}% context`, `↑ ${fmtTokens(u.input + u.cacheRead + u.cacheWrite)} ↓ ${fmtTokens(u.output)}`];
    if (u.costKnown && u.calls) parts.push(`$${u.cost.toFixed(3)}`);
    line(c.dim(`  ${parts.join(' · ')}`) + (pct >= 70 ? c.yellow(`  context ${pct}% full: /compact soon`) : ''));
  }

  async function runAgent(content) {
    renderer.start();
    interrupt.start();
    try { await agent.run(content); } finally { interrupt.stop(); renderer.pause(); }
    statusLine();
  }

  async function shell(cmd) {
    const ctx = agent.ctx(new AbortController().signal);
    line(c.dim(`  $ ${cmd}`));
    const ac = new AbortController();
    const stop = watchInterrupt(() => ac.abort());
    let res;
    try { res = await Bash.run({ command: cmd }, { ...ctx, signal: ac.signal }); } catch (e) { res = `Error: ${e.message}`; } finally { stop(); }
    const text = typeof res === 'string' ? res : res.text;
    line(text.split('\n').map((l) => '  ' + l).join('\n'));
    agent.push({ role: 'user', content: `<bash-input>${cmd}</bash-input>\n<bash-output>\n${text.slice(0, 30000)}\n</bash-output>\n(The user ran this command themselves; the output is shared for context.)` });
    agent.push({ role: 'assistant', content: [{ type: 'text', text: '(noted)' }] });
  }

  function remember(note) {
    const file = path.join(root, 'DICODE.md');
    let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# DICODE.md\n';
    if (!/^## Notes\s*$/m.test(body)) body = body.replace(/\s*$/, '\n\n## Notes\n');
    body = body.replace(/\s*$/, '\n') + `- ${note}\n`;
    fs.writeFileSync(file, body);
    agent.invalidatePrompt();
    line(c.dim(`  ⎿  Saved to ${path.relative(root, file)}`));
  }

  // ---- banner
  const g = c.orange;
  line('');
  line(g('╭──────────────────────────────────────────────────────╮'));
  line(`${g('│')} ${g('✻')} ${c.bold('Welcome to DiCode')}`);
  line(`${g('│')}   ${c.dim('/help for commands · shift+tab to change mode · esc to interrupt')}`);
  line(`${g('│')}   ${c.dim('cwd:')} ${root}`);
  line(`${g('│')}   ${c.dim('model:')} ${agent.model}`);
  line(g('╰──────────────────────────────────────────────────────╯'));
  try {
    const p = resolveProvider(settings, parseModelRef(agent.model).provider);
    if (!p.apiKey && p.kind === 'anthropic') line(c.yellow('  No API key found. Run `dicode setup`, or set ANTHROPIC_API_KEY.'));
  } catch (e) { line(c.yellow(`  ${e.message}`)); }
  if (cli.resumeId) line(c.dim(`  Resumed conversation ${cli.resumeId.slice(0, 8)} (${messages.length} messages).`));
  if (!findMemoryFiles(root).some((f) => f.scope === 'project')) line(c.dim('  Tip: run /init to create a DICODE.md with project instructions.'));
  line('');

  // ---- main loop
  let pending = cli.prompt || null;
  for (;;) {
    let text = pending;
    pending = null;
    if (text === null) {
      text = await prompter.prompt(() => `${MODE_TAG[permissions.mode]}${c.bold('>')} `);
      if (text === null) break;
    } else line(`${c.bold('>')} ${text}`);
    const t = text.trim();
    if (!t) continue;
    try {
      if (t.startsWith('/') && !t.startsWith('//')) {
        const name = t.slice(1).split(/\s+/)[0];
        const r = await runCommand(name, t.slice(1 + name.length).trim(), app);
        if (r.exit) break;
        if (r.prompt) await runAgent(r.prompt);
      } else if (t.startsWith('!')) await shell(t.slice(1).trim());
      else if (t.startsWith('#') && !t.startsWith('#!')) remember(t.replace(/^#+\s*/, ''));
      else await runAgent(expandMentions(t));
    } catch (e) {
      renderer.pause();
      line(c.red(`✗ ${e.message}`));
    }
  }
  agent.dispose();
  line(c.dim(`\nBye! Resume this conversation with: dicode --resume ${session.id}`));
  return 0;
}
