import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unifiedDiff } from '../diff.js';
import { truncateMiddle } from '../util.js';

const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export const resolvePath = (ctx, p) => {
  if (!p || typeof p !== 'string') throw new Error('A file path is required');
  return path.resolve(ctx.root, p.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
};
export const relPath = (ctx, abs) => { const r = path.relative(ctx.root, abs); return r.startsWith('..') ? abs : r || '.'; };

function assertFresh(ctx, abs) {
  const seen = ctx.readFiles.get(abs);
  if (seen === undefined) throw new Error(`You must Read ${relPath(ctx, abs)} before modifying it.`);
  const now = fs.statSync(abs).mtimeMs;
  if (now > seen + 1) throw new Error(`${relPath(ctx, abs)} was modified since you last read it (by the user or another process). Read it again before editing.`);
}
const markRead = (ctx, abs) => ctx.readFiles.set(abs, fs.statSync(abs).mtimeMs);

/** Apply one exact-string replacement. Handles CRLF files transparently. */
export function applyEdit(src, oldS, newS, replaceAll = false) {
  if (oldS === newS) throw new Error('old_string and new_string are identical; nothing to change.');
  if (oldS === '') throw new Error('old_string is empty. Use Write to create or overwrite a file.');
  let o = oldS, n = newS;
  if (src.includes('\r\n') && !src.includes(o)) { o = o.replace(/\r?\n/g, '\r\n'); n = n.replace(/\r?\n/g, '\r\n'); }
  const count = src.split(o).length - 1;
  if (!count) throw new Error('old_string was not found in the file. It must match exactly, including whitespace and indentation. Read the file again if unsure.');
  if (count > 1 && !replaceAll) throw new Error(`old_string appears ${count} times. Include more surrounding lines to make it unique, or set replace_all: true.`);
  return { out: replaceAll ? src.split(o).join(n) : src.replace(o, () => n), count: replaceAll ? count : 1, newText: n };
}

function snippet(text, needle) {
  const idx = needle ? text.indexOf(needle) : 0;
  const lines = text.split('\n');
  const startLine = idx >= 0 ? text.slice(0, idx).split('\n').length : 1;
  const span = needle ? needle.split('\n').length : 1;
  const from = Math.max(1, startLine - 3), to = Math.min(lines.length, startLine + span + 2);
  return lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n');
}

function writeFileKeepingMode(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export const Read = {
  name: 'Read',
  description: 'Read a file from the filesystem. Returns lines prefixed with line numbers (cat -n format). Reads up to 2000 lines by default; use offset/limit for large files. Images (png, jpg, gif, webp) are returned visually. Read a file before editing it.',
  input_schema: { type: 'object', properties: { file_path: { type: 'string', description: 'Path (absolute, or relative to the project root)' }, offset: { type: 'integer', description: '1-based line to start from' }, limit: { type: 'integer', description: 'Number of lines to read' } }, required: ['file_path'] },
  readOnly: true, concurrencySafe: true,
  summary: (i) => i.file_path + (i.offset ? `:${i.offset}` : ''),
  async run({ file_path, offset = 1, limit = 2000 }, ctx) {
    const abs = resolvePath(ctx, file_path);
    let st;
    try { st = fs.statSync(abs); } catch { throw new Error(`File does not exist: ${file_path}`); }
    if (st.isDirectory()) throw new Error(`${file_path} is a directory. Use LS or Glob.`);
    const ext = path.extname(abs).toLowerCase();
    if (IMAGE[ext]) {
      if (st.size > 5 * 1024 * 1024) throw new Error('Image is larger than 5 MB.');
      markRead(ctx, abs);
      return { text: `Image ${relPath(ctx, abs)} (${st.size} bytes)`, image: { mediaType: IMAGE[ext], data: fs.readFileSync(abs).toString('base64') } };
    }
    if (st.size > 50 * 1024 * 1024) throw new Error('File is larger than 50 MB; use Grep or Bash (head/tail) instead.');
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`${file_path} looks like a binary file.`);
    markRead(ctx, abs);
    const text = buf.toString('utf8');
    if (!text) return '(file is empty)';
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + limit);
    let out = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + '… [line truncated]' : l}`).join('\n');
    const end = start - 1 + slice.length;
    if (end < lines.length) out += `\n… (${lines.length - end} more lines; continue with offset=${end + 1})`;
    if (start > lines.length) out = `(file has only ${lines.length} lines)`;
    return truncateMiddle(out, 120000);
  },
};

export const Write = {
  name: 'Write',
  description: 'Create a new file or completely overwrite an existing one. Prefer Edit for changes to existing files. If the file exists you must Read it first.',
  input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] },
  summary: (i) => i.file_path,
  preview(input, ctx) {
    const abs = resolvePath(ctx, input.file_path);
    const exists = fs.existsSync(abs);
    if (exists) assertFresh(ctx, abs);
    const old = exists ? fs.readFileSync(abs, 'utf8') : '';
    return { kind: 'diff', file: relPath(ctx, abs), created: !exists, ...unifiedDiff(old, String(input.content ?? ''), { file: relPath(ctx, abs) }) };
  },
  async run({ file_path, content }, ctx) {
    const abs = resolvePath(ctx, file_path);
    const exists = fs.existsSync(abs);
    if (exists) assertFresh(ctx, abs);
    const before = exists ? fs.readFileSync(abs, 'utf8') : '';
    ctx.checkpoints.snapshot(abs);
    writeFileKeepingMode(abs, String(content ?? ''));
    markRead(ctx, abs);
    ctx.emit?.({ type: 'file_change', file: relPath(ctx, abs), created: !exists, ...unifiedDiff(before, String(content ?? ''), { file: relPath(ctx, abs) }) });
    const n = String(content ?? '').split('\n').length;
    return `${exists ? 'Updated' : 'Created'} ${relPath(ctx, abs)} (${n} lines).`;
  },
};

export const Edit = {
  name: 'Edit',
  description: 'Replace an exact string in a file. old_string must match the file exactly (whitespace and indentation included, without the line-number prefix from Read) and be unique unless replace_all is true. To create a new file, use an empty old_string on a path that does not exist. You must Read the file first.',
  input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] },
  summary: (i) => i.file_path,
  compute(input, ctx) {
    const abs = resolvePath(ctx, input.file_path);
    if (!fs.existsSync(abs)) {
      if (input.old_string === '') return { abs, src: '', out: input.new_string, created: true, newText: input.new_string };
      throw new Error(`File does not exist: ${input.file_path}`);
    }
    assertFresh(ctx, abs);
    const src = fs.readFileSync(abs, 'utf8');
    return { abs, src, ...applyEdit(src, input.old_string, input.new_string, input.replace_all) };
  },
  preview(input, ctx) {
    const c = this.compute(input, ctx);
    return { kind: 'diff', file: relPath(ctx, c.abs), created: !!c.created, ...unifiedDiff(c.src, c.out, { file: relPath(ctx, c.abs) }) };
  },
  async run(input, ctx) {
    const c = this.compute(input, ctx);
    ctx.checkpoints.snapshot(c.abs);
    writeFileKeepingMode(c.abs, c.out);
    markRead(ctx, c.abs);
    ctx.emit?.({ type: 'file_change', file: relPath(ctx, c.abs), created: !!c.created, ...unifiedDiff(c.src, c.out, { file: relPath(ctx, c.abs) }) });
    if (c.created) return `Created ${relPath(ctx, c.abs)}.`;
    return `Edited ${relPath(ctx, c.abs)}${c.count > 1 ? ` (${c.count} replacements)` : ''}. Snippet of the result:\n${snippet(c.out, c.newText)}`;
  },
};

export const MultiEdit = {
  name: 'MultiEdit',
  description: 'Make several exact-string edits to one file in a single atomic operation. Edits apply in order, each to the result of the previous one. Either all succeed or none are applied. Same matching rules as Edit.',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] } } },
    required: ['file_path', 'edits'],
  },
  summary: (i) => `${i.file_path} (${i.edits?.length || 0} edits)`,
  compute(input, ctx) {
    const abs = resolvePath(ctx, input.file_path);
    if (!Array.isArray(input.edits) || !input.edits.length) throw new Error('edits must be a non-empty array');
    const exists = fs.existsSync(abs);
    if (exists) assertFresh(ctx, abs);
    else if (input.edits[0].old_string !== '') throw new Error(`File does not exist: ${input.file_path}`);
    const src = exists ? fs.readFileSync(abs, 'utf8') : '';
    let cur = src;
    input.edits.forEach((e, i) => {
      if (!exists && i === 0) { cur = e.new_string; return; }
      try { cur = applyEdit(cur, e.old_string, e.new_string, e.replace_all).out; } catch (err) { throw new Error(`Edit ${i + 1} of ${input.edits.length} failed (no changes applied): ${err.message}`); }
    });
    return { abs, src, out: cur, created: !exists };
  },
  preview(input, ctx) {
    const c = this.compute(input, ctx);
    return { kind: 'diff', file: relPath(ctx, c.abs), created: c.created, ...unifiedDiff(c.src, c.out, { file: relPath(ctx, c.abs) }) };
  },
  async run(input, ctx) {
    const c = this.compute(input, ctx);
    ctx.checkpoints.snapshot(c.abs);
    writeFileKeepingMode(c.abs, c.out);
    markRead(ctx, c.abs);
    ctx.emit?.({ type: 'file_change', file: relPath(ctx, c.abs), created: c.created, ...unifiedDiff(c.src, c.out, { file: relPath(ctx, c.abs) }) });
    return `Applied ${input.edits.length} edits to ${relPath(ctx, c.abs)}.`;
  },
};

export const LS = {
  name: 'LS',
  description: 'List a directory (one level). Directories end with "/". Prefer Glob/Grep for searching.',
  input_schema: { type: 'object', properties: { path: { type: 'string' }, ignore: { type: 'array', items: { type: 'string' } } } },
  readOnly: true, concurrencySafe: true,
  summary: (i) => i.path || '.',
  async run({ path: p = '.', ignore = [] }, ctx) {
    const abs = resolvePath(ctx, p);
    const { matchGlob } = await import('../glob.js');
    let entries = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => !ignore.some((g) => matchGlob(g, e.name)));
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    const total = entries.length;
    entries = entries.slice(0, 1000);
    const lines = entries.map((e) => {
      if (e.isDirectory()) return `${e.name}/`;
      let size = ''; try { size = ` (${fs.statSync(path.join(abs, e.name)).size} B)`; } catch {}
      return e.name + size;
    });
    return `${relPath(ctx, abs)}/\n${lines.map((l) => '  ' + l).join('\n') || '  (empty)'}${total > 1000 ? `\n  … ${total - 1000} more` : ''}`;
  },
};

// ---- file listing shared by Glob and the Grep fallback ----
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.turbo']);

export function listFiles(root, base = root, limit = 100000) {
  const inGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: base, encoding: 'utf8' }).stdout?.trim() === 'true';
  if (inGit) {
    const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '.'], { cwd: base, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status === 0) {
      return r.stdout.split('\0').filter(Boolean).map((f) => path.join(base, f)).filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }).slice(0, limit);
    }
  }
  const out = [];
  const walk = (d) => {
    if (out.length >= limit) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= limit) return;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(d, e.name)); }
      else if (e.isFile()) out.push(path.join(d, e.name));
    }
  };
  walk(base);
  return out;
}
