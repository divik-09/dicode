// Standalone mock Anthropic server for terminal (PTY) tests: node mock-server.mjs <script.json> <log.jsonl> <port-file>
import http from 'node:http';
import fs from 'node:fs';
const [scriptFile, logFile, portFile] = process.argv.slice(2);
const queue = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  fs.appendFileSync(logFile, body + '\n');
  const spec = queue.shift() || { blocks: [{ type: 'text', text: 'ok' }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const w = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  w('message_start', { message: { usage: { input_tokens: 1200 } } });
  for (const [i, b] of spec.blocks.entries()) {
    if (b.type === 'text') {
      w('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
      for (const chunk of b.text.match(/.{1,12}/gs) || []) { w('content_block_delta', { index: i, delta: { type: 'text_delta', text: chunk } }); if (spec.delayMs) await sleep(spec.delayMs); }
    } else {
      w('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      w('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    w('content_block_stop', { index: i });
  }
  w('message_delta', { delta: { stop_reason: spec.blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 80 } });
  w('message_stop', {});
  res.end();
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
