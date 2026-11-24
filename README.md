# DiCode

**An agentic coding assistant for your terminal.** DiCode reads your codebase, edits files, runs commands and tests,
and works through multi-step tasks, asking your permission before anything risky. It runs on Node.js with **zero
runtime dependencies**, and works with Claude (default) or any OpenAI-compatible model, including local ones through Ollama.

```
> the login form crashes when the email is empty, fix it and add a test

⏺ Grep("validateEmail")
  ⎿  Found 3 results
⏺ Read(src/auth/validate.ts)
  ⎿  Read 48 lines
⏺ Edit(src/auth/validate.ts)
  ⎿  Updated src/auth/validate.ts with 3 additions and 1 removal
⏺ Bash(npm test -- validate)
  ⎿  PASS src/auth/validate.test.ts (4 tests)
⏺ Fixed: validateEmail now returns an error for empty input (src/auth/validate.ts:12),
  and there is a regression test in src/auth/validate.test.ts.
  sonnet-5-5 · 4% context · ↑ 18.2k ↓ 1.1k
```

## Install

Requires **Node.js 20+** on macOS, Linux or WSL. [ripgrep](https://github.com/BurntSushi/ripgrep) is optional but makes search much faster in big repos.

```bash
git clone https://github.com/divik-09/dicode.git
cd dicode && npm link        # puts `dicode` on your PATH
dicode setup                 # choose a provider, paste an API key, pick a model
```

Or set `ANTHROPIC_API_KEY` in your environment and skip `setup`. Run `dicode doctor --check` to verify everything.

## Quick start

```bash
cd your-project
dicode                       # interactive session
dicode "add input validation to the signup route"   # start with a task
dicode -c                    # continue your last conversation here
dicode -p "explain src/router.ts" --output-format json   # one-shot, for scripts and CI
```

The first time you open a folder, DiCode asks whether you trust it. In a new project, run **`/init`** so DiCode writes a
`DICODE.md` describing how to build, test and work in the repo. It reads that file at the start of every session.

## What it does

- **Understands code:** `Glob`, `Grep` (ripgrep, with a built-in fallback), `Read` (with line numbers; images too), `LS`, and `Task` sub-agents that explore big codebases without filling the main context.
- **Edits safely:** `Edit` and `MultiEdit` (exact, unique-match replacements; atomic multi-edits; CRLF preserved) and `Write`. DiCode must read a file before changing it, and refuses if you changed the file since. Every change is checkpointed, so **`/undo`** reverts the last turn.
- **Runs things:** `Bash`, with a working directory that persists between calls, timeouts, process-tree cleanup on interrupt, and **background shells** for dev servers and watchers (`BashOutput`, `KillShell`).
- **Plans:** `TodoWrite` task lists for multi-step work. **Plan mode** keeps DiCode read-only until you approve a plan.
- **Researches:** `WebFetch` (HTML converted to text; private/local addresses blocked) and `WebSearch` (Brave Search API if configured, otherwise DuckDuckGo).
- **Handles long sessions:** automatic **context compaction** when the window fills up, retry with backoff on overloads, fallback models, prompt caching, extended thinking (`--think`), saved sessions with `--continue` / `--resume`.

## Using it

| Input | What happens |
|---|---|
| `fix the failing test in @src/api.ts` | `@path` attaches a file (or folder listing, or image). Tab completes paths. |
| `!npm run build` | Runs the command yourself; the output is shared with DiCode for context. |
| `#we use pnpm, never npm` | Saves a note to `DICODE.md` (project memory). |
| `line one \` | End a line with `\` for multi-line input. Pasting multi-line text also works. |
| **Shift+Tab** | Cycle mode: default → accept edits → plan. |
| **Esc** or **Ctrl+C** | Interrupt DiCode mid-task. Anything you typed while it worked stays in the prompt. |
| **Ctrl+C twice** / **Ctrl+D** / `/exit` | Quit. |

### Slash commands

`/help` `/clear` `/compact [focus]` `/undo` `/diff` `/model [ref]` `/mode [name]` `/permissions [allow|ask|deny <rule>]`
`/cost` `/status` `/init` `/memory [edit]` `/todos` `/resume` `/bashes` `/exit`

**Custom commands:** put a markdown file in `.dicode/commands/<name>.md` (project) or `~/.dicode/commands/<name>.md` (personal),
then run `/<name> [args]`. `$ARGUMENTS` in the file is replaced by what you type after the command. There's an example in `examples/.dicode/commands/review.md`.

## Permissions

DiCode never edits files or runs non-read-only commands without asking, unless you tell it to.

| Mode | Behaviour |
|---|---|
| `default` | Reads inside the project and read-only shell commands (`ls`, `git status`, `git diff`, …) run freely. Edits, other commands and web fetches ask. |
| `acceptEdits` | File edits inside the project are applied without asking. Commands still ask. |
| `plan` | Read-only. DiCode researches, then presents a plan for approval (`ExitPlanMode`). |
| `bypassPermissions` | Never asks (`--dangerously-skip-permissions`). Deny rules still apply. Only use it in a sandbox or container. |

When asked, choose **1** (yes), **2** (yes and don't ask again) or **3** (no; optionally tell DiCode what to do instead).
"Don't ask again" saves a rule such as `Bash(npm test:*)` to `.dicode/settings.local.json` (git-ignored automatically).
For edits, it switches the session to accept-edits.

**Rules** live in settings under `permissions.allow`, `permissions.ask` and `permissions.deny` (precedence: deny > ask > allow):

```
Bash                      any command                 Edit(src/**)       edits under src/ (covers Write/MultiEdit)
Bash(npm test)            exactly this command        Read(.env)         this file (covers Glob/Grep/LS)
Bash(npm run test:*)      this prefix                 WebFetch(domain:docs.python.org)
Bash(docker compose * up) glob
```
Compound commands (`a && b | c`) are only auto-allowed if **every** part is allowed or read-only. Command substitution and
file redirection always ask. A deny rule matching any part blocks the whole command. Writes outside the project directory
always ask (symlinks are resolved); use `--add-dir` to extend the project.

## Settings

Settings files are layered (later wins; permission lists are combined):
`~/.dicode/settings.json` (you) → `.dicode/settings.json` (project, commit it) → `.dicode/settings.local.json` (you, in this project) → command-line flags.

```jsonc
{
  "model": "anthropic/claude-sonnet-5-5",
  "fallbackModels": ["openrouter/anthropic/claude-sonnet-4.5"],
  "thinking": { "enabled": false, "budgetTokens": 8000 },
  "permissions": { "defaultMode": "default", "allow": [], "ask": [], "deny": ["Read(.env*)"], "additionalDirectories": [] },
  "autoCompactTokens": 160000, "contextWindow": 200000, "maxSteps": 200, "maxOutputTokens": 16000,
  "bash": { "defaultTimeoutSec": 120, "maxTimeoutSec": 600, "maxOutputChars": 30000 },
  "web": { "braveApiKey": "", "allowPrivate": false },
  "providers": {
    "anthropic": { "apiKey": "…" },
    "openai": { "apiKey": "…" },
    "ollama": { "baseUrl": "http://127.0.0.1:11434/v1" },
    "mylab": { "baseUrl": "https://llm.internal/v1", "apiKey": "…" }
  },
  "pricing": { "anthropic/claude-sonnet-5-5": { "input": 3, "output": 15 } },
  "disabledTools": []
}
```
Models are written `provider/model-id`. Any provider with a `baseUrl` is treated as OpenAI-compatible. `pricing` (USD per
million tokens) is optional; `/cost` uses it if present. API keys can also come from `<PROVIDER>_API_KEY` environment variables.
Manage your user settings from the shell with `dicode config get|set <key> <value>`.

**Trust:** a project's `.dicode/settings.json` can only add hooks and allow-rules once you trust the folder (asked on first
run). A cloned repository can't make DiCode run commands on its own.

## Project memory

DiCode loads instruction files at the start of each session: `~/.dicode/DICODE.md` (yours, for every project), then
`DICODE.md`, `AGENTS.md` and `CLAUDE.md` from the repository root down to the current folder, so existing agent instructions just work.
`/init` writes one for you, `#note` appends to it, and `/memory edit` opens it in your editor.

## Hooks

Shell commands that run on events, configured under `hooks` in settings. Each receives a JSON payload on stdin
(`hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `cwd`, `session_id`).

| Event | When | Exit code 2 means |
|---|---|---|
| `PreToolUse` | before a tool runs (`matcher` is a regex on the tool name) | block the tool; stderr goes to DiCode |
| `PostToolUse` | after a tool runs | stderr is added to the tool result as feedback |
| `UserPromptSubmit` | before your message is sent | block it. stdout on exit 0 is added as context |
| `Stop` | when DiCode thinks it is done | keep working, with stderr as the instruction (max 3 times) |

`examples/.dicode/settings.json` formats files after each edit and refuses to finish while tests fail.

## Scripting and CI

```bash
dicode -p "update the changelog for the last 5 commits" --permission-mode acceptEdits
git diff | dicode -p "write a commit message for this diff"
dicode -p "fix the lint errors" --allowedTools "Edit Bash(npm run lint:*)" --output-format json --max-turns 30
```
In `-p` mode anything that would need a prompt is denied (and DiCode is told how to allow it), so runs never hang.
`--output-format json` prints one result object (`result`, `is_error`, `session_id`, `num_turns`, `usage`,
`total_cost_usd`); `stream-json` prints one JSON event per line. The exit code is 1 on error.

## Security notes

- DiCode runs commands **as you, on your machine**. There is no OS sandbox. The permission system is the safety net, so read the prompts. For unattended or bypass runs, use a container or VM.
- Content from files, web pages and command output can try to steer the model (prompt injection). DiCode tells the model to treat it as data, and it blocks fetches to private networks, but the approval prompts are what actually protect you.
- `/undo` restores files DiCode changed with its edit tools. It can't undo shell side effects (deletions, installs, git operations).
- Sessions are stored under `~/.dicode/projects/` with owner-only permissions. Images are not saved in transcripts.

## Project layout

```
bin/dicode.js            entry point            src/tools/        Read Write Edit MultiEdit LS Glob Grep Bash … Task
src/cli.js               argument parsing       src/permissions.js  modes, rules, read-only command analysis
src/agent.js             the agent loop         src/prompt.js     system prompt, git context, DICODE.md discovery
src/providers/           Anthropic (SSE), OpenAI-compatible, retries + fallback
src/ui/                  REPL, input, streaming markdown, permission dialogs
src/checkpoints.js       /undo                  src/hooks.js  src/session.js  src/diff.js  src/glob.js
```

## Development

```bash
npm test     # 55 tests, about 10 s, no network or API key needed
```
The tests run against a scriptable mock of the Anthropic streaming API. They cover every tool, the permission engine,
the agent loop (parallel tools, plan mode, interrupts, compaction, output-limit recovery, hooks, retries, fallback,
sub-agents, thinking), the CLI as real subprocesses, and the interactive REPL driven through a pseudo-terminal
(trust prompt, file mentions, permission dialog with diff, `/undo`, `!shell`, `#memory`, Shift+Tab, Esc, type-ahead).

**What has not been verified yet:** calls to the real Anthropic and OpenAI APIs (the mocks follow the documented
streaming format), the ripgrep code path (the built-in search was tested; ripgrep wasn't installed where this was built),
and macOS (built and tested on Linux; CI is set up for both).

## License

MIT
