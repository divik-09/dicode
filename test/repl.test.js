import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const hasPython = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' }).status === 0;

test('interactive REPL end to end in a real pseudo-terminal', { skip: !hasPython || process.platform === 'win32' ? 'needs python3 with pty' : false, timeout: 90000 }, () => {
  const r = spawnSync('python3', [path.join(HERE, 'pty_repl.py')], { encoding: 'utf8', timeout: 85000 });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.doesNotMatch(out, /FAIL/);
  assert.ok((out.match(/^PASS/gm) || []).length >= 20, out);
});
