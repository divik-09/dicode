import path from 'node:path';
import { matchGlob } from './glob.js';
import { realpathLoose, within } from './util.js';
import { localSettingsPath, updateSettingsFile, ensureLocalIgnored } from './config.js';

export const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
export const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const ALWAYS_ALLOWED = new Set(['TodoWrite', 'BashOutput', 'KillShell', 'Task', 'ExitPlanMode', 'WebSearch']);

export function parseRule(rule) {
  const m = /^\s*(\w+)\s*(?:\((.*)\))?\s*$/.exec(rule);
  return m ? { tool: m[1], spec: m[2]?.trim() } : null;
}

// ---- Bash analysis -------------------------------------------------------------------------------
const UNSAFE = /(\$\(|`|>|<\(|\n)/; // command substitution, redirection, process substitution, multi-line
/** Split a command on && || ; | into segments. Conservative: odd quoting just yields more prompts. */
export function splitCommand(cmd) {
  // Harmless redirections (merge stderr, discard to /dev/null) do not make a command unsafe.
  const c = cmd.replace(/\s*\d?>&\d\b/g, '').replace(/\s*\d?>>?\s*\/dev\/null\b/g, '');
  return { segments: c.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean), unsafe: UNSAFE.test(c) };
}

const SAFE_BINS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'which', 'echo', 'tree', 'file', 'stat',
  'du', 'df', 'date', 'whoami', 'uname', 'basename', 'dirname', 'realpath', 'uniq', 'cut', 'diff', 'type', 'true', 'nl', 'tr', 'sort', 'find']);
const GIT_SAFE = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep']);

function isSafeSegment(seg) {
  const t = seg.split(/\s+/);
  const bin = path.basename(t[0]);
  const args = t.slice(1);
  if (bin === 'git') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (args.some((a) => /^--output|^--ext-diff/.test(a))) return false;
    if (GIT_SAFE.has(sub)) return true;
    const rest = args.slice(args.indexOf(sub) + 1);
    if (sub === 'branch') return rest.every((a) => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes'].includes(a));
    if (sub === 'remote') return rest.every((a) => a === '-v');
    if (sub === 'tag') return rest.every((a) => ['-l', '--list'].includes(a));
    return false;
  }
  if (!SAFE_BINS.has(bin)) return false;
  if (bin === 'find' && args.some((a) => /^-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)$/.test(a))) return false;
  if (bin === 'sort' && args.some((a) => a === '-o' || a.startsWith('--output'))) return false;
  return true;
}

export function isReadOnlyCommand(cmd) {
  const { segments, unsafe } = splitCommand(cmd);
  return !unsafe && segments.length > 0 && segments.every(isSafeSegment);
}

function matchBashSpec(spec, cmd) {
  if (spec === undefined || spec === '*') return true;
  const one = (seg) => {
    if (spec.endsWith(':*')) { const p = spec.slice(0, -2).trim(); return seg === p || seg.startsWith(p + ' '); }
    if (spec.includes('*')) return new RegExp('^' + spec.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(seg);
    return seg === spec;
  };
  return one;
}

/** Suggest a reusable rule for "don't ask again", e.g. `npm run test -- -x` -> `Bash(npm run test:*)`. */
export function suggestBashRule(cmd) {
  const first = splitCommand(cmd).segments[0] || cmd;
  const t = first.split(/\s+/);
  const n = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'go', 'python', 'python3', 'pip', 'make', 'docker', 'git', 'uv', 'poetry', 'dotnet', 'mvn', 'gradle'].includes(t[0])
    ? (['run', 'exec', 'x'].includes(t[1]) ? 3 : 2) : 1;
  return `Bash(${t.slice(0, n).join(' ')}:*)`;
}

// ---- Engine --------------------------------------------------------------------------------------
export function createPermissions({ settings, root, mode, headless = false }) {
  const rootReal = realpathLoose(root);
  const extraDirs = (settings.permissions.additionalDirectories || []).map((d) => realpathLoose(path.resolve(root, d)));
  const session = { allow: [] }; // rules granted for this session only
  const state = { mode: mode || settings.permissions.defaultMode || 'default' };
  if (!MODES.includes(state.mode)) throw new Error(`Unknown permission mode "${state.mode}". Use one of: ${MODES.join(', ')}`);

  const inProject = (abs) => { const r = realpathLoose(abs); return within(r, rootReal) || extraDirs.some((d) => within(r, d)); };
  const targetPath = (input) => path.resolve(root, input.file_path || input.path || '.');
  const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');

  function ruleMatches(rule, tool, input, { allSegments }) {
    const r = typeof rule === 'string' ? parseRule(rule) : rule;
    if (!r) return false;
    const family = r.tool === tool || (r.tool === 'Edit' && EDIT_TOOLS.has(tool)) || (r.tool === 'Read' && READ_TOOLS.has(tool));
    if (!family) return false;
    if (r.spec === undefined || r.spec === '' || r.spec === '*') return true;
    if (tool === 'Bash') {
      const { segments, unsafe } = splitCommand(input.command || '');
      const one = matchBashSpec(r.spec, input.command);
      if (allSegments) return !unsafe && segments.length > 0 && segments.every(one); // allow: every part must match
      return segments.some(one) || one(input.command.trim()); // deny: any part matching is enough
    }
    if (tool === 'WebFetch') {
      try { return r.spec === `domain:${new URL(input.url).hostname}`; } catch { return false; }
    }
    const abs = targetPath(input);
    const spec = r.spec.startsWith('/') ? r.spec : r.spec.replace(/^\.\//, '');
    return r.spec.startsWith('/') ? matchGlob(spec.slice(1), abs.slice(1)) : matchGlob(spec, rel(abs));
  }

  const anyMatch = (rules, tool, input, opts) => rules.find((r) => ruleMatches(r, tool, input, opts));

  /** Bash allow: every segment of a compound command must be covered by some allow rule or be read-only. */
  function allowedByRules(tool, input) {
    const rules = [...settings.permissions.allow, ...session.allow];
    if (tool !== 'Bash') return !!anyMatch(rules, tool, input, { allSegments: true });
    if (rules.some((r) => { const x = parseRule(r); return x?.tool === 'Bash' && (x.spec === undefined || x.spec === '' || x.spec === '*'); })) return true;
    const { segments, unsafe } = splitCommand(input.command || '');
    if (unsafe || !segments.length) return false;
    const covered = (seg) => rules.some((r) => ruleMatches(r, 'Bash', { command: seg }, { allSegments: true }));
    return segments.some(covered) && segments.every((seg) => covered(seg) || isSafeSegment(seg));
  }

  /** Decide: { behavior: allow|deny|ask, reason } */
  function check(tool, input) {
    const p = settings.permissions;
    const denied = anyMatch(p.deny, tool, input, { allSegments: false });
    if (denied) return { behavior: 'deny', reason: `blocked by deny rule ${denied}` };
    if (state.mode === 'bypassPermissions') return { behavior: 'allow', reason: 'bypass mode' };
    if (state.mode === 'plan' && !(READ_TOOLS.has(tool) || ALWAYS_ALLOWED.has(tool) || tool === 'WebFetch' || (tool === 'Bash' && isReadOnlyCommand(input.command || '')))) {
      return { behavior: 'deny', reason: 'plan mode is read-only. Present your plan with ExitPlanMode first.' };
    }
    if (anyMatch(p.ask, tool, input, { allSegments: false })) return { behavior: 'ask', reason: 'ask rule' };
    if (allowedByRules(tool, input)) return { behavior: 'allow', reason: 'allow rule' };
    if (ALWAYS_ALLOWED.has(tool)) return { behavior: 'allow', reason: 'safe tool' };
    if (READ_TOOLS.has(tool)) return inProject(targetPath(input)) ? { behavior: 'allow', reason: 'read inside project' } : { behavior: 'ask', reason: 'reads outside the project' };
    if (EDIT_TOOLS.has(tool)) {
      if (!inProject(targetPath(input))) return { behavior: 'ask', reason: 'writes outside the project' };
      return state.mode === 'acceptEdits' ? { behavior: 'allow', reason: 'accept-edits mode' } : { behavior: 'ask', reason: 'file edit' };
    }
    if (tool === 'Bash') return isReadOnlyCommand(input.command || '') ? { behavior: 'allow', reason: 'read-only command' } : { behavior: 'ask', reason: 'shell command' };
    return { behavior: 'ask', reason: 'tool needs approval' };
  }

  /** Remember an approval. Bash/WebFetch rules persist to .dicode/settings.local.json; edits switch the session to accept-edits. */
  function always(tool, input) {
    if (EDIT_TOOLS.has(tool)) {
      if (inProject(targetPath(input))) { state.mode = 'acceptEdits'; return 'accept edits for this session'; }
      const dir = path.dirname(targetPath(input));
      session.allow.push(`${tool === 'Write' ? 'Write' : 'Edit'}(/${dir.slice(1)}/**)`);
      return `allow edits in ${dir} for this session`;
    }
    if (READ_TOOLS.has(tool)) {
      const dir = path.dirname(targetPath(input));
      session.allow.push(`Read(/${dir.slice(1)}/**)`);
      return `allow reading ${dir} for this session`;
    }
    const rule = tool === 'Bash' ? suggestBashRule(input.command) : tool === 'WebFetch' ? `WebFetch(domain:${new URL(input.url).hostname})` : tool;
    addRule(rule);
    return `saved rule ${rule}`;
  }

  function addRule(rule, list = 'allow') {
    settings.permissions[list] = [...new Set([...settings.permissions[list], rule])];
    if (!headless) {
      ensureLocalIgnored(root);
      updateSettingsFile(localSettingsPath(root), (cur) => {
        cur.permissions = cur.permissions || {};
        cur.permissions[list] = [...new Set([...(cur.permissions[list] || []), rule])];
        return cur;
      });
    }
  }

  return {
    check, always, addRule, inProject,
    get mode() { return state.mode; },
    setMode(m) { if (!MODES.includes(m)) throw new Error(`Unknown mode ${m}`); state.mode = m; },
    rules: () => ({ allow: [...settings.permissions.allow, ...session.allow], ask: settings.permissions.ask, deny: settings.permissions.deny }),
  };
}
