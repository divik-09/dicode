import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const shortId = () => crypto.randomBytes(4).toString('hex');
export const uuid = () => crypto.randomUUID();
export const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function deepMerge(base, over) {
  if (over === undefined) return base;
  if (!isObject(base) || !isObject(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

const BAD = new Set(['__proto__', 'constructor', 'prototype']);
export const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
export function setPath(o, p, v) {
  const ks = p.split('.');
  if (ks.some((k) => BAD.has(k))) throw new Error('Invalid settings path');
  let cur = o;
  for (const k of ks.slice(0, -1)) { if (!isObject(cur[k])) cur[k] = {}; cur = cur[k]; }
  cur[ks.at(-1)] = v;
  return o;
}
export const parseValue = (s) => { try { return JSON.parse(s); } catch { return s; } };

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

export function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, bin);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

/** Keep the head and tail of long output, which is where the useful parts usually are. */
export function truncateMiddle(s, max) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6), tail = max - head;
  return `${s.slice(0, head)}\n\n… [${s.length - max} characters truncated] …\n\n${s.slice(-tail)}`;
}

export const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

export function realpathLoose(p) {
  let cur = p;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function estimateTokens(messages) {
  let chars = 0;
  const b = (x) => typeof x === 'string' ? x.length
    : x.type === 'text' ? x.text.length
    : x.type === 'thinking' ? x.thinking.length
    : x.type === 'image' ? 6000
    : x.type === 'tool_use' ? JSON.stringify(x.input || {}).length
    : x.type === 'tool_result' ? (Array.isArray(x.content) ? x.content.reduce((n, y) => n + b(y), 0) : String(x.content ?? '').length) : 0;
  for (const m of messages) chars += typeof m.content === 'string' ? m.content.length : m.content.reduce((n, x) => n + b(x), 0);
  return Math.ceil(chars / 4);
}
