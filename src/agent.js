import path from 'node:path';
import { callModel } from './providers/index.js';
import { isAbort } from './providers/errors.js';
import { toolsFor, schemas, isConcurrent } from './tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { runHooks, hasHooks } from './hooks.js';
import { createCheckpoints } from './checkpoints.js';
import { killAllBackground } from './tools/bash.js';
import { isReadOnlyCommand, EDIT_TOOLS } from './permissions.js';
import { estimateTokens, truncateMiddle } from './util.js';

const COMPACT_SYSTEM = `You are summarizing a software engineering session between a user and an AI coding agent so the work can continue in a fresh context window.
Write a precise summary with these sections:
1. Primary request and intent: everything the user asked for, including constraints and preferences.
2. Key technical context: languages, frameworks, conventions, commands (test/build/lint), decisions made.
3. Files and code: each file read or changed, what changed and why; include short critical snippets.
4. Errors and fixes: problems hit and how they were resolved; any user corrections.
5. Pending tasks: what is still left to do.
6. Current work: exactly what was being done immediately before this summary.
7. Next step: the single next action, consistent with the user's latest request.
Be specific (file paths, function names). No preamble.`;

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const textOf = (c) => (typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
const appendText = (content, extra) => (typeof content === 'string' ? content + extra : [...content, { type: 'text', text: extra }]);
const apiMessages = (messages) => messages.map(({ role, content }) => ({ role, content }));
const clean = (b) => { if (b.type !== 'tool_use') return b; const { _partial, ...rest } = b; return rest; };

function normalizeOutput(out) {
  if (out && typeof out === 'object' && 'text' in out) {
    const content = [{ type: 'text', text: truncateMiddle(String(out.text), 100000) || '(no output)' }];
    if (out.image) content.push({ type: 'image', source: { type: 'base64', media_type: out.image.mediaType, data: out.image.data } });
    return content.length === 1 ? content[0].text : content;
  }
  const s = typeof out === 'string' ? out : JSON.stringify(out ?? '');
  return truncateMiddle(s, 100000) || '(no output)';
}

function renderTranscript(messages) {
  const lines = [];
  for (const m of messages) {
    const who = m.role === 'user' ? 'USER' : 'ASSISTANT';
    if (typeof m.content === 'string') { lines.push(`${who}: ${m.content}`); continue; }
    for (const b of m.content) {
      if (b.type === 'text') lines.push(`${who}: ${b.text}`);
      else if (b.type === 'tool_use') lines.push(`TOOL CALL ${b.name} ${JSON.stringify(b.input).slice(0, 1500)}`);
      else if (b.type === 'tool_result') lines.push(`TOOL RESULT${b.is_error ? ' (error)' : ''}: ${(Array.isArray(b.content) ? b.content.map((x) => x.text || '[image]').join(' ') : String(b.content)).slice(0, 2500)}`);
    }
  }
  return lines.join('\n').slice(-250000);
}

/** Restrict a permission engine to read-only behaviour for explore sub-agents. Never asks the user. */
function readOnlyPermissions(base) {
  return {
    ...base,
    get mode() { return 'default'; },
    setMode() {},
    check(tool, input) {
      const r = base.check(tool, input);
      if (r.behavior === 'deny') return r;
      if (EDIT_TOOLS.has(tool)) return { behavior: 'deny', reason: 'explore sub-agents are read-only' };
      if (tool === 'Bash' && !isReadOnlyCommand(input.command || '')) return { behavior: 'deny', reason: 'explore sub-agents may only run read-only commands' };
      return r.behavior === 'ask' ? { behavior: 'deny', reason: `${r.reason} (sub-agents cannot ask for permission)` } : r;
    },
  };
}

export class Agent {
  constructor({ settings, root, permissions, session = null, ui = {}, model, subagent = null, checkpoints, messages = [] }) {
    this.settings = settings;
    this.root = root;
    this.permissions = permissions;
    this.session = session;
    this.ui = ui;
    this.subagent = subagent;
    this.model = model || settings.model;
    this.messages = messages;
    this.checkpoints = checkpoints || createCheckpoints();
    this.readFiles = new Map();
    this.todos = [];
    this.background = new Map();
    this.shell = { cwd: root };
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0, costKnown: true };
    this.contextTokens = estimateTokens(messages);
    this.system = null;
    this.systemKey = '';
    this.controller = null;
    this.inflight = null;
  }

  emit(ev) { try { this.ui.onEvent?.(ev); } catch {} }
  get running() { return !!this.controller; }
  get refs() { return [...new Set([this.model, ...(this.settings.fallbackModels || [])])]; }
  abort() { this.controller?.abort(); }
  tools() { return toolsFor({ mode: this.permissions.mode, subagent: this.subagent, settings: this.settings }); }
  invalidatePrompt() { this.system = null; }

  systemPrompt() {
    const key = `${this.permissions.mode}|${this.model}`;
    if (!this.system || this.systemKey !== key) {
      this.system = buildSystemPrompt({ root: this.root, mode: this.permissions.mode, model: this.model, subagent: this.subagent });
      this.systemKey = key;
    }
    return this.system;
  }

  push(m) { this.messages.push(m); this.session?.append(m); }

  addUsage(u, ref) {
    this.usage.input += u.input; this.usage.output += u.output; this.usage.cacheRead += u.cacheRead || 0; this.usage.cacheWrite += u.cacheWrite || 0; this.usage.calls++;
    const p = this.settings.pricing?.[ref];
    if (p) this.usage.cost += (u.input * p.input + u.output * p.output + (u.cacheRead || 0) * (p.cacheRead ?? p.input * 0.1) + (u.cacheWrite || 0) * (p.cacheWrite ?? p.input * 1.25)) / 1e6;
    else this.usage.costKnown = false;
    this.contextTokens = u.input + (u.cacheRead || 0) + (u.cacheWrite || 0) + u.output;
    this.emit({ type: 'usage', usage: { ...this.usage }, contextTokens: this.contextTokens });
  }

  ctx(signal) {
    return {
      root: this.root, settings: this.settings, shell: this.shell, readFiles: this.readFiles, checkpoints: this.checkpoints,
      todos: this.todos, background: this.background, permissions: this.permissions, signal,
      emit: (e) => this.emit(e),
      runSubagent: this.subagent ? null : (i) => this.runSubagent(i, signal),
      approvePlan: (plan) => this.approvePlan(plan),
      summarize: (prompt) => this.quickText(prompt, signal),
    };
  }

  async quickText(prompt, signal) {
    const r = await callModel({ settings: { ...this.settings, thinking: { enabled: false } }, refs: this.refs, system: 'Extract exactly what is asked, concisely and accurately.', messages: [{ role: 'user', content: prompt }], tools: [], signal });
    this.addUsage(r.usage, r.modelUsed);
    return textOf(r.content);
  }

  async approvePlan(plan) {
    const r = this.ui.approvePlan ? await this.ui.approvePlan(plan) : { approved: false, feedback: 'Plans cannot be approved in this context. Stop and present the plan as your final answer.' };
    if (r.approved) { this.permissions.setMode(r.mode || 'default'); this.invalidatePrompt(); }
    return r;
  }

  async runSubagent({ prompt, subagent_type = 'explore', description = '' }, signal) {
    const sub = new Agent({
      settings: this.settings, root: this.root, model: this.model, subagent: subagent_type, checkpoints: this.checkpoints,
      permissions: subagent_type === 'explore' ? readOnlyPermissions(this.permissions) : this.permissions,
      ui: { onEvent: (event) => this.emit({ type: 'subagent', description, event }), askPermission: this.ui.askPermission },
    });
    try {
      const r = await sub.run(prompt, { signal });
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost', 'calls']) this.usage[k] += sub.usage[k];
      if (!sub.usage.costKnown) this.usage.costKnown = false;
      if (r.error) throw r.error;
      return r.text || '(the sub-agent finished without a report)';
    } finally { killAllBackground(sub.background); }
  }

  /** Close any tool calls left without results (crash/interrupt) so the transcript stays valid. */
  closeDangling() {
    const last = this.messages.at(-1);
    if (last?.role !== 'assistant' || !Array.isArray(last.content)) return;
    const calls = last.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) return;
    const done = this.inflight?.results || new Map();
    this.push({ role: 'user', content: calls.map((c) => done.get(c.id) || { type: 'tool_result', tool_use_id: c.id, content: 'Interrupted by the user before this finished.', is_error: true }) });
  }

  async run(input, opts = {}) {
    if (this.controller) throw new Error('DiCode is already working on something');
    const controller = (this.controller = new AbortController());
    const signal = controller.signal;
    if (opts.signal) { if (opts.signal.aborted) controller.abort(); else opts.signal.addEventListener('abort', () => controller.abort(), { once: true }); }
    const result = { text: '', interrupted: false, steps: 0, error: null };
    let partial = '';
    try {
      let content = input;
      if (!this.subagent && hasHooks(this.settings, 'UserPromptSubmit')) {
        const h = await runHooks(this.settings, 'UserPromptSubmit', { prompt: textOf(input), session_id: this.session?.id }, { cwd: this.root, signal });
        h.warnings.forEach((w) => this.emit({ type: 'notice', level: 'warn', text: w }));
        if (h.blocked) { result.blocked = h.messages.join('\n'); this.emit({ type: 'notice', level: 'error', text: `Prompt blocked by hook: ${result.blocked}` }); return result; }
        if (h.messages.length) content = appendText(content, `\n\n<hook-context>\n${h.messages.join('\n')}\n</hook-context>`);
      }
      this.checkpoints.begin(textOf(input));
      this.push({ role: 'user', content });
      let continuations = 0, overflowRetried = false, stopBlocks = 0;

      for (let step = 0; step < this.settings.maxSteps; step++) {
        result.steps = step + 1;
        if (signal.aborted) throw abortError();
        if (this.contextTokens > this.settings.autoCompactTokens) await this.compact(null, { auto: true, signal });
        partial = '';
        let resp;
        try {
          resp = await callModel({
            settings: this.settings, refs: this.refs, system: this.systemPrompt(), messages: apiMessages(this.messages), tools: schemas(this.tools()), signal,
            onText: (t) => { partial += t; this.emit({ type: 'text', text: t }); },
            onThinking: (t) => this.emit({ type: 'thinking', text: t }),
            onRetry: (r) => this.emit({ type: 'retry', ...r }),
          });
        } catch (e) {
          if (e.contextOverflow && !overflowRetried) { overflowRetried = true; await this.compact(null, { auto: true, signal }); continue; }
          throw e;
        }
        this.addUsage(resp.usage, resp.modelUsed);
        const blocks = resp.content.filter((b) => !(b.type === 'tool_use' && b._partial)).map(clean);
        if (blocks.length) this.push({ role: 'assistant', content: blocks });
        partial = '';
        const said = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (said) result.text = said;
        this.emit({ type: 'step_end', stopReason: resp.stopReason });

        const calls = blocks.filter((b) => b.type === 'tool_use');
        const truncated = resp.stopReason === 'max_tokens';
        if (!calls.length && !truncated) {
          if (!this.subagent && stopBlocks < 3 && hasHooks(this.settings, 'Stop')) {
            const h = await runHooks(this.settings, 'Stop', { session_id: this.session?.id, last_message: said }, { cwd: this.root, signal });
            h.warnings.forEach((w) => this.emit({ type: 'notice', level: 'warn', text: w }));
            if (h.blocked) {
              stopBlocks++;
              this.emit({ type: 'notice', text: `Stop hook asked to continue: ${h.messages.join(' ').slice(0, 300)}` });
              this.push({ role: 'user', content: `[Stop hook] ${h.messages.join('\n')}` });
              continue;
            }
          }
          break;
        }
        const userContent = calls.length ? await this.runTools(calls, signal) : [];
        if (truncated) {
          if (++continuations > 3) { if (userContent.length) this.push({ role: 'user', content: userContent }); result.text += '\n[stopped: the output limit was hit repeatedly]'; break; }
          userContent.push({ type: 'text', text: '[Your last response hit the output token limit and was cut off. Continue exactly where you stopped. Write large files in several smaller Write/Edit calls.]' });
        }
        this.push({ role: 'user', content: userContent });
        if (signal.aborted) throw abortError();
        if (step === this.settings.maxSteps - 1) result.text += '\n[stopped: reached the step limit; say "continue" to keep going]';
      }
    } catch (e) {
      if (isAbort(e) || signal.aborted) {
        result.interrupted = true;
        this.closeDangling();
        if (partial) this.push({ role: 'assistant', content: [{ type: 'text', text: `${partial}\n[interrupted by user]` }] });
        this.emit({ type: 'interrupted' });
      } else {
        result.error = e;
        this.closeDangling();
        this.emit({ type: 'error', message: e.message });
      }
    } finally {
      this.controller = null;
      this.inflight = null;
    }
    this.emit({ type: 'done', result });
    return result;
  }

  async runTools(calls, signal) {
    const ctx = this.ctx(signal);
    const tools = this.tools();
    const plans = calls.map((call) => ({ call, tool: tools.find((t) => t.name === call.name) }));
    this.inflight = { results: new Map() };
    const parallel = plans.length > 1 && plans.every(({ call, tool }) => tool && isConcurrent(tool, call.input || {})
      && this.permissions.check(call.name, call.input || {}).behavior === 'allow'
      && !hasHooks(this.settings, 'PreToolUse', call.name) && !hasHooks(this.settings, 'PostToolUse', call.name));
    if (parallel) await Promise.all(plans.map((p) => this.execOne(p, ctx)));
    else for (const p of plans) { if (signal.aborted) break; await this.execOne(p, ctx); }
    const results = this.inflight.results;
    return calls.map((c) => results.get(c.id) || { type: 'tool_result', tool_use_id: c.id, content: 'Interrupted by the user before this ran.', is_error: true });
  }

  async execOne({ call, tool }, ctx) {
    const input = call.input || {};
    const done = (content, isError = false) => {
      const block = { type: 'tool_result', tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) };
      this.inflight?.results.set(call.id, block);
      this.emit({ type: 'tool_end', id: call.id, name: call.name, input, ok: !isError, output: typeof content === 'string' ? content : textOf(content) });
      return block;
    };
    this.emit({ type: 'tool_start', id: call.id, name: call.name, input, summary: tool?.summary?.(input) ?? '' });
    if (!tool) return done(`Error: unknown tool "${call.name}". Available tools: ${this.tools().map((t) => t.name).join(', ')}`, true);
    const missing = (tool.input_schema.required || []).filter((k) => input[k] === undefined);
    if (missing.length) return done(`Error: missing required parameter(s): ${missing.join(', ')}`, true);

    if (hasHooks(this.settings, 'PreToolUse', call.name)) {
      const h = await runHooks(this.settings, 'PreToolUse', { tool_name: call.name, tool_input: input, session_id: this.session?.id }, { cwd: this.root, matchValue: call.name, signal: ctx.signal });
      h.warnings.forEach((w) => this.emit({ type: 'notice', level: 'warn', text: w }));
      if (h.blocked) return done(`Blocked by a PreToolUse hook:\n${h.messages.join('\n')}`, true);
    }

    const decision = this.permissions.check(call.name, input);
    if (decision.behavior === 'deny') return done(`Permission denied: ${decision.reason}`, true);
    if (decision.behavior === 'ask') {
      let preview = null;
      if (tool.preview) { try { preview = tool.preview(input, ctx); } catch (e) { return done(`Error: ${e.message}`, true); } }
      const ans = this.ui.askPermission
        ? await this.ui.askPermission({ tool: call.name, input, preview, reason: decision.reason, summary: tool.summary?.(input) || '', cwd: this.shell.cwd })
        : { decision: 'deny', headless: true };
      if (ctx.signal.aborted) return done('Interrupted by the user.', true);
      if (ans.decision === 'deny') {
        return done(ans.headless
          ? `Permission for ${call.name} was not granted (non-interactive run). The user can allow it with --allowedTools or a permissions rule.`
          : `The user declined this ${call.name} call.${ans.feedback ? ` Their feedback: "${ans.feedback}"` : ''} Do not retry it unchanged; adjust your approach or ask the user what they want.`, true);
      }
      if (ans.decision === 'always') this.emit({ type: 'notice', text: `Permission: ${this.permissions.always(call.name, input)}` });
    }

    let out, isError = false;
    try { out = await tool.run(input, ctx); } catch (e) { out = `Error: ${e.message}`; isError = true; }
    if (out && typeof out === 'object' && out.isError) isError = true;
    let content = normalizeOutput(out);

    if (hasHooks(this.settings, 'PostToolUse', call.name)) {
      const h = await runHooks(this.settings, 'PostToolUse', { tool_name: call.name, tool_input: input, tool_response: typeof content === 'string' ? content.slice(0, 20000) : textOf(content), session_id: this.session?.id }, { cwd: this.root, matchValue: call.name, signal: ctx.signal });
      h.warnings.forEach((w) => this.emit({ type: 'notice', level: 'warn', text: w }));
      if (h.blocked) content = appendText(content, `\n\n[PostToolUse hook feedback]\n${h.messages.join('\n')}`);
    }
    return done(content, isError);
  }

  async compact(instructions = null, { auto = false, signal } = {}) {
    if (this.messages.length < 2) return null;
    this.emit({ type: 'compacting', auto });
    const r = await callModel({
      settings: { ...this.settings, thinking: { enabled: false } }, refs: this.refs, system: COMPACT_SYSTEM, tools: [], signal,
      messages: [{ role: 'user', content: `${renderTranscript(this.messages)}\n\n${instructions ? `Extra focus for the summary: ${instructions}\n` : ''}Write the summary now.` }],
    });
    this.addUsage(r.usage, r.modelUsed);
    const summary = textOf(r.content).trim();
    if (!summary) throw new Error('Compaction produced an empty summary');
    const todos = this.todos.length ? `\n\nTodo list at the time:\n${this.todos.map((t) => `- [${t.status}] ${t.content}`).join('\n')}` : '';
    const files = [...this.readFiles.keys()].slice(-15).map((f) => path.relative(this.root, f)).join(', ');
    const note = auto
      ? `This session continues from an earlier conversation that was compacted to free up context.\n\n<summary>\n${summary}\n</summary>${todos}${files ? `\n\nFiles read recently: ${files}` : ''}\n\nContinue the task from where it left off without asking the user to repeat anything. Read files again before editing them.`
      : `<summary of the earlier conversation>\n${summary}\n</summary>${todos}`;
    this.messages = [{ role: 'user', content: note }];
    if (!auto) this.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Understood. I have the context from the summary.' }] });
    this.session?.replace(this.messages);
    this.readFiles.clear(); // force a fresh Read before any edit
    this.contextTokens = estimateTokens(this.messages);
    this.emit({ type: 'compacted', auto, summary });
    return summary;
  }

  clear() {
    this.messages = [];
    this.todos.splice(0);
    this.readFiles.clear();
    this.contextTokens = 0;
    this.invalidatePrompt();
  }

  dispose() { killAllBackground(this.background); }
}
