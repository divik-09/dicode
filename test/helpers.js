import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fresh DICODE_HOME and a project directory (optionally a git repo). */
export function sandbox({ git = false, files = {} } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dicode-test-')));
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  process.env.DICODE_HOME = home;
  delete process.env.ANTHROPIC_API_KEY;
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); }
  if (git) {
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-qm', 'init', '--allow-empty');
  }
  return { base, home, root, file: (f) => path.join(root, f), read: (f) => fs.readFileSync(path.join(root, f), 'utf8') };
}

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

/** Scriptable mock of the Anthropic Messages streaming API. */
export async function mockAnthropic() {
  const queue = [];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    requests.push(body);
    let spec = queue.shift() || { blocks: [{ type: 'text', text: 'ok' }] };
    if (typeof spec === 'function') spec = spec(body);
    if (spec.status) { res.writeHead(spec.status, spec.headers || {}); return res.end(spec.body || '{"error":"x"}'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const w = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    w('message_start', { message: { usage: { input_tokens: spec.inputTokens ?? 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    for (const [i, b] of spec.blocks.entries()) {
      if (spec.delayMs) await sleep(spec.delayMs);
      if (b.type === 'text') {
        w('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
        const mid = Math.ceil(b.text.length / 2);
        w('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text.slice(0, mid) } });
        if (spec.delayMs) await sleep(spec.delayMs);
        w('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text.slice(mid) } });
      } else if (b.type === 'thinking') {
        w('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '' } });
        w('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: b.thinking } });
        w('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: 'sig123' } });
      } else {
        w('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        const j = b.rawJson ?? JSON.stringify(b.input);
        w('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: j.slice(0, 5) } });
        w('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: j.slice(5) } });
      }
      if (!b.noStop) w('content_block_stop', { index: i });
    }
    const stop = spec.stop || (spec.blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    w('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: spec.outputTokens ?? 50 } });
    w('message_stop', {});
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let n = 0;
  const id = () => `tu_${++n}`;
  return {
    url: `http://127.0.0.1:${server.address().port}`, queue, requests,
    say: (text, extra = {}) => queue.push({ blocks: [{ type: 'text', text }], ...extra }),
    tool: (name, input, extra = {}) => queue.push({ blocks: [{ type: 'tool_use', id: id(), name, input }], ...extra }),
    tools: (...calls) => queue.push({ blocks: calls.map(([name, input]) => ({ type: 'tool_use', id: id(), name, input })) }),
    lastToolResults: () => requests.at(-1).messages.at(-1).content.filter((b) => b.type === 'tool_result'),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** Build an Agent wired to the mock, with a scripted permission UI. */
export async function makeAgent(sb, mock, { settings = {}, mode, answers = [], events = [], approvePlan } = {}) {
  const { loadSettings } = await import('../src/config.js');
  const { createPermissions } = await import('../src/permissions.js');
  const { Agent } = await import('../src/agent.js');
  const s = loadSettings(sb.root, { settings: { providers: { anthropic: { apiKey: 'test', baseUrl: mock.url } }, ...settings } });
  const permissions = createPermissions({ settings: s, root: sb.root, mode, headless: true });
  const asked = [];
  const ui = {
    onEvent: (e) => events.push(e),
    askPermission: async (req) => { asked.push(req); const a = answers.shift(); return typeof a === 'function' ? a(req) : a || { decision: 'deny' }; },
    approvePlan,
  };
  const agent = new Agent({ settings: s, root: sb.root, permissions, ui });
  return { agent, asked, events, permissions, settings: s };
}
