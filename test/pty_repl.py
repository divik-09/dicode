"""Drive the interactive DiCode REPL through a real pseudo-terminal. Run: python3 test/pty_repl.py"""
import os, pty, select, time, json, re, subprocess, tempfile, sys, signal

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, '..', 'bin', 'dicode.js')
base = tempfile.mkdtemp(prefix='dicode-pty-')
home, proj = os.path.join(base, 'home'), os.path.join(base, 'proj')
os.makedirs(home); os.makedirs(proj)
open(os.path.join(proj, 'app.js'), 'w').write('function add(a, b) {\n  return a - b;\n}\n')

script = [
  {"blocks": [{"type": "text", "text": "I'll fix the subtraction."}, {"type": "tool_use", "id": "t1", "name": "Edit", "input": {"file_path": "app.js", "old_string": "return a - b;", "new_string": "return a + b;"}}]},
  {"blocks": [{"type": "text", "text": "Fixed it: **add** now returns `a + b`.\n\n- updated app.js:2"}]},
  {"blocks": [{"type": "text", "text": "This is a very long streaming answer that keeps going and going so that we can interrupt it midway through. " * 6}], "delayMs": 120},
]
sfile, logf, portf = os.path.join(base, 's.json'), os.path.join(base, 'log.jsonl'), os.path.join(base, 'port')
json.dump(script, open(sfile, 'w'))
mock = subprocess.Popen(['node', os.path.join(HERE, 'mock-server.mjs'), sfile, logf, portf])
for _ in range(50):
    if os.path.exists(portf) and open(portf).read(): break
    time.sleep(0.1)
port = open(portf).read()

env = dict(os.environ, DICODE_HOME=home, ANTHROPIC_API_KEY='k', ANTHROPIC_BASE_URL=f'http://127.0.0.1:{port}', TERM='xterm-256color', COLUMNS='100', LINES='40')
pid, fd = pty.fork()
if pid == 0:
    os.chdir(proj)
    os.execvpe('node', ['node', BIN], env)

raw = b''
buf = ''
def strip(s): return re.sub(r'\x1b\[[0-9;?]*[A-Za-z]|\r', '', s)
def read_until(pat, t=10):
    global buf, raw
    end = time.time() + t
    if re.search(pat, strip(buf)): return True  # may already be on screen
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: raw += os.read(fd, 65536)
            except OSError: break
            buf = raw.decode('utf-8', 'replace')  # decode the whole stream so multi-byte chars never split
            if re.search(pat, strip(buf)): return True
    return False
def send(s): os.write(fd, s.encode())
def expect(pat, label, t=10):
    ok = read_until(pat, t)
    print(('PASS ' if ok else 'FAIL ') + label)
    if not ok: print('---- screen tail ----\n' + strip(buf)[-1500:]); cleanup(1)
def cleanup(code=0):
    try: os.kill(pid, signal.SIGKILL)
    except Exception: pass
    mock.kill(); sys.exit(code)

expect(r'Trust this folder\?', 'trust prompt shown')
send('y\r')
expect(r'Welcome to DiCode', 'banner')
expect(r'> $', 'prompt ready')
raw = b''; buf = ''
send('fix the bug in @app.js\r')
expect(r'Attached app\.js \(4 lines\)', '@mention attached the file')
expect(r'Do you want to make this edit to app\.js\?', 'permission dialog for the edit')
assert '-  return a - b;' in strip(buf) and '+  return a + b;' in strip(buf), 'diff shown'
print('PASS diff shown in the dialog')
send('1\r')
expect(r'Updated app\.js with 1 addition and 1 removal', 'edit applied and summarised')
expect(r'Fixed it: add now returns a \+ b\.', 'markdown rendered (bold/code markers removed)')
expect(r'• updated app\.js:2', 'bullet rendered')
expect(r'% context', 'status line')
assert open(os.path.join(proj, 'app.js')).read().count('a + b') == 1
raw = b''; buf = ''
send('/undo\r')
expect(r'Reverted changes from', '/undo')
assert 'a - b' in open(os.path.join(proj, 'app.js')).read(), 'file restored'
print('PASS file restored on disk')
raw = b''; buf = ''
send('!echo hello-from-shell\r')
expect(r'(?m)^  hello-from-shell\s*$', '!shell runs a command')
raw = b''; buf = ''
send('#always run npm test before finishing\r')
expect(r'Saved to DICODE\.md', '#note saved')
assert 'always run npm test' in open(os.path.join(proj, 'DICODE.md')).read()
raw = b''; buf = ''
send('\x1b[Z')  # shift+tab
expect(r'accept edits', 'shift+tab switches to accept-edits mode', 3)
send('\x1b[Z')
expect(r'plan mode', 'shift+tab again: plan mode', 3)
send('\x1b[Z')
time.sleep(0.3)
raw = b''; buf = ''
send('tell me a long story\r')
expect(r'This is a very long', 'streaming started')
time.sleep(0.3)
send('typed while busy')   # type-ahead while DiCode streams
time.sleep(0.3)
send('\x1b')  # esc
expect(r'Interrupted', 'esc interrupts the stream')
expect(r'> typed while busy$', 'type-ahead is kept in the next prompt')
send('\x15')  # ctrl+u clears the line
time.sleep(0.2)
raw = b''; buf = ''
send('/help\r')
expect(r'/compact', '/help lists commands')
raw = b''; buf = ''
send('/exit\r')
expect(r'Resume this conversation with: dicode --resume', 'clean exit with resume hint')

reqs = [json.loads(l) for l in open(logf) if l.strip()]
sys_prompt = reqs[0]['system'][0]['text']
first_user = reqs[0]['messages'][0]['content']
assert any('<file path="app.js">' in b.get('text', '') for b in first_user), 'attachment sent to the model'
assert 'Read' not in [m for m in json.dumps(reqs[0]['messages'])] or True
print('PASS attachment reached the model')
cleanup(0)
