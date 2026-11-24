import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { homeDir, userSettingsPath, projectSettingsPath, localSettingsPath } from './config.js';
import { parseModelRef } from './providers/index.js';
import { MODES } from './permissions.js';
import { findMemoryFiles, gitInfo } from './prompt.js';
import { listSessions, loadSession } from './session.js';
import { fmtTokens } from './util.js';
import { c, line, renderDiff } from './ui/term.js';
import { renderTodos } from './ui/render.js';

export const INIT_PROMPT = `Analyze this codebase and create a DICODE.md file at the repository root (or improve it if one exists). It will be given to future coding sessions, so include:
1. Commands: how to install, build, lint, type-check and test, including how to run a single test.
2. Architecture: the big picture that takes reading several files to understand (main modules, data flow, entry points).
3. Conventions: code style, naming, error handling, testing patterns, anything non-obvious.
Read README, package manifests, CI config, and any existing AGENTS.md, CLAUDE.md, .cursorrules or .github/copilot-instructions.md first, and carry over their important parts.
Be concise (aim for under 100 lines). Don't list every file, and don't include generic advice. Start the file with "# DICODE.md".`;

const BUILTIN = [
  ['help', 'Show commands and shortcuts'],
  ['clear', 'Start a fresh conversation'],
  ['compact', 'Summarise the conversation to free context. Optional: focus instructions'],
  ['undo', 'Revert the file changes from the last turn'],
  ['diff', 'Show uncommitted changes (git diff)'],
  ['model', 'Show or switch the model, e.g. /model anthropic/claude-opus-5-5'],
  ['mode', 'Switch permission mode: default | acceptEdits | plan | bypassPermissions'],
  ['permissions', 'Show rules. /permissions allow|ask|deny <rule> to add one'],
  ['cost', 'Token usage and cost for this session'],
  ['status', 'Model, mode, session, git and settings overview'],
  ['init', 'Analyse the codebase and write DICODE.md'],
  ['memory', 'Show instruction files. /memory edit opens DICODE.md in $EDITOR'],
  ['todos', 'Show the current todo list'],
  ['resume', 'Resume an earlier conversation in this project'],
  ['bashes', 'List background shells'],
  ['exit', 'Quit DiCode'],
];

function customCommands(root) {
  const out = new Map();
  for (const [scope, dir] of [['user', path.join(homeDir(), 'commands')], ['project', path.join(root, '.dicode', 'commands')]]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
      const desc = fm ? /description:\s*(.+)/.exec(fm[1])?.[1] : body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '');
      out.set(f.replace(/\.md$/, ''), { scope, description: (desc || '').slice(0, 70), template: fm ? body.slice(fm[0].length) : body });
    }
  }
  return out;
}

export function commandNames(root) { return [...BUILTIN.map(([n]) => n), ...customCommands(root).keys()]; }

/** Returns { prompt } to send to the agent, { exit: true }, or {} when fully handled. */
export async function runCommand(name, args, app) {
  const { agent, permissions, settings, root } = app;
  switch (name) {
    case 'help': case '?': {
      line(c.bold('\nCommands'));
      for (const [n, d] of BUILTIN) line(`  ${c.cyan('/' + n.padEnd(12))} ${c.dim(d)}`);
      const custom = customCommands(root);
      if (custom.size) { line(c.bold('\nCustom commands')); for (const [n, x] of custom) line(`  ${c.cyan('/' + n.padEnd(12))} ${c.dim(`${x.description} (${x.scope})`)}`); }
      line(c.bold('\nShortcuts'));
      line(`  ${c.cyan('Shift+Tab'.padEnd(13))} ${c.dim('cycle mode: default → accept edits → plan')}`);
      line(`  ${c.cyan('Esc / Ctrl+C'.padEnd(13))} ${c.dim('interrupt DiCode while it works')}`);
      line(`  ${c.cyan('@path'.padEnd(13))} ${c.dim('attach a file or folder to your message (Tab completes)')}`);
      line(`  ${c.cyan('!command'.padEnd(13))} ${c.dim('run a shell command yourself; output is shared with DiCode')}`);
      line(`  ${c.cyan('#note'.padEnd(13))} ${c.dim('save a note to DICODE.md (project memory)')}`);
      line(`  ${c.cyan('line\\'.padEnd(13))} ${c.dim('end a line with \\ for multi-line input (pasting also works)')}\n`);
      return {};
    }
    case 'exit': case 'quit': return { exit: true };
    case 'clear': case 'new': app.newSession(); line(c.dim('  ⎿  Started a fresh conversation.')); return {};
    case 'compact': {
      if (agent.messages.length < 2) { line(c.dim('  ⎿  Nothing to compact yet.')); return {}; }
      try { await app.withInterrupt((signal) => agent.compact(args || null, { signal })); } catch (e) { line(c.red(`  ⎿  Compaction failed: ${e.message}`)); }
      return {};
    }
    case 'undo': {
      const r = agent.checkpoints.undo();
      if (!r) { line(c.dim('  ⎿  Nothing to undo. (Shell commands cannot be undone.)')); return {}; }
      line(`  ${c.dim('⎿')}  Reverted changes from: ${c.italic(r.label || 'last turn')}`);
      for (const f of r.files) { line(c.dim(`     ${f.action} ${path.relative(root, f.file)}`)); agent.readFiles.delete(f.file); }
      agent.push({ role: 'user', content: `[DiCode note: the user reverted your file changes from the previous turn (${r.files.map((f) => path.relative(root, f.file)).join(', ')}). Read files again before editing them.]` });
      agent.push({ role: 'assistant', content: [{ type: 'text', text: 'Noted, those changes were reverted.' }] });
      return {};
    }
    case 'diff': {
      const stat = spawnSync('git', ['diff', '--stat'], { cwd: root, encoding: 'utf8' });
      if (stat.status !== 0) { line(c.dim('  ⎿  Not a git repository.')); return {}; }
      const d = spawnSync('git', ['diff'], { cwd: root, encoding: 'utf8', maxBuffer: 20e6 }).stdout;
      line(stat.stdout.trim() ? stat.stdout.trimEnd() : c.dim('  No uncommitted changes to tracked files.'));
      if (d) line(renderDiff(d, { max: 80, indent: '  ' }));
      return {};
    }
    case 'model': {
      if (!args) { line(`  Model: ${c.bold(agent.model)}${settings.fallbackModels?.length ? c.dim(`  (fallbacks: ${settings.fallbackModels.join(', ')})`) : ''}`); return {}; }
      try { parseModelRef(args); } catch (e) { line(c.red(`  ${e.message}`)); return {}; }
      agent.model = args; agent.invalidatePrompt();
      line(c.dim(`  ⎿  Model set to ${args} for this session.`));
      return {};
    }
    case 'mode': {
      const m = args || MODES[(MODES.indexOf(permissions.mode) + 1) % 3];
      const resolved = MODES.find((x) => x.toLowerCase() === m.toLowerCase() || x.toLowerCase().startsWith(m.toLowerCase()));
      if (!resolved) { line(c.red(`  Unknown mode. Use one of: ${MODES.join(', ')}`)); return {}; }
      permissions.setMode(resolved); agent.invalidatePrompt();
      line(c.dim(`  ⎿  Mode: ${resolved}`));
      return {};
    }
    case 'permissions': {
      const [verb, ...rest] = (args || '').split(/\s+/);
      if (['allow', 'ask', 'deny'].includes(verb) && rest.length) { permissions.addRule(rest.join(' '), verb); line(c.dim(`  ⎿  Added ${verb} rule ${rest.join(' ')} (saved to .dicode/settings.local.json)`)); return {}; }
      const r = permissions.rules();
      line(`  Mode: ${c.bold(permissions.mode)}`);
      for (const k of ['allow', 'ask', 'deny']) line(`  ${k.padEnd(6)} ${r[k].length ? r[k].join(', ') : c.dim('(none)')}`);
      line(c.dim('  Rules look like Bash(npm test:*), Edit(src/**), Read(.env), WebFetch(domain:example.com).'));
      return {};
    }
    case 'cost': case 'usage': {
      const u = agent.usage;
      line(`  Input:  ${fmtTokens(u.input)} tokens  ${c.dim(`(+ ${fmtTokens(u.cacheRead)} cache reads, ${fmtTokens(u.cacheWrite)} cache writes)`)}`);
      line(`  Output: ${fmtTokens(u.output)} tokens · ${u.calls} model calls`);
      line(`  Cost:   ${u.costKnown && u.calls ? `$${u.cost.toFixed(4)}` : c.dim('unknown (add prices under "pricing" in settings to track cost)')}`);
      line(`  Context: ~${fmtTokens(agent.contextTokens)} tokens`);
      return {};
    }
    case 'status': {
      const g = gitInfo(root);
      line(`  Model       ${agent.model}`);
      line(`  Mode        ${permissions.mode}`);
      line(`  Directory   ${root}${settings._trusted ? '' : c.yellow('  (untrusted: project hooks/allow-rules ignored)')}`);
      line(`  Git         ${g ? `${g.branch}` : 'not a repository'}`);
      line(`  Session     ${app.session.id}`);
      line(`  Memory      ${findMemoryFiles(root).map((m) => path.relative(root, m.file) || m.file).join(', ') || c.dim('none (try /init)')}`);
      line(`  Settings    ${[userSettingsPath(), projectSettingsPath(root), localSettingsPath(root)].filter((f) => fs.existsSync(f)).join(', ') || c.dim('defaults')}`);
      return {};
    }
    case 'init': return { prompt: INIT_PROMPT };
    case 'memory': {
      const files = findMemoryFiles(root);
      if (args === 'edit') {
        const target = path.join(root, 'DICODE.md');
        if (!fs.existsSync(target)) fs.writeFileSync(target, '# DICODE.md\n\n');
        const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
        spawnSync(editor, [target], { stdio: 'inherit' });
        agent.invalidatePrompt();
        return {};
      }
      if (!files.length) line(c.dim('  No instruction files yet. Run /init, or start a message with # to save a note.'));
      for (const f of files) line(`  ${c.bold(f.scope.padEnd(8))} ${f.file}`);
      return {};
    }
    case 'todos': line(agent.todos.length ? renderTodos(agent.todos) : c.dim('  No todos.')); return {};
    case 'bashes': {
      if (!agent.background.size) { line(c.dim('  No background shells.')); return {}; }
      for (const j of agent.background.values()) line(`  ${c.bold(j.id)}  ${j.exitCode === null ? c.green('running') : c.dim(`exited ${j.exitCode}`)}  ${j.command}`);
      return {};
    }
    case 'resume': {
      const list = listSessions(root).filter((s) => s.id !== app.session.id).slice(0, 15);
      if (!list.length) { line(c.dim('  No earlier conversations in this project.')); return {}; }
      list.forEach((s, i) => line(`  ${c.cyan(String(i + 1).padStart(2))}. ${new Date(s.updatedAt).toLocaleString()}  ${c.dim(`${s.messages} msgs`)}  ${s.preview}`));
      const pick = args ? Number(args) : Number(await app.prompter.question(c.dim('  Resume which? (number, Enter to cancel) ')));
      const chosen = list[pick - 1];
      if (!chosen) return {};
      app.resume(chosen.id);
      line(c.dim(`  ⎿  Resumed conversation ${chosen.id.slice(0, 8)} (${loadSession(root, chosen.id).messages.length} messages).`));
      return {};
    }
    default: {
      const custom = customCommands(root).get(name);
      if (custom) return { prompt: custom.template.includes('$ARGUMENTS') ? custom.template.replaceAll('$ARGUMENTS', args) : `${custom.template}${args ? `\n\n${args}` : ''}` };
      line(c.red(`  Unknown command /${name}. Type /help.`));
      return {};
    }
  }
}
