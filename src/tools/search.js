import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { matchGlob } from '../glob.js';
import { which, truncateMiddle } from '../util.js';
import { listFiles, resolvePath, relPath } from './files.js';

export const Glob = {
  name: 'Glob',
  description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.test.js", "*.md"). Patterns without "/" match at any depth. Respects .gitignore. Results are sorted by modification time, newest first.',
  input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory to search (default: project root)' } }, required: ['pattern'] },
  readOnly: true, concurrencySafe: true,
  summary: (i) => i.pattern + (i.path ? ` in ${i.path}` : ''),
  async run({ pattern, path: p }, ctx) {
    const base = p ? resolvePath(ctx, p) : ctx.root;
    const hits = listFiles(ctx.root, base).filter((f) => matchGlob(pattern, path.relative(base, f)));
    const withTime = hits.slice(0, 2000).map((f) => { let t = 0; try { t = fs.statSync(f).mtimeMs; } catch {} return [f, t]; }).sort((a, b) => b[1] - a[1]);
    if (!withTime.length) return 'No files found.';
    const shown = withTime.slice(0, 200).map(([f]) => relPath(ctx, f));
    return shown.join('\n') + (hits.length > 200 ? `\n… ${hits.length - 200} more (narrow the pattern)` : '');
  },
};

const TYPES = { js: ['js', 'mjs', 'cjs', 'jsx'], ts: ['ts', 'tsx', 'mts', 'cts'], py: ['py'], go: ['go'], rust: ['rs'], java: ['java'], rb: ['rb'], php: ['php'],
  c: ['c', 'h'], cpp: ['cpp', 'cc', 'hpp', 'hh', 'cxx'], cs: ['cs'], swift: ['swift'], kt: ['kt'], md: ['md'], json: ['json'], yaml: ['yml', 'yaml'], css: ['css', 'scss'], html: ['html', 'htm'], sh: ['sh', 'bash'] };

function rgArgs(i) {
  const a = ['--no-heading', '--color', 'never', '--max-columns', '400', '--max-columns-preview'];
  const mode = i.output_mode || 'files_with_matches';
  if (mode === 'files_with_matches') a.push('-l');
  else if (mode === 'count') a.push('-c');
  else { a.push('-n'); for (const k of ['-A', '-B', '-C']) if (i[k] != null) a.push(k, String(i[k])); }
  if (i['-i']) a.push('-i');
  if (i.multiline) a.push('-U', '--multiline-dotall');
  if (i.glob) a.push('--glob', i.glob);
  if (i.type) a.push('--type', i.type);
  a.push('-e', i.pattern);
  return a;
}

function jsGrep(i, ctx, base) {
  const flags = (i['-i'] ? 'i' : '') + (i.multiline ? 's' : '');
  const re = new RegExp(i.pattern, flags);
  const mode = i.output_mode || 'files_with_matches';
  const exts = i.type ? TYPES[i.type] || [i.type] : null;
  const before = i['-B'] ?? i['-C'] ?? 0, after = i['-A'] ?? i['-C'] ?? 0;
  const out = [];
  const files = fs.statSync(base).isFile() ? [base] : listFiles(ctx.root, base);
  for (const f of files) {
    const rel = relPath(ctx, f);
    if (i.glob && !matchGlob(i.glob, path.relative(base, f) || path.basename(f))) continue;
    if (exts && !exts.includes(path.extname(f).slice(1))) continue;
    let text; try { const b = fs.readFileSync(f); if (b.length > 5e6 || b.subarray(0, 4000).includes(0)) continue; text = b.toString('utf8'); } catch { continue; }
    if (i.multiline) { if (re.test(text)) out.push(mode === 'count' ? `${rel}:1` : rel); continue; }
    const lines = text.split('\n');
    const hit = lines.map((l, n) => (re.test(l) ? n : -1)).filter((n) => n >= 0);
    if (!hit.length) continue;
    if (mode === 'files_with_matches') out.push(rel);
    else if (mode === 'count') out.push(`${rel}:${hit.length}`);
    else {
      const show = new Set();
      for (const n of hit) for (let k = Math.max(0, n - before); k <= Math.min(lines.length - 1, n + after); k++) show.add(k);
      let prev = -2;
      for (const k of [...show].sort((x, y) => x - y)) {
        if (prev >= 0 && k > prev + 1) out.push('--');
        const sep = hit.includes(k) ? ':' : '-';
        out.push(`${rel}${sep}${k + 1}${sep}${lines[k].slice(0, 400)}`);
        prev = k;
      }
    }
  }
  return out;
}

export const Grep = {
  name: 'Grep',
  description: 'Search file contents with a regular expression (ripgrep syntax). output_mode: "files_with_matches" (default), "content" (matching lines with line numbers; supports -A/-B/-C context), or "count". Filter with glob (e.g. "*.ts") or type (js, ts, py, go, rust, …). Respects .gitignore.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, type: { type: 'string' },
      output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
      '-i': { type: 'boolean' }, '-A': { type: 'integer' }, '-B': { type: 'integer' }, '-C': { type: 'integer' },
      multiline: { type: 'boolean' }, head_limit: { type: 'integer', description: 'Max result lines (default 250)' },
    },
    required: ['pattern'],
  },
  readOnly: true, concurrencySafe: true,
  summary: (i) => `"${i.pattern}"${i.glob ? ` ${i.glob}` : ''}${i.path ? ` in ${i.path}` : ''}`,
  async run(i, ctx) {
    const base = i.path ? resolvePath(ctx, i.path) : ctx.root;
    const limit = i.head_limit || 250;
    let lines;
    const rg = ctx.forceJsGrep ? null : which('rg');
    if (rg) {
      lines = await new Promise((resolve, reject) => {
        execFile(rg, [...rgArgs(i), base], { cwd: ctx.root, maxBuffer: 50 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
          if (err && err.code !== 1) return reject(new Error(stderr.trim() || err.message));
          resolve(stdout.split('\n').filter(Boolean).map((l) => (l.startsWith(ctx.root + path.sep) ? l.slice(ctx.root.length + 1) : l)));
        });
      });
    } else {
      try { lines = jsGrep(i, ctx, base); } catch (e) { throw new Error(`Invalid pattern: ${e.message}`); }
    }
    if (!lines.length) return 'No matches found.';
    const out = lines.slice(0, limit).join('\n');
    return truncateMiddle(out, 60000) + (lines.length > limit ? `\n… ${lines.length - limit} more results (raise head_limit or narrow the search)` : '');
  },
};
