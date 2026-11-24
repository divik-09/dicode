import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, sleep } from './helpers.js';
import { Read, Write, Edit, MultiEdit, LS, applyEdit } from '../src/tools/files.js';
import { Glob, Grep } from '../src/tools/search.js';
import { Bash, BashOutput, KillShell, killAllBackground } from '../src/tools/bash.js';
import { createCheckpoints } from '../src/checkpoints.js';
import { createPermissions } from '../src/permissions.js';
import { loadSettings } from '../src/config.js';
import { which } from '../src/util.js';

function ctxFor(sb, extra = {}) {
  const settings = loadSettings(sb.root);
  return { root: sb.root, settings, shell: { cwd: sb.root }, readFiles: new Map(), checkpoints: createCheckpoints(), todos: [], background: new Map(), permissions: createPermissions({ settings, root: sb.root, headless: true }), signal: new AbortController().signal, emit() {}, ...extra };
}

test('Read: numbered lines, offset/limit, long lines, empty and binary files, images', async () => {
  const sb = sandbox({ files: { 'a.txt': Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n', 'empty.txt': '', 'long.txt': 'x'.repeat(3000) } });
  fs.writeFileSync(sb.file('bin.dat'), Buffer.from([1, 0, 2, 3]));
  fs.writeFileSync(sb.file('pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const ctx = ctxFor(sb);
  const out = await Read.run({ file_path: 'a.txt' }, ctx);
  assert.match(out, /^ {5}1\tline 1$/m);
  assert.match(out, /^ {4}10\tline 10$/m);
  assert.doesNotMatch(out, /more lines/);
  const part = await Read.run({ file_path: 'a.txt', offset: 3, limit: 2 }, ctx);
  assert.equal(part.split('\n')[0], '     3\tline 3');
  assert.match(part, /6 more lines; continue with offset=5/);
  assert.equal(await Read.run({ file_path: 'empty.txt' }, ctx), '(file is empty)');
  assert.match(await Read.run({ file_path: 'long.txt' }, ctx), /line truncated/);
  await assert.rejects(Read.run({ file_path: 'bin.dat' }, ctx), /binary/);
  await assert.rejects(Read.run({ file_path: 'nope.txt' }, ctx), /does not exist/);
  await assert.rejects(Read.run({ file_path: '.' }, ctx), /directory/);
  const img = await Read.run({ file_path: 'pic.png' }, ctx);
  assert.equal(img.image.mediaType, 'image/png');
  assert.ok(ctx.readFiles.has(sb.file('a.txt')));
});

test('Write: creates files and dirs, refuses blind overwrite and stale overwrite', async () => {
  const sb = sandbox({ files: { 'exists.js': 'old\n' } });
  const ctx = ctxFor(sb);
  assert.match(await Write.run({ file_path: 'src/deep/new.js', content: 'a\nb\n' }, ctx), /Created src\/deep\/new\.js/);
  assert.equal(sb.read('src/deep/new.js'), 'a\nb\n');
  await assert.rejects(Write.run({ file_path: 'exists.js', content: 'x' }, ctx), /must Read/);
  await Read.run({ file_path: 'exists.js' }, ctx);
  await sleep(20);
  fs.writeFileSync(sb.file('exists.js'), 'changed by user\n');
  fs.utimesSync(sb.file('exists.js'), new Date(), new Date(Date.now() + 5000));
  await assert.rejects(Write.run({ file_path: 'exists.js', content: 'x' }, ctx), /modified since you last read/);
  await Read.run({ file_path: 'exists.js' }, ctx);
  assert.match(await Write.run({ file_path: 'exists.js', content: 'new\n' }, ctx), /Updated/);
  const p = Write.preview({ file_path: 'brand-new.txt', content: 'hi\n' }, ctx);
  assert.equal(p.created, true);
  assert.equal(p.added, 1);
});

test('Edit: exact unique match, replace_all, CRLF preservation, helpful errors, literal $ handling', async () => {
  const sb = sandbox({ files: { 'f.js': 'const a = 1;\nconst b = 1;\nfunction x() {\n  return a;\n}\n', 'win.txt': 'one\r\ntwo\r\nthree\r\n' } });
  const ctx = ctxFor(sb);
  await assert.rejects(Edit.run({ file_path: 'f.js', old_string: 'a', new_string: 'z' }, ctx), /must Read/);
  await Read.run({ file_path: 'f.js' }, ctx);
  await assert.rejects(Edit.run({ file_path: 'f.js', old_string: '= 1;', new_string: '= 2;' }, ctx), /appears 2 times/);
  await assert.rejects(Edit.run({ file_path: 'f.js', old_string: 'missing', new_string: 'x' }, ctx), /not found/);
  await assert.rejects(Edit.run({ file_path: 'f.js', old_string: 'a', new_string: 'a' }, ctx), /identical/);
  const out = await Edit.run({ file_path: 'f.js', old_string: '  return a;', new_string: '  return a + b + "$&";' }, ctx);
  assert.match(out, /Edited f\.js/);
  assert.match(out, /4\t  return a \+ b \+ "\$&";/, 'snippet with line numbers');
  assert.match(sb.read('f.js'), /return a \+ b \+ "\$&";/, '$& inserted literally');
  await Edit.run({ file_path: 'f.js', old_string: '= 1;', new_string: '= 3;', replace_all: true }, ctx);
  assert.equal((sb.read('f.js').match(/= 3;/g) || []).length, 2);

  await Read.run({ file_path: 'win.txt' }, ctx);
  await Edit.run({ file_path: 'win.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' }, ctx);
  assert.equal(sb.read('win.txt'), 'uno\r\ndos\r\nthree\r\n', 'CRLF line endings preserved');

  assert.match(await Edit.run({ file_path: 'created.md', old_string: '', new_string: '# hi\n' }, ctx), /Created/);
  const prev = Edit.preview({ file_path: 'f.js', old_string: 'function x()', new_string: 'function y()' }, ctx);
  assert.match(prev.text, /^-function x\(\) \{$/m);
  assert.match(prev.text, /^\+function y\(\) \{$/m);
});

test('MultiEdit is atomic', async () => {
  const sb = sandbox({ files: { 'm.py': 'def a():\n    pass\n\ndef b():\n    pass\n' } });
  const ctx = ctxFor(sb);
  await Read.run({ file_path: 'm.py' }, ctx);
  await assert.rejects(MultiEdit.run({ file_path: 'm.py', edits: [{ old_string: 'def a', new_string: 'def alpha' }, { old_string: 'nonexistent', new_string: 'x' }] }, ctx), /Edit 2 of 2 failed \(no changes applied\)/);
  assert.match(sb.read('m.py'), /def a\(\)/, 'unchanged after failure');
  await MultiEdit.run({ file_path: 'm.py', edits: [{ old_string: 'def a', new_string: 'def alpha' }, { old_string: 'def b', new_string: 'def beta' }, { old_string: 'def alpha():\n    pass', new_string: 'def alpha():\n    return 1' }] }, ctx);
  assert.equal(sb.read('m.py'), 'def alpha():\n    return 1\n\ndef beta():\n    pass\n');
});

test('Glob respects .gitignore, matches at any depth, sorts newest first', async () => {
  const sb = sandbox({ git: true, files: { 'src/a.ts': '', 'src/lib/b.ts': '', 'src/c.js': '', 'README.md': '', '.gitignore': 'dist/\n', 'dist/out.ts': '' } });
  const ctx = ctxFor(sb);
  await sleep(20); fs.writeFileSync(sb.file('src/lib/b.ts'), 'newer');
  const ts = (await Glob.run({ pattern: '*.ts' }, ctx)).split('\n');
  assert.deepEqual(ts, ['src/lib/b.ts', 'src/a.ts']);
  assert.equal(await Glob.run({ pattern: 'src/**/*.js' }, ctx), 'src/c.js');
  assert.equal(await Glob.run({ pattern: '*.{md,js}', path: 'src' }, ctx), 'src/c.js');
  assert.equal(await Glob.run({ pattern: '*.rs' }, ctx), 'No files found.');
  const nogit = sandbox({ files: { 'x/y.py': '', 'node_modules/pkg/z.py': '' } });
  assert.equal(await Glob.run({ pattern: '*.py' }, ctxFor(nogit)), 'x/y.py', 'node_modules skipped without git');
});

for (const engine of ['js', ...(which('rg') ? ['rg'] : [])]) {
  test(`Grep (${engine}): modes, filters, context, case`, async () => {
    const sb = sandbox({ git: true, files: { 'a.js': 'const TODO = 1;\n// todo: fix\nok\n', 'b.py': 'x = 1  # TODO later\n', 'c.js': 'nothing here\n' } });
    const ctx = ctxFor(sb, { forceJsGrep: engine === 'js' });
    assert.deepEqual((await Grep.run({ pattern: 'TODO' }, ctx)).split('\n').sort(), ['a.js', 'b.py']);
    assert.equal(await Grep.run({ pattern: 'TODO', glob: '*.py' }, ctx), 'b.py');
    assert.equal(await Grep.run({ pattern: 'TODO', type: 'js' }, ctx), 'a.js');
    const content = await Grep.run({ pattern: 'todo', '-i': true, output_mode: 'content', glob: '*.js' }, ctx);
    assert.match(content, /a\.js:1:const TODO = 1;/);
    assert.match(content, /a\.js:2:\/\/ todo: fix/);
    const ctxLines = await Grep.run({ pattern: 'fix', output_mode: 'content', '-A': 1 }, ctx);
    assert.match(ctxLines, /a\.js-3-ok/);
    assert.match(await Grep.run({ pattern: 'TODO', output_mode: 'count' }, ctx), /a\.js:1/);
    assert.equal(await Grep.run({ pattern: 'zzz' }, ctx), 'No matches found.');
  });
}

test('Bash: output, exit codes, persistent cwd, timeout, project boundary', async () => {
  const sb = sandbox({ files: { 'sub/file.txt': 'hello' } });
  const ctx = ctxFor(sb);
  assert.equal(await Bash.run({ command: 'echo hi; echo err >&2' }, ctx), 'hi\nerr');
  const fail = await Bash.run({ command: 'echo nope; exit 3' }, ctx);
  assert.equal(fail.isError, true);
  assert.match(fail.text, /\[exit code 3\]/);
  await Bash.run({ command: 'cd sub' }, ctx);
  assert.equal(ctx.shell.cwd, fs.realpathSync(sb.file('sub')));
  assert.equal(await Bash.run({ command: 'cat file.txt' }, ctx), 'hello', 'cwd persisted');
  const out = await Bash.run({ command: 'cd /' }, ctx);
  assert.match(out, /reset to project root/);
  assert.equal(ctx.shell.cwd, sb.root);
  const t0 = Date.now();
  const slow = await Bash.run({ command: 'sleep 30', timeout: 400 }, ctx);
  assert.match(slow, /timed out/);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(await Bash.run({ command: 'true' }, ctx), '(no output)');
  assert.match(await Bash.run({ command: 'echo $GIT_PAGER $DICODE' }, ctx), /cat 1/);
  const big = await Bash.run({ command: 'yes abcdefghij | head -n 20000' }, ctx);
  assert.ok(big.length < 32000 && /truncated|dropped/.test(big));
});

test('Bash: interrupt kills the process tree', async () => {
  const sb = sandbox();
  const ac = new AbortController();
  const ctx = ctxFor(sb, { signal: ac.signal });
  const t0 = Date.now();
  const p = Bash.run({ command: 'sleep 30 & sleep 30; wait' }, ctx);
  setTimeout(() => ac.abort(), 200);
  assert.match(await p, /interrupted/);
  assert.ok(Date.now() - t0 < 5000);
});

test('Bash background shells: start, read incrementally, kill', async () => {
  const sb = sandbox();
  const ctx = ctxFor(sb);
  const start = await Bash.run({ command: 'for i in 1 2 3; do echo tick $i; sleep 0.2; done; sleep 30', run_in_background: true }, ctx);
  const id = /(bash_\w+)/.exec(start)[1];
  await sleep(350);
  const first = await BashOutput.run({ shell_id: id }, ctx);
  assert.match(first, /running/);
  assert.match(first, /tick 1/);
  await sleep(500);
  const second = await BashOutput.run({ shell_id: id }, ctx);
  assert.doesNotMatch(second, /tick 1/, 'only new output');
  assert.match(second, /tick 3/);
  assert.match(await KillShell.run({ shell_id: id }, ctx), /Killed/);
  await assert.rejects(BashOutput.run({ shell_id: id }, ctx), /No background shell/);
  await Bash.run({ command: 'sleep 30', run_in_background: true }, ctx);
  killAllBackground(ctx.background);
  assert.equal(ctx.background.size, 0);
});

test('LS lists one level with dirs first', async () => {
  const sb = sandbox({ files: { 'b.txt': 'x', 'a/inner.txt': '', 'c.log': '' } });
  const out = await LS.run({ path: '.', ignore: ['*.log'] }, ctxFor(sb));
  const lines = out.split('\n').map((l) => l.trim());
  assert.equal(lines[1], 'a/');
  assert.match(lines[2], /^b\.txt \(1 B\)$/);
  assert.ok(!out.includes('c.log'));
});

test('checkpoints undo restores edits and removes created files', async () => {
  const sb = sandbox({ files: { 'keep.txt': 'original\n' } });
  const ctx = ctxFor(sb);
  ctx.checkpoints.begin('turn 1');
  await Read.run({ file_path: 'keep.txt' }, ctx);
  await Edit.run({ file_path: 'keep.txt', old_string: 'original', new_string: 'changed' }, ctx);
  await Edit.run({ file_path: 'keep.txt', old_string: 'changed', new_string: 'changed twice' }, ctx);
  await Write.run({ file_path: 'new/made.txt', content: 'x' }, ctx);
  ctx.checkpoints.begin('turn 2 (no edits)');
  const r = ctx.checkpoints.undo();
  assert.equal(r.label, 'turn 1');
  assert.equal(sb.read('keep.txt'), 'original\n', 'restored to the state before the turn, not the intermediate one');
  assert.ok(!fs.existsSync(sb.file('new/made.txt')));
  assert.equal(ctx.checkpoints.undo(), null);
});

test('applyEdit unit cases', () => {
  assert.equal(applyEdit('aXbXc', 'X', 'Y', true).out, 'aYbYc');
  assert.throws(() => applyEdit('abc', '', 'x'), /empty/);
});
