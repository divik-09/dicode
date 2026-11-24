import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './config.js';
import { uuid } from './util.js';

/** Images are large base64 blobs; keep transcripts small by storing a placeholder instead. */
function stripImages(m) {
  if (typeof m.content === 'string') return m;
  const fix = (b) => b.type === 'image' ? { type: 'text', text: '[image omitted from saved transcript]' }
    : b.type === 'tool_result' && Array.isArray(b.content) ? { ...b, content: b.content.map(fix) } : b;
  return { ...m, content: m.content.map(fix) };
}

export const projectDir = (root) => path.join(homeDir(), 'projects', root.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, ''));

/** Append-only JSONL transcript. "replace" records (after compaction) reset the message list. */
export function openSession(root, id = uuid()) {
  const dir = projectDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const write = (rec) => fs.appendFileSync(file, JSON.stringify({ ...rec, ts: Date.now() }) + '\n', { mode: 0o600 });
  return {
    id, file,
    append: (message) => write({ type: 'message', message: stripImages(message) }),
    replace: (messages) => write({ type: 'replace', messages: messages.map(stripImages) }),
    meta: (data) => write({ type: 'meta', ...data }),
  };
}

export function loadSession(root, id) {
  const file = path.join(projectDir(root), `${id}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`No session ${id} for this project`);
  let messages = [];
  let meta = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; } // tolerate a torn last line after a crash
    if (r.type === 'message') messages.push(r.message);
    else if (r.type === 'replace') messages = r.messages;
    else if (r.type === 'meta') meta = { ...meta, ...r };
  }
  return { messages, meta };
}

export function listSessions(root) {
  const dir = projectDir(root);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return files.map((f) => {
    const full = path.join(dir, f);
    const id = f.replace(/\.jsonl$/, '');
    let first = '', count = 0;
    try {
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (!line) continue;
        const r = JSON.parse(line);
        if (r.type !== 'message') continue;
        count++;
        if (!first && r.message.role === 'user' && typeof r.message.content === 'string') first = r.message.content;
      }
    } catch {}
    return { id, updatedAt: fs.statSync(full).mtimeMs, messages: count, preview: first.replace(/\s+/g, ' ').slice(0, 70) };
  }).filter((s) => s.messages > 0).sort((a, b) => b.updatedAt - a.updatedAt);
}
