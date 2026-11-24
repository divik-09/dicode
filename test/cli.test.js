import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox, mockAnthropic } from './helpers.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dicode.js');
let mock, sb;
before(async () => { mock = await mockAnthropic(); sb = sandbox({ files: { 'app.js': 'console.log(1)\n' } }); });
after(async () => { await mock.close(); });

function run(args, { input, cwd = sb.root, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile('node', [BIN, ...args], {
      cwd, timeout: 20000,
      env: { ...process.env, DICODE_HOME: sb.home, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: mock.url, NO_COLOR: '1', ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

test('version, help, bad options', async () => {
  assert.match((await run(['--version'])).stdout, /^\d+\.\d+\.\d+/);
  assert.match((await run(['--help'])).stdout, /--permission-mode/);
  const bad = await run(['--frobnicate']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown option --frobnicate/);
  assert.match((await run(['-p', 'x', '--permission-mode', 'yolo'])).stderr, /Unknown permission mode/);
});

test('-p prints the final answer', async () => {
  mock.say('The app logs 1.');
  const r = await run(['-p', 'what does app.js do?']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'The app logs 1.\n');
});

test('--output-format json reports result, session and usage', async () => {
  mock.say('json answer');
  const r = await run(['-p', 'hi', '--output-format', 'json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.type, 'result');
  assert.equal(j.is_error, false);
  assert.equal(j.result, 'json answer');
  assert.match(j.session_id, /^[0-9a-f-]{36}$/);
  assert.equal(j.usage.output_tokens, 50);
  assert.equal(j.total_cost_usd, null, 'cost is unknown without a pricing table');
});

test('stream-json emits one JSON event per line', async () => {
  mock.tool('Read', { file_path: 'app.js' });
  mock.say('read it');
  const r = await run(['-p', 'read app.js', '--output-format', 'stream-json']);
  const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === 'tool_use' && e.name === 'Read'));
  assert.ok(events.some((e) => e.type === 'tool_result' && /console\.log/.test(e.output)));
  assert.equal(events.at(-1).type, 'result');
});

test('headless denies unapproved actions; --allowedTools and acceptEdits grant them', async () => {
  mock.tool('Bash', { command: 'touch made-by-bash.txt' });
  mock.say('could not');
  await run(['-p', 'make a file']);
  assert.ok(!fs.existsSync(sb.file('made-by-bash.txt')));
  assert.match(JSON.stringify(mock.requests.at(-1).messages.at(-1)), /not granted/);

  mock.tool('Bash', { command: 'touch made-by-bash.txt' });
  mock.say('made it');
  assert.equal((await run(['-p', 'make a file', '--allowedTools', 'Bash(touch:*)'])).stdout, 'made it\n');
  assert.ok(fs.existsSync(sb.file('made-by-bash.txt')));

  mock.tool('Write', { file_path: 'new.txt', content: 'hello' });
  mock.say('wrote');
  await run(['-p', 'write', '--permission-mode', 'acceptEdits']);
  assert.equal(sb.read('new.txt'), 'hello');

  mock.tool('Bash', { command: 'git push --force' });
  mock.say('blocked');
  await run(['-p', 'push', '--dangerously-skip-permissions', '--disallowedTools', 'Bash(git push:*)']);
  assert.match(JSON.stringify(mock.requests.at(-1).messages.at(-1)), /deny rule/);
});

test('piped stdin is appended to the prompt', async () => {
  mock.say('It is a null pointer.');
  const r = await run(['-p', 'explain this error'], { input: 'TypeError: cannot read properties of null' });
  assert.equal(r.stdout, 'It is a null pointer.\n');
  assert.match(mock.requests.at(-1).messages.at(-1).content[0].text, /explain this error\n\n<stdin>\nTypeError/);
});

test('-c continues the most recent conversation; sessions lists it', async () => {
  const fresh = sandbox();
  mock.say('noted: the password is swordfish');
  await run(['-p', 'remember swordfish'], { cwd: fresh.root, env: { DICODE_HOME: sb.home } });
  mock.say('swordfish');
  await run(['-p', 'what was it?', '-c'], { cwd: fresh.root, env: { DICODE_HOME: sb.home } });
  const msgs = mock.requests.at(-1).messages;
  assert.equal(msgs.length, 3);
  assert.match(JSON.stringify(msgs[0]), /remember swordfish/);
  const list = await run(['sessions'], { cwd: fresh.root, env: { DICODE_HOME: sb.home } });
  assert.match(list.stdout, /remember swordfish/);
});

test('plan mode in headless returns the plan', async () => {
  mock.tool('ExitPlanMode', { plan: '1. Do the thing\n2. Test it' });
  mock.say('');
  const r = await run(['-p', 'plan it', '--permission-mode', 'plan', '--output-format', 'json']);
  const j = JSON.parse(r.stdout);
  assert.match(j.plan, /Do the thing/);
  assert.match(j.result, /Do the thing/);
});

test('provider errors give a non-zero exit code', async () => {
  mock.queue.push({ status: 401, body: '{"error":"invalid x-api-key"}' });
  const r = await run(['-p', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /401/);
});

test('config set/get and doctor', async () => {
  assert.equal((await run(['config', 'set', 'maxSteps', '50'])).code, 0);
  assert.equal((await run(['config', 'get', 'maxSteps'])).stdout.trim(), '50');
  const cfg = await run(['config', 'get']);
  assert.doesNotMatch(cfg.stdout, /test-key/);
  const d = await run(['doctor']);
  assert.match(d.stdout, /Model anthropic\/claude-sonnet-5-5: credentials found/);
});
