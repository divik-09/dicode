import { c, out, line, MarkdownStream, Spinner, renderDiff, width } from './term.js';

const firstLines = (s, n) => {
  const lines = String(s).replace(/\s+$/, '').split('\n');
  const shown = lines.slice(0, n).map((l) => (l.length > width() - 8 ? l.slice(0, width() - 9) + '…' : l));
  return { shown, more: Math.max(0, lines.length - n) };
};
const branch = (text, color = c.dim) => `  ${c.dim('⎿')}  ${color(text)}`;
const cont = (text, color = c.dim) => `     ${color(text)}`;

export function renderTodos(todos) {
  return todos.map((t, i) => {
    const mark = t.status === 'completed' ? c.green('☒') : t.status === 'in_progress' ? c.orange('◼') : '☐';
    const text = t.status === 'completed' ? c.dim(t.content) : t.status === 'in_progress' ? c.bold(t.content) : t.content;
    return `${i === 0 ? `  ${c.dim('⎿')}  ` : '     '}${mark} ${text}`;
  }).join('\n');
}

/** Turns agent events into terminal output. */
export class Renderer {
  constructor({ verbose = false } = {}) {
    this.md = new MarkdownStream();
    this.spin = new Spinner();
    this.verbose = verbose;
    this.diffs = [];
    this.thinking = '';
  }
  pause() { this.md.end(); this.spin.stop(); }
  start() { this.spin.start(); }

  onEvent(ev) {
    switch (ev.type) {
      case 'text': this.spin.stop(); this.md.write(ev.text); break;
      case 'thinking':
        this.thinking += ev.text;
        if (!this.md.active) this.spin.start('Thinking');
        break;
      case 'step_end':
        this.md.end();
        if (this.verbose && this.thinking) { line(c.dim(c.italic(`✻ ${this.thinking.trim().split('\n').join('\n  ')}`))); }
        this.thinking = '';
        this.spin.start();
        break;
      case 'tool_start': {
        this.pause();
        this.diffs = [];
        const label = ev.summary ? `${c.bold(ev.name)}${c.dim('(')}${ev.summary}${c.dim(')')}` : c.bold(ev.name);
        if (ev.name !== 'TodoWrite' && ev.name !== 'ExitPlanMode') line(`${c.green('⏺')} ${label}`);
        this.spin.start(ev.name === 'Bash' ? 'Running' : ev.name === 'Task' ? 'Delegating' : 'Working');
        break;
      }
      case 'file_change': this.diffs.push(ev); break;
      case 'tool_end': this.spin.stop(); this.toolResult(ev); this.spin.start(); break;
      case 'todos': this.spin.stop(); line(`${c.green('⏺')} ${c.bold('Update Todos')}`); line(renderTodos(ev.todos)); this.spin.start(); break;
      case 'subagent': {
        const e = ev.event;
        if (e.type === 'tool_start') { this.spin.stop(); line(cont(`↳ ${e.name}${e.summary ? `(${e.summary})` : ''}`)); this.spin.start('Delegating'); }
        break;
      }
      case 'notice': this.spin.stop(); line((ev.level === 'error' ? c.red : ev.level === 'warn' ? c.yellow : c.dim)(`  ${ev.text}`)); this.spin.start(); break;
      case 'retry': this.spin.label = `Retrying (attempt ${ev.attempt}, ${ev.error.split(':')[0]})`; break;
      case 'compacting': this.pause(); line(c.dim(ev.auto ? '✻ Context is getting full; compacting the conversation…' : '✻ Compacting the conversation…')); this.spin.start('Compacting'); break;
      case 'compacted': this.spin.stop(); line(c.dim('  ⎿  Compacted. Earlier details are kept as a summary.')); break;
      case 'usage': this.spin.tokens = ev.usage.output; break;
      case 'error': this.pause(); line(c.red(`✗ ${ev.message.split('\n').join('\n  ')}`)); break;
      case 'interrupted': this.pause(); line(branch('Interrupted · tell DiCode what to do instead', c.yellow)); break;
      case 'done': this.pause(); break;
    }
  }

  toolResult(ev) {
    const o = ev.output || '';
    if (ev.name === 'TodoWrite' || ev.name === 'ExitPlanMode') { if (!ev.ok) line(branch(o.split('\n')[0], c.yellow)); return; }
    if (!ev.ok) {
      const { shown, more } = firstLines(o.replace(/^Error: /, ''), 4);
      const color = /declined|denied|not granted/i.test(o) ? c.yellow : c.red;
      shown.forEach((l, i) => line(i ? cont(l, color) : branch(l, color)));
      if (more) line(cont(`… +${more} lines`));
      return;
    }
    switch (ev.name) {
      case 'Read': line(branch(/^Image /.test(o) ? 'Read image' : `Read ${(o.match(/^\s*\d+\t/gm) || []).length} lines`)); break;
      case 'Edit': case 'MultiEdit': case 'Write': {
        const d = this.diffs[0];
        if (!d) { line(branch(o.split('\n')[0])); break; }
        line(branch(d.created ? `Created ${c.bold(d.file)} with ${d.added} lines` : `Updated ${c.bold(d.file)} with ${c.green(`${d.added} addition${d.added === 1 ? '' : 's'}`)} and ${c.red(`${d.removed} removal${d.removed === 1 ? '' : 's'}`)}`));
        if (!d.created && d.text) line(renderDiff(d.text, { max: 16, indent: '     ' }));
        break;
      }
      case 'Bash': case 'BashOutput': {
        const { shown, more } = firstLines(o, 5);
        shown.forEach((l, i) => line(i ? cont(l) : branch(l)));
        if (more) line(cont(`… +${more} lines`));
        break;
      }
      case 'Grep': line(branch(/^No matches/.test(o) ? 'No matches' : `Found ${o.split('\n').filter((l) => l && !l.startsWith('…') && l !== '--').length} results`)); break;
      case 'Glob': line(branch(/^No files/.test(o) ? 'No files' : `Found ${o.split('\n').filter((l) => l && !l.startsWith('…')).length} files`)); break;
      case 'LS': line(branch(`Listed ${Math.max(0, o.split('\n').length - 1)} paths`)); break;
      case 'WebSearch': line(branch(`${(o.match(/^\d+\. /gm) || []).length} results`)); break;
      case 'WebFetch': line(branch(o.split('\n')[0].replace(/^\[|\]$/g, ''))); break;
      case 'Task': { const { shown } = firstLines(o, 2); line(branch(`Done · ${shown.join(' ').slice(0, width() - 20)}`)); break; }
      default: line(branch(o.split('\n')[0].slice(0, width() - 8)));
    }
  }
}
