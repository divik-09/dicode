import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, mockAnthropic, makeAgent, sleep } from './helpers.js';

let mock;
before(async () => { mock = await mockAnthropic(); });
after(async () => { await mock.close(); });
const reset = () => { mock.queue.length = 0; mock.requests.length = 0; };
const ok = (decision = 'allow', feedback) => ({ decision, feedback });

test('plain reply streams text and reports usage; request shape is clean', async () => {
  reset();
  const sb = sandbox({ files: { 'DICODE.md': '# Rules\nAlways use tabs.\n' } });
  const { agent, events } = await makeAgent(sb, mock);
  mock.say('Hello there');
  const r = await agent.run('hi');
  assert.equal(r.text, 'Hello there');
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hello there');
  const req = mock.requests[0];
  assert.match(req.system[0].text, /Always use tabs/, 'project memory injected');
  assert.match(req.system[0].text, /Working directory: /);
  assert.ok(req.tools.some((t) => t.name === 'Edit') && !req.tools.some((t) => t.name === 'ExitPlanMode'));
  assert.deepEqual(req.messages[0].content, [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }], 'cache breakpoint on the last message');
  assert.equal(agent.usage.input, 100);
  assert.equal(agent.usage.output, 50);
});

test('read → edit with approval, then results flow back to the model', async () => {
  reset();
  const sb = sandbox({ files: { 'app.js': 'function add(a, b) {\n  return a - b;\n}\n' } });
  const { agent, asked } = await makeAgent(sb, mock, { answers: [ok()] });
  mock.tool('Read', { file_path: 'app.js' });
  mock.tool('Edit', { file_path: 'app.js', old_string: 'return a - b;', new_string: 'return a + b;' });
  mock.say('Fixed the bug in app.js:2.');
  const r = await agent.run('fix add');
  assert.equal(r.text, 'Fixed the bug in app.js:2.');
  assert.equal(sb.read('app.js'), 'function add(a, b) {\n  return a + b;\n}\n');
  assert.equal(asked.length, 1, 'only the edit asked');
  assert.equal(asked[0].tool, 'Edit');
  assert.match(asked[0].preview.text, /-  return a - b;\n\+  return a \+ b;/);
  const readResult = mock.requests[1].messages.at(-1).content[0];
  assert.match(readResult.content, /1\tfunction add/);
  assert.ok(mock.requests.every((rq) => rq.messages.every((m) => Object.keys(m).sort().join() === 'content,role')));
});

test('denial with feedback is relayed; "always" switches to accept-edits', async () => {
  reset();
  const sb = sandbox({ files: { 'x.txt': 'one\n' } });
  const { agent, asked, permissions } = await makeAgent(sb, mock, { answers: [ok('deny', 'use uppercase instead'), ok('always')] });
  mock.tool('Read', { file_path: 'x.txt' });
  mock.tool('Edit', { file_path: 'x.txt', old_string: 'one', new_string: 'two' });
  mock.tool('Edit', { file_path: 'x.txt', old_string: 'one', new_string: 'ONE' });
  mock.tool('Edit', { file_path: 'x.txt', old_string: 'ONE', new_string: 'ONE!' });
  mock.say('done');
  await agent.run('change it');
  const denied = mock.requests[2].messages.at(-1).content[0];
  assert.equal(denied.is_error, true);
  assert.match(denied.content, /declined.*use uppercase instead/);
  assert.equal(permissions.mode, 'acceptEdits');
  assert.equal(asked.length, 2, 'third edit was auto-accepted');
  assert.equal(sb.read('x.txt'), 'ONE!\n');
});

test('independent read-only calls run in parallel without prompts', async () => {
  reset();
  const sb = sandbox({ files: { 'a.txt': 'A', 'b.txt': 'B' } });
  const { agent, asked, events } = await makeAgent(sb, mock);
  mock.tools(['Read', { file_path: 'a.txt' }], ['Read', { file_path: 'b.txt' }], ['Grep', { pattern: 'B' }]);
  mock.say('read both');
  await agent.run('read');
  const results = mock.requests[1].messages.at(-1).content;
  assert.equal(results.length, 3);
  assert.match(results[0].content, /A/);
  assert.match(results[1].content, /B/);
  assert.equal(asked.length, 0);
  const order = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end').map((e) => e.type);
  assert.deepEqual(order.slice(0, 3), ['tool_start', 'tool_start', 'tool_start'], 'all started before any finished');
});

test('plan mode: read-only, ExitPlanMode approval switches mode and prompt', async () => {
  reset();
  const sb = sandbox({ files: { 'a.js': 'x' } });
  let shownPlan = null;
  const { agent, permissions } = await makeAgent(sb, mock, { mode: 'plan', approvePlan: async (p) => { shownPlan = p; return { approved: true, mode: 'acceptEdits' }; } });
  mock.tool('Write', { file_path: 'a.js', content: 'nope' });
  mock.tool('ExitPlanMode', { plan: '1. Change a.js\n2. Run tests' });
  mock.tool('Write', { file_path: 'b.js', content: 'yes' });
  mock.say('implemented');
  await agent.run('plan then do');
  assert.match(mock.requests[0].system[0].text, /PLAN MODE IS ACTIVE/);
  assert.ok(mock.requests[0].tools.some((t) => t.name === 'ExitPlanMode'));
  assert.match(mock.requests[1].messages.at(-1).content[0].content, /plan mode is read-only/);
  assert.equal(sb.read('a.js'), 'x');
  assert.match(shownPlan, /Run tests/);
  assert.equal(permissions.mode, 'acceptEdits');
  assert.doesNotMatch(mock.requests[2].system[0].text, /PLAN MODE/);
  assert.ok(!mock.requests[2].tools.some((t) => t.name === 'ExitPlanMode'));
  assert.equal(sb.read('b.js'), 'yes');
});

test('interrupt during streaming keeps a valid transcript; the next run works', async () => {
  reset();
  const sb = sandbox();
  const { agent } = await makeAgent(sb, mock);
  mock.queue.push({ blocks: [{ type: 'text', text: 'This is a long answer that will be interrupted' }], delayMs: 300 });
  const p = agent.run('talk');
  await sleep(150);
  agent.abort();
  const r = await p;
  assert.equal(r.interrupted, true);
  mock.say('back again');
  const r2 = await agent.run('continue');
  assert.equal(r2.text, 'back again');
  const roles = mock.requests.at(-1).messages.map((m) => m.role);
  assert.equal(roles[0], 'user');
  assert.equal(roles.at(-1), 'user');
});

test('interrupt during a running tool closes the tool call', async () => {
  reset();
  const sb = sandbox();
  const { agent } = await makeAgent(sb, mock, { settings: { permissions: { allow: ['Bash(sleep:*)'] } } });
  mock.tool('Bash', { command: 'sleep 20' });
  const p = agent.run('wait');
  await sleep(400);
  agent.abort();
  const r = await p;
  assert.equal(r.interrupted, true);
  const last = agent.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
  assert.match(last.content[0].content, /interrupted/i);
});

test('output-limit cut-off: partial tool call dropped, model asked to continue', async () => {
  reset();
  const sb = sandbox();
  const { agent } = await makeAgent(sb, mock);
  mock.queue.push({ blocks: [{ type: 'text', text: 'Writing a big file' }, { type: 'tool_use', id: 'cut', name: 'Write', input: {}, rawJson: '{"file_path":"big.txt","content":"aaaa', noStop: true }], stop: 'max_tokens' });
  mock.say('Done in smaller pieces');
  const r = await agent.run('write big');
  assert.equal(r.text, 'Done in smaller pieces');
  const sent = mock.requests[1].messages;
  assert.ok(!JSON.stringify(sent).includes('"cut"'), 'partial tool_use never sent back');
  assert.match(JSON.stringify(sent.at(-1)), /output token limit/);
});

test('context overflow triggers compaction and a retry', async () => {
  reset();
  const sb = sandbox();
  const { agent, events } = await makeAgent(sb, mock);
  mock.say('first answer');
  await agent.run('earlier question');
  mock.queue.push({ status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}' });
  mock.say('SUMMARY: user asked an earlier question.');
  mock.say('answer after compaction');
  const r = await agent.run('new question');
  assert.equal(r.text, 'answer after compaction');
  assert.ok(events.some((e) => e.type === 'compacted'));
  const summaryReq = mock.requests.at(-2);
  assert.match(summaryReq.system[0].text, /summarizing a software engineering session/);
  assert.equal(summaryReq.tools, undefined);
  const finalReq = mock.requests.at(-1);
  assert.equal(finalReq.messages.length, 1);
  assert.match(finalReq.messages[0].content[0].text, /SUMMARY: user asked/);
});

test('automatic compaction when the context grows past the threshold', async () => {
  reset();
  const sb = sandbox({ files: { 'f.txt': 'data' } });
  const { agent, events } = await makeAgent(sb, mock, { settings: { autoCompactTokens: 1000 } });
  mock.queue.push({ blocks: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'f.txt' } }], inputTokens: 5000 });
  mock.say('SUMMARY of work so far');
  mock.say('finished');
  const r = await agent.run('go');
  assert.equal(r.text, 'finished');
  assert.ok(events.some((e) => e.type === 'compacted' && e.auto));
  assert.match(mock.requests.at(-1).messages[0].content[0].text, /continues from an earlier conversation/);
  assert.equal(agent.readFiles.size, 0, 'must re-read files after compaction');
});

test('hooks: PreToolUse blocks, PostToolUse feeds back, Stop forces one more round, UserPromptSubmit adds context', async () => {
  reset();
  const sb = sandbox({ files: { 'a.txt': 'x\n' } });
  const marker = path.join(sb.base, 'stopped-once');
  const settings = { hooks: {
    PreToolUse: [{ matcher: 'Write', command: 'cat >/dev/null; echo "writes are frozen today" >&2; exit 2' }],
    PostToolUse: [{ matcher: 'Read', command: 'cat >/dev/null; echo "remember: run the linter" >&2; exit 2' }],
    Stop: [{ command: `cat >/dev/null; if [ -f ${marker} ]; then exit 0; fi; touch ${marker}; echo "tests were not run" >&2; exit 2` }],
    UserPromptSubmit: [{ command: 'cat >/dev/null; echo "branch: feature/x"' }],
  } };
  const { agent } = await makeAgent(sb, mock, { settings });
  mock.tool('Write', { file_path: 'b.txt', content: 'y' });
  mock.tool('Read', { file_path: 'a.txt' });
  mock.say('all done');
  mock.say('ran the tests, now done');
  const r = await agent.run('do it');
  assert.equal(r.text, 'ran the tests, now done');
  assert.match(JSON.stringify(mock.requests[0].messages[0]), /branch: feature\/x/);
  const pre = mock.requests[1].messages.at(-1).content[0];
  assert.equal(pre.is_error, true);
  assert.match(pre.content, /writes are frozen today/);
  assert.ok(!fs.existsSync(sb.file('b.txt')));
  assert.match(mock.requests[2].messages.at(-1).content[0].content, /remember: run the linter/);
  assert.match(JSON.stringify(mock.requests[3].messages.at(-1)), /tests were not run/);
});

test('transient errors are retried; a broken primary falls back to the next model', async () => {
  reset();
  const sb = sandbox();
  const { agent, events } = await makeAgent(sb, mock, { settings: { model: 'anthropic/primary', fallbackModels: ['anthropic/backup'] } });
  mock.queue.push({ status: 529, headers: { 'retry-after': '0' }, body: 'overloaded' });
  mock.say('after retry');
  assert.equal((await agent.run('a')).text, 'after retry');
  assert.ok(events.some((e) => e.type === 'retry'));
  mock.queue.push((body) => (body.model === 'primary' ? { status: 401, body: 'bad key' } : { blocks: [{ type: 'text', text: 'never' }] }));
  mock.queue.push((body) => ({ blocks: [{ type: 'text', text: `served by ${body.model}` }] }));
  assert.equal((await agent.run('b')).text, 'served by backup');
});

test('explore sub-agent: fresh context, read-only, never prompts', async () => {
  reset();
  const sb = sandbox({ files: { 'src/auth.js': 'export function login() {}\n' } });
  const { agent, asked, events } = await makeAgent(sb, mock);
  mock.tool('Task', { description: 'find login', prompt: 'Where is login defined? Report file:line.' });
  mock.tool('Grep', { pattern: 'function login', output_mode: 'content' });
  mock.tool('Edit', { file_path: 'src/auth.js', old_string: 'login', new_string: 'hacked' });
  mock.say('login is defined at src/auth.js:1');
  mock.say('It is in src/auth.js:1.');
  const r = await agent.run('where is login?');
  assert.equal(r.text, 'It is in src/auth.js:1.');
  const subFirst = mock.requests[1];
  assert.match(subFirst.system[0].text, /You are a sub-agent/);
  assert.equal(subFirst.messages.length, 1);
  assert.ok(!subFirst.tools.some((t) => ['Edit', 'Write', 'Task', 'TodoWrite'].includes(t.name)));
  assert.match(mock.requests[3].messages.at(-1).content[0].content, /Unknown tool|unknown tool|denied/i);
  assert.equal(sb.read('src/auth.js'), 'export function login() {}\n');
  assert.equal(asked.length, 0);
  assert.match(mock.requests.at(-1).messages.at(-1).content[0].content, /src\/auth\.js:1/);
  assert.ok(events.some((e) => e.type === 'subagent'));
});

test('extended thinking blocks are requested, kept with signatures and sent back', async () => {
  reset();
  const sb = sandbox({ files: { 'a.txt': 'x' } });
  const { agent } = await makeAgent(sb, mock, { settings: { thinking: { enabled: true, budgetTokens: 2000 } } });
  mock.queue.push({ blocks: [{ type: 'thinking', thinking: 'I should read the file.' }, { type: 'tool_use', id: 'th1', name: 'Read', input: { file_path: 'a.txt' } }] });
  mock.say('read it');
  await agent.run('think');
  assert.deepEqual(mock.requests[0].thinking, { type: 'enabled', budget_tokens: 2000 });
  assert.ok(mock.requests[0].max_tokens > 2000);
  const sentBack = mock.requests[1].messages[1].content[0];
  assert.deepEqual(sentBack, { type: 'thinking', thinking: 'I should read the file.', signature: 'sig123' });
});

test('bad tool calls get clear errors instead of crashing', async () => {
  reset();
  const sb = sandbox();
  const { agent } = await makeAgent(sb, mock);
  mock.tools(['NoSuchTool', {}], ['Read', {}]);
  mock.say('ok');
  await agent.run('x');
  const [a, b] = mock.requests[1].messages.at(-1).content;
  assert.match(a.content, /unknown tool "NoSuchTool"/);
  assert.match(b.content, /missing required parameter\(s\): file_path/);
});

test('non-interactive runs deny anything that needs approval, with guidance', async () => {
  reset();
  const sb = sandbox();
  const { loadSettings } = await import('../src/config.js');
  const { createPermissions } = await import('../src/permissions.js');
  const { Agent } = await import('../src/agent.js');
  const s = loadSettings(sb.root, { settings: { providers: { anthropic: { apiKey: 't', baseUrl: mock.url } } } });
  const agent = new Agent({ settings: s, root: sb.root, permissions: createPermissions({ settings: s, root: sb.root, headless: true }) });
  mock.tool('Bash', { command: 'rm -rf build' });
  mock.say('could not');
  await agent.run('clean');
  assert.match(mock.requests[1].messages.at(-1).content[0].content, /not granted \(non-interactive run\).*--allowedTools/);
});

test('sessions persist and resume', async () => {
  reset();
  const sb = sandbox();
  const { openSession, loadSession, listSessions } = await import('../src/session.js');
  const { agent } = await makeAgent(sb, mock);
  agent.session = openSession(sb.root);
  mock.say('remembered: blue');
  await agent.run('my favourite color is blue');
  const { messages } = loadSession(sb.root, agent.session.id);
  assert.equal(messages.length, 2);
  assert.equal(listSessions(sb.root)[0].preview, 'my favourite color is blue');
  const { agent: resumed } = await makeAgent(sb, mock);
  resumed.messages = messages;
  mock.say('blue');
  await resumed.run('what is my favourite color?');
  assert.equal(mock.requests.at(-1).messages.length, 3);
  fs.appendFileSync(agent.session.file, '{"type":"message","message":{"role":"us'); // torn write after a crash
  assert.equal(loadSession(sb.root, agent.session.id).messages.length, 2, 'tolerates a torn last line');
});

test('/undo after an agent turn restores files', async () => {
  reset();
  const sb = sandbox({ files: { 'a.txt': 'v1\n' } });
  const { agent } = await makeAgent(sb, mock, { mode: 'acceptEdits' });
  mock.tool('Read', { file_path: 'a.txt' });
  mock.tools(['Edit', { file_path: 'a.txt', old_string: 'v1', new_string: 'v2' }], ['Write', { file_path: 'b.txt', content: 'new' }]);
  mock.say('changed');
  await agent.run('change');
  assert.equal(sb.read('a.txt'), 'v2\n');
  const u = agent.checkpoints.undo();
  assert.equal(u.files.length, 2);
  assert.equal(sb.read('a.txt'), 'v1\n');
  assert.ok(!fs.existsSync(sb.file('b.txt')));
});
