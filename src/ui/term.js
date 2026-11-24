/** Terminal styling and streaming markdown, with no dependencies. */
const enabled = () => process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (open, close) => (s) => (enabled() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: sgr(1, 22), dim: sgr(2, 22), italic: sgr(3, 23), underline: sgr(4, 24), inverse: sgr(7, 27),
  red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), blue: sgr(34, 39), magenta: sgr(35, 39), cyan: sgr(36, 39), gray: sgr(90, 39),
  orange: (s) => (enabled() ? `\x1b[38;5;208m${s}\x1b[39m` : String(s)),
  bgRed: sgr(41, 49), bgGreen: sgr(42, 49),
};
export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
export const width = () => Math.max(40, Math.min(process.stdout.columns || 100, 160));
export const out = (s = '') => process.stdout.write(s);
export const line = (s = '') => process.stdout.write(s + '\n');

export function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, (_, x) => c.cyan(x))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, x) => c.bold(x))
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, p, x) => p + c.italic(x));
}

export function formatLine(l, state) {
  const fence = /^\s*```(\w*)/.exec(l);
  if (fence) { state.code = !state.code; return c.dim(state.code ? `  ┌ ${fence[1] || 'code'}` : '  └'); }
  if (state.code) return c.dim('  │ ') + c.cyan(l);
  const h = /^(#{1,6})\s+(.*)$/.exec(l);
  if (h) return c.bold(h[1].length <= 2 ? c.underline(h[2]) : h[2]);
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(l);
  if (bullet) return `${bullet[1]}• ${inline(bullet[2])}`;
  const num = /^(\s*)(\d+)\.\s+(.*)$/.exec(l);
  if (num) return `${num[1]}${num[2]}. ${inline(num[3])}`;
  if (/^\s*>\s?/.test(l)) return c.dim('│ ') + c.italic(l.replace(/^\s*>\s?/, ''));
  return inline(l);
}

/**
 * Streams model text: each chunk is printed immediately; when a line completes it is re-drawn with
 * formatting (only if it fits on one terminal row, so the rewrite never corrupts wrapped output).
 */
export class MarkdownStream {
  constructor() { this.reset(); }
  reset() { this.buf = ''; this.state = { code: false }; this.first = true; this.atStart = true; this.prefix = ''; }
  get active() { return !this.first; }
  write(text) {
    text.split('\n').forEach((seg, i) => {
      if (i > 0) this.finishLine();
      if (!seg) return;
      if (this.atStart) { this.prefix = this.first ? c.orange('⏺ ') : '  '; out(this.prefix); this.atStart = false; this.first = false; }
      this.buf += seg;
      out(seg);
    });
  }
  finishLine() {
    if (this.atStart) { if (!this.first) out('\n'); return; } // blank line (leading blanks skipped)
    const formatted = formatLine(this.buf, this.state);
    if (process.stdout.isTTY && stripAnsi(this.prefix).length + this.buf.length < width()) out(`\r\x1b[2K${this.prefix}${formatted}`);
    out('\n');
    this.buf = '';
    this.atStart = true;
  }
  end() {
    if (!this.atStart) this.finishLine();
    this.reset();
  }
}

const FRAMES = ['✻', '✺', '✹', '✸', '✷', '✶', '✵', '✶', '✷', '✸', '✹', '✺'];
const VERBS = ['Thinking', 'Pondering', 'Working', 'Reasoning', 'Cooking', 'Crafting', 'Tinkering'];

export class Spinner {
  constructor() { this.timer = null; this.label = ''; this.tokens = 0; }
  start(label) {
    if (!process.stdout.isTTY) return;
    this.label = label || VERBS[Math.floor(Math.random() * VERBS.length)];
    this.t0 = Date.now();
    if (this.timer) return;
    let i = 0;
    this.timer = setInterval(() => this.draw(i++), 100);
    this.draw(0);
  }
  draw(i) {
    const secs = Math.floor((Date.now() - this.t0) / 1000);
    const toks = this.tokens ? ` · ↓ ${this.tokens >= 1000 ? (this.tokens / 1000).toFixed(1) + 'k' : this.tokens} tokens` : '';
    out(`\r\x1b[2K${c.orange(FRAMES[i % FRAMES.length])} ${c.orange(this.label + '…')} ${c.dim(`(${secs}s${toks} · esc to interrupt)`)}`);
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    out('\r\x1b[2K');
  }
  get active() { return !!this.timer; }
}

export function renderDiff(diffText, { max = 24, indent = '    ' } = {}) {
  const lines = diffText.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
  const shown = lines.slice(0, max).map((l) => {
    if (l.startsWith('@@')) return indent + c.dim(l);
    if (l.startsWith('+')) return indent + c.green(l);
    if (l.startsWith('-')) return indent + c.red(l);
    return indent + c.dim(l);
  });
  if (lines.length > max) shown.push(indent + c.dim(`… ${lines.length - max} more diff lines`));
  return shown.join('\n');
}

export function box(title, body, color = c.dim) {
  const w = Math.min(width() - 2, 100);
  const top = color('╭─ ') + c.bold(title) + ' ' + color('─'.repeat(Math.max(2, w - stripAnsi(title).length - 4)));
  const mid = String(body).split('\n').map((l) => color('│ ') + l);
  return [top, ...mid, color('╰' + '─'.repeat(w - 1))].join('\n');
}
