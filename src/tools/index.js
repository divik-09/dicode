import { Read, Write, Edit, MultiEdit, LS } from './files.js';
import { Glob, Grep } from './search.js';
import { Bash, BashOutput, KillShell } from './bash.js';
import { TodoWrite, WebFetch, WebSearch, Task, ExitPlanMode } from './misc.js';

export const ALL_TOOLS = [Task, Bash, BashOutput, KillShell, Glob, Grep, LS, Read, Edit, MultiEdit, Write, WebFetch, WebSearch, TodoWrite, ExitPlanMode];

export function toolsFor({ mode, subagent = null, settings }) {
  let t = ALL_TOOLS.filter((x) => !(settings.disabledTools || []).includes(x.name));
  if (mode !== 'plan') t = t.filter((x) => x.name !== 'ExitPlanMode');
  if (subagent) t = t.filter((x) => !['Task', 'ExitPlanMode', 'TodoWrite'].includes(x.name));
  if (subagent === 'explore') t = t.filter((x) => x.readOnly || x.name === 'Bash');
  return t;
}

export const schemas = (tools) => tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
export const isConcurrent = (tool, input) => (typeof tool.concurrencySafe === 'function' ? tool.concurrencySafe(input) : !!tool.concurrencySafe);
