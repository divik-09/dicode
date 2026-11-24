import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { homeDir } from '../config.js';
import { c, out } from './term.js';

/** Keystrokes typed while DiCode was busy; replayed into the next prompt. */
let typeahead = '';

/** Line input with history, paste coalescing, "\" continuation, double Ctrl+C to exit and Shift+Tab hooks. */
export class Prompter {
  constructor({ completer, onShiftTab } = {}) {
    this.file = path.join(homeDir(), 'history');
    try { this.history = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).reverse().slice(0, 500); } catch { this.history = []; }
    this.completer = completer;
    this.onShiftTab = onShiftTab;
    this.lastCtrlC = 0;
  }

  saveHistory(entry) {
    if (!entry || entry.includes('\n')) return;
    this.history = [entry, ...this.history.filter((h) => h !== entry)].slice(0, 500);
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, [...this.history].reverse().join('\n') + '\n', { mode: 0o600 }); } catch {}
  }

  prompt(getPrompt) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY,
        history: this.history.slice(), historySize: 500, removeHistoryDuplicates: true, completer: this.completer, tabSize: 2,
      });
      const lines = [];
      let timer = null, done = false;
      const keypress = (_s, key) => {
        if (key?.name === 'tab' && key.shift && this.onShiftTab) { this.onShiftTab(); rl.setPrompt(getPrompt()); rl.prompt(true); }
      };
      const finish = (val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        process.stdin.off('keypress', keypress);
        rl.close();
        if (val) this.saveHistory(val.trim());
        resolve(val);
      };
      process.stdin.on('keypress', keypress);
      rl.on('line', (l) => {
        if (l.endsWith('\\')) { lines.push(l.slice(0, -1)); rl.setPrompt(c.dim('  … ')); rl.prompt(); return; }
        lines.push(l);
        clearTimeout(timer);
        // Pasted text arrives as several lines within a few ms: treat it as one message.
        timer = setTimeout(() => finish(lines.join('\n')), process.stdin.isTTY ? 30 : 0);
      });
      rl.on('SIGINT', () => {
        if (rl.line) { rl.write(null, { ctrl: true, name: 'e' }); rl.write(null, { ctrl: true, name: 'u' }); return; }
        if (Date.now() - this.lastCtrlC < 2000) { out('\n'); finish(null); return; }
        this.lastCtrlC = Date.now();
        out(`\n${c.dim('(press Ctrl+C again to exit)')}\n`);
        rl.prompt();
      });
      rl.on('close', () => { if (!done) { done = true; process.stdin.off('keypress', keypress); resolve(lines.length ? lines.join('\n') : null); } });
      rl.setPrompt(getPrompt());
      rl.prompt();
      if (typeahead) { const t = typeahead; typeahead = ''; rl.write(t); }
    });
  }

  /** One-off question (permission prompts). Ctrl+C or Esc returns null. */
  question(q) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
      let done = false;
      const end = (v) => { if (done) return; done = true; process.stdin.off('keypress', esc); rl.close(); resolve(v); };
      const esc = (_s, key) => { if (key?.name === 'escape') { out('\n'); end(null); } };
      process.stdin.on('keypress', esc);
      rl.on('SIGINT', () => { out('\n'); end(null); });
      rl.on('close', () => end(null));
      rl.question(q, (a) => end(a));
    });
  }
}

/** While the agent works, listen for Esc / Ctrl+C. Returns a function that stops listening. */
export function watchInterrupt(onInterrupt) {
  if (!process.stdin.isTTY) {
    const h = () => onInterrupt();
    process.on('SIGINT', h);
    return () => process.off('SIGINT', h);
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const onData = (d) => {
    const s = d.toString();
    if (s === '\x03' || s === '\x1b') onInterrupt();
    else typeahead += s; // keep what the user types ahead
  };
  process.stdin.on('data', onData);
  return () => {
    process.stdin.off('data', onData);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
  };
}
