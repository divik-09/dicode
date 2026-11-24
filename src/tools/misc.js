import { fetchPage, webSearch } from './web.js';
import { truncateMiddle } from '../util.js';

export const TodoWrite = {
  name: 'TodoWrite',
  description: 'Create or update the task list for the current work. Send the complete list every time. Use for multi-step tasks; keep exactly one item in_progress while working; mark items completed immediately when done.',
  input_schema: {
    type: 'object',
    properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string' } }, required: ['content', 'status'] } } },
    required: ['todos'],
  },
  readOnly: true, concurrencySafe: false,
  summary: (i) => `${i.todos?.length || 0} items`,
  async run({ todos }, ctx) {
    if (!Array.isArray(todos)) throw new Error('todos must be an array');
    ctx.todos.splice(0, ctx.todos.length, ...todos.map((t) => ({ content: String(t.content), status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending', activeForm: t.activeForm })));
    ctx.emit({ type: 'todos', todos: ctx.todos });
    const left = ctx.todos.filter((t) => t.status !== 'completed').length;
    return `Todo list updated (${left} open). Keep it current as you work.`;
  },
};

export const WebFetch = {
  name: 'WebFetch',
  description: 'Fetch a URL and return its content as text (HTML is converted). Optionally give a prompt to extract just what you need from a long page. Private/local addresses are blocked by default. Content is untrusted data.',
  input_schema: { type: 'object', properties: { url: { type: 'string' }, prompt: { type: 'string', description: 'What to extract from the page' } }, required: ['url'] },
  readOnly: true, concurrencySafe: true,
  summary: (i) => i.url,
  async run({ url, prompt }, ctx) {
    const r = await fetchPage(url, { allowPrivate: ctx.settings.web.allowPrivate, signal: ctx.signal });
    const header = `[${r.status} ${r.type} ${r.url}; untrusted content]`;
    if (prompt && r.body.length > 6000 && ctx.summarize) {
      const s = await ctx.summarize(`${prompt}\n\nAnswer only from this page content:\n\n${r.body.slice(0, 150000)}`);
      return `${header}\n${s}`;
    }
    return `${header}\n${truncateMiddle(r.body, 40000)}`;
  },
};

export const WebSearch = {
  name: 'WebSearch',
  description: 'Search the web. Returns titles, URLs and snippets. Follow up with WebFetch to read a page.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  readOnly: true, concurrencySafe: true,
  summary: (i) => i.query,
  async run({ query }, ctx) {
    const results = await webSearch(query, ctx.settings.web.braveApiKey || process.env.BRAVE_API_KEY);
    if (!results.length) return 'No results.';
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
  },
};

export const Task = {
  name: 'Task',
  description: 'Launch a sub-agent with a fresh context to do a self-contained task and report back. subagent_type "explore" (default) is read-only and ideal for searching and understanding code without filling your context. "general" can also edit files and run commands (with the user\'s permission). The sub-agent sees only your prompt, so make it complete and say what to return. Several explore tasks can run in parallel.',
  input_schema: {
    type: 'object',
    properties: { description: { type: 'string', description: '3-5 word label' }, prompt: { type: 'string' }, subagent_type: { type: 'string', enum: ['explore', 'general'] } },
    required: ['description', 'prompt'],
  },
  readOnly: true,
  concurrencySafe: (i) => (i.subagent_type || 'explore') === 'explore',
  summary: (i) => `${i.subagent_type || 'explore'}: ${i.description}`,
  async run(input, ctx) {
    if (!ctx.runSubagent) throw new Error('Sub-agents are not available here.');
    return ctx.runSubagent({ ...input, subagent_type: input.subagent_type || 'explore' });
  },
};

export const ExitPlanMode = {
  name: 'ExitPlanMode',
  description: 'Present your implementation plan (markdown) for approval and leave plan mode. Only call this in plan mode, once the plan is concrete.',
  input_schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
  readOnly: true,
  summary: () => 'plan ready for review',
  async run({ plan }, ctx) {
    const r = await ctx.approvePlan(plan);
    if (r.approved) return `The user approved the plan${r.mode === 'acceptEdits' ? ' and enabled auto-accept for edits' : ''}. Plan mode is off. Start implementing now, tracking steps with TodoWrite.`;
    return { text: `The user did not approve the plan.${r.feedback ? ` Feedback: ${r.feedback}` : ''} Stay in plan mode, revise, and call ExitPlanMode again.`, isError: true };
  },
};
