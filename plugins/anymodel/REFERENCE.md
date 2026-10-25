# anymodel reference

Everything the [README](README.md) leaves out: settings, permissions, privacy, security, limits and troubleshooting.

## Requirements

You need Claude Code 2.1.309 or later (tested on 2.1.309 and 2.1.310) on macOS or Linux, with the `claude` command on
your PATH (each agent runs it), and a model that calls tools on a server that speaks the Anthropic Messages API
(`/v1/messages`). `/anymodel check` tells you whether yours does.

## What goes where

| To | What |
|---|---|
| **The agent's provider** | Everything the agent works with: Claude Code's prompt and tool definitions (about 13k tokens), the project's `CLAUDE.md`, the task, every file it reads and every command output. The requests that read the model's context size: when the plugin loads, and before each run for a local server. Your key for that provider, and only to it. |
| **Anthropic** (your main session) | What any subagent sends: Claude's brief and the agent's report. In an interactive session, Claude Code's progress summary of an agent that runs over about 30 s (it holds the task). In auto mode, the auto-mode check of the agent's report. `/anymodel` adds no brief and no Claude turn, but its answer joins the conversation, so Anthropic gets it with your next message to Claude. |

A local model keeps the agent's work on your machine. Claude spends your usage on the brief and the report, as for
any subagent. The provider bills the agent's prompt (13k tokens and growing) on every request, and caches it if it
can.

## Settings

`/plugin configure anymodel` holds one agent at a time. Save it, and anymodel adds the agent, or updates it, and
clears the form for the next one; a toast says what was saved, or why not.

| Field | What | Example |
|---|---|---|
| **Agent name** | The name you call it by: up to 64 letters, digits, `_` and `-`; not `check`, `cleanup` or `remove`. | `kimi` |
| **Server URL** | The base URL of a server that speaks the Anthropic Messages API. | `https://openrouter.ai/api` |
| **Model** | The model id exactly as the server lists it. | `moonshotai/kimi-k3` |
| **API key** | The server's key, if it needs one. | `sk-or-...` |
| **Context size** | In tokens, for a server that does not report it. | `262144` |

- **A new name** adds an agent and needs a server URL and a model. **An existing name** updates that agent with the
  fields you fill in; a blank field keeps its value. `/anymodel` lists the agents; `/anymodel remove <agent>`
  removes one.
- **Server URL**: a URL may end in `/v1` as OpenAI clients write it. Unsloth Studio serves `/v1/messages`
  (`http://127.0.0.1:8888`, with a key from its settings); so do llama.cpp's `llama-server`, vLLM and many cloud
  providers, such as `https://api.moonshot.ai/anthropic` (see their docs for the URL). A server with only `/v1/chat/completions` needs a translating proxy, or OpenRouter in front of it.
- **API key**: agents on one server share its key, so type it once, with any of them, and again only to change it.
  Keys are kept out of `settings.json`: in the macOS Keychain, or on Linux in `~/.claude/.credentials.json`, a file
  only you can read. A key goes only to its own server, never over plain `http://` to another network, and goes
  with the last agent on that server. A local server usually needs none. Save keys in a session with anymodel on: a
  key saved while it is off (the plugin disabled, or `claude plugin configure` in a shell) replaces the others.
- **Context size**: the agent compacts its conversation at its model's context length, so it needs that length. It
  is read from the server: from LM Studio the length the model is loaded with, from Unsloth Studio the window it
  runs, from llama.cpp's `llama-server` the window of each slot, from OpenRouter or vLLM the model's window. A local
  server's is read again before each run, so a model reloaded with another length is picked up; a remote one's
  when the plugin loads, and again when the agent runs if that read failed. For a server that reports none, fill in
  **Context size**; when the server reports one, that one counts and `/anymodel` says the setting is ignored. It
  must be 49152 or more, and 65536 or more works best: Claude Code keeps about 33k of the window free for compaction
  and the agent's own prompt takes about 13k, so with less the agent compacts over and over and loses its task.

A save that cannot work is refused with the reason (`anymodel: kimi not saved: the server URL must start with
http:// or https://`), and the form keeps what you typed but the key, which you type again. Saving reloads the
plugin. Settings are per user (or managed, for an organization), not per project.

## Use

- **`/anymodel <agent> <task>`** runs the agent on your task as you typed it, in the foreground, with no Claude turn.
  Its answer shows under the agent's name and model, with the turns and tokens it took; Claude can read it later. Esc
  stops the agent. Headless: `claude -p "/anymodel gemma <task>"` prints the answer and, with text output, exits 1 on
  an error; add `--permission-mode acceptEdits` to let it edit, as nobody is there to ask.
- **`@agent-anymodel:<agent> <task>`**: type `@` and the list shows each agent with its model. Claude writes the brief
  from your message and the conversation, starts the agent, and gets its report. Asking by name ("ask kimi to
  review src/auth") works too; the `@` mention is the reliable way. Claude is told to use an anymodel agent when
  you name it; for Claude to pick one by itself, give it a [custom agent](#custom-agents) definition with a
  description.
- **Like any subagent**, an agent runs in the background or the foreground, several at once, and shows in `/tasks`;
  Esc stops one in the foreground. Claude can send it more with `SendMessage`: an agent that is still working gets
  the message at its next step; a finished one continues where it left off.
- **The agent's view** (`←` in the agents row, or `/tasks`) shows as it works the agent's text, each tool call
  (`Bash(npm test)`) and its first line of output (`⎿ 12 passed`), then its answer with the turns and tokens it took.
- **`/anymodel`** lists your agents with their model, server URL, context size and whether a key is set, and any
  settings problems.
- **`/anymodel remove <agent>`** removes the agent, and its server's key once no agent uses that server.
- **`/anymodel check [agent]`** reads each agent's context size again and shows it, with where it came from, then
  has its model answer one tool call, not streamed; each step shows its time or what went wrong.
- **`/anymodel cleanup [days]`** removes the agents' session records and transcripts older than `days` (default:
  your `cleanupPeriodDays`, else 30), and what a killed session left in `/tmp`.

An agent sees none of your conversation, only Claude's brief or your `/anymodel` task. It works best on a
self-contained task: review this, find that, write a test for this file.

## Custom agents

Give an agent its own instructions and tools as you would any Claude Code subagent: write the definition, and name
the anymodel agent like it.

1. Create `.claude/agents/reviewer.md` (this project) or `~/.claude/agents/reviewer.md` (all your projects), by hand
   or with `/agents`:

   ```markdown
   ---
   name: reviewer
   description: Reviews code for security problems. Use after changes to auth or input handling.
   tools: Read, Grep, Glob
   model: anymodel
   ---
   You are a security reviewer. Report each problem with its file and line, most severe first.
   ```

2. Add an agent named `reviewer` in `/plugin configure anymodel`, for example `moonshotai/kimi-k3` on
   `https://openrouter.ai/api`.

Claude then delegates to `reviewer` by its description, as to any subagent, and it runs on Kimi K3 with your prompt
and tools; `/anymodel reviewer <task>` and `@agent-anymodel:reviewer` run it the same way. The agent's settings
decide the model. `model: anymodel` keeps the agent off Claude when anymodel is not running (hooks off): Anthropic has no
model of that name, so the agent fails instead of working on Claude. The file is named like the agent, and a project
file comes before a user one, as in Claude Code; `/anymodel` shows `runs as …/reviewer.md`, and says when the
definition lacks `model: anymodel`.

## Permissions

An agent works under your permission mode, rules and sandbox, as a subagent does. When it would ask about a tool use,
your rules and mode decide it as they would for Claude:

- what they allow or deny is allowed or denied;
- what Claude Code would ask you comes to you: "kimi (moonshotai/kimi-k3) wants to use Bash(npm test). Allow it?"
  with **Yes**, **Yes, don't ask again** (when Claude Code suggests a rule: one for this session reaches every later
  agent run, not Claude; one for the project goes to `.claude/settings.local.json`, which Claude follows too) and
  **No**, or type what to do instead;
- in `claude -p` there is no one to ask, so it is refused.

In `bypassPermissions` everything goes ahead, including a sandboxed command's connection to any domain. In `auto`
mode the agent's own model approves its tool calls (Claude's auto-mode check sees only its report). Use `auto` and
`bypassPermissions` only with models you trust with your shell.

## Tested models

Each ran `/anymodel check` and a real task through anymodel (running a command, reading a file) on the date shown:
the OpenRouter models with Claude Code 2.1.309, the full test suite with 2.1.310.

| Model | Server | Tested |
|---|---|---|
| `DavidAU/Qwen3.8-27B-…-NEO-CODER-MAX-MTP-GGUF` (a Qwen3.8 27B fine-tune) | Unsloth Studio, local | 2026-10-24, the full test suite |
| `moonshotai/kimi-k3` | OpenRouter | 2026-10-24 |
| `deepseek/deepseek-v4.1-flash` | OpenRouter | 2026-10-24 |
| `z-ai/glm-5.3` | OpenRouter | 2026-10-24 |
| `qwen/qwen3.8-27b` | OpenRouter | 2026-10-24 |
| `minimax/minimax-m3.1-flash` | OpenRouter | 2026-10-24 |
| `google/gemini-3.8-flash` | OpenRouter | 2026-10-24 |
| `openai/gpt-5.6-luna` | OpenRouter | 2026-10-24 |

A model works when it calls tools reliably. LM Studio, llama.cpp and vLLM are untested; `/anymodel check` tells you
in seconds whether yours works. Small local models make more mistakes in long tasks: give them short, concrete ones.

## Troubleshooting

| You see | Do |
|---|---|
| `cannot reach http://127.0.0.1:1234 (…): is its server running?` | Start the server, or save the agent with the right **Server URL**. |
| `… /v1/models: not listed (it lists a, b, …)` | Save the agent with the model id exactly as listed. |
| `… has a context of 4096 tokens, under the 49152 an agent needs` | Load the model with a longer context (65536 or more). |
| `cannot read the context size of …` | If it shows `HTTP 401` or `403`, save the agent with its server's **API key**. Otherwise load the model, or save its **Context size**. |
| `tool call FAILED: HTTP 401 …` | Save the agent with its server's right **API key**. |
| `tool call FAILED: no report_ok tool call in the answer` | The model did not call the check's test tool: pick a tool-capable model, or turn on tool calling in its server (llama.cpp: `--jinja`). |
| `the report starts with reasoning whose opening tag the server sent elsewhere` | Set the server to return reasoning separately (its reasoning parser), or turn thinking off. |
| `anymodel: the plugin did not answer this agent` or `Agent type 'anymodel:…' not found` | The plugin is off or hooks are disabled (`disableAllHooks`, managed policy): turn them on, then `/reload-plugins`. |
| The first answer takes a while | A local model reads the agent's 13k-token prompt before its first word; later requests reuse its cache. |

## Limits

Where an agent differs from Claude Code's own subagents:

- **Its permission question** is Claude Code's question dialog, not its permission dialog, which only Claude Code
  itself draws. The answers are the same.
- **A custom agent's prompt** is the definition's prompt plus anymodel's one-line subagent rule, as
  `claude --agent` runs it; Claude Code's own notes for subagents (absolute paths, no report files) are not added.
- **Progress** shows as notices, not as Claude Code's own tool cards: a plugin can add only notices to an agent's
  view ([requested](https://github.com/anthropics/claude-code/issues/104824)). A tool's output shows as its first
  line.
- **Background commands**: the agent cannot run a command in the background, as its session ends with its answer.
- **Your user settings**: only their permission settings and sandbox reach the agent; your user `CLAUDE.md`, hooks,
  plugins and skills do not (the project's do), so your own hooks do not see its tool calls.
- **MCP**: the agent gets the servers of your user config and the project's `.mcp.json` that your session has
  connected, as its own copies. Plugin, managed and claude.ai servers are not passed, and a server that signs in with
  OAuth has no login in the agent.
- **WebSearch** is not available: it runs on Anthropic's servers.
- **Environment**: the agent runs in your session's environment less its `ANTHROPIC_*` and `CLAUDE*` variables
  (the proxy, TLS and client-certificate ones stay), with `TMPDIR` set to `/tmp/anymodel-<uid>`.
- **Without the plugin running there are no anymodel agents**: hooks turned off, or a crash of Claude Code's hooks
  worker, leave none, and an `@` mention of one is plain text that Claude may act on itself. A
  [custom agent](#custom-agents)'s definition then runs on Claude, unless it has `model: anymodel`. A `SendMessage` to an
  agent from earlier, in a session resumed without the plugin, goes to Claude with what that agent had.
- Workflow agents and teammates of an anymodel type are refused.

## Security

- An agent never uses your claude.ai login: its Claude Code has a config directory of its own and signs in to the
  agent's provider only, with that provider's key.
- While an agent runs, its key is in no file, command line or environment variable: the plugin hands it to the
  agent's Claude Code through a pipe, and Claude Code passes it to none of the agent's hooks, MCP servers or commands.
  A provider's error is shown with any key in it replaced by `<key>` (a key under 8 characters only where it stands
  alone).
- The project's settings load in the agent, as in any session there, but cannot change where its requests go or whom
  they trust: the provider URL, key and headers are anymodel's, every proxy variable, TLS trust and client
  certificates stay as your session has them.
- Other plugins with hooks modules can see a key on its way, as they can see any plugin's calls: install only plugins
  you trust.

## Files and uninstalling

- `~/.local/state/anymodel` (`$XDG_STATE_HOME/anymodel`): the agents' own Claude Code config and transcripts, one
  session record per session and agent, and one mark per agent that ran: a later message to an agent you renamed or
  removed is refused with an error instead of going to Claude. `/anymodel cleanup` prunes the transcripts and session
  records; the config and the marks stay.
- `~/.claude/plugins/store/anymodel_ph3on1x-*.json`: your agents (name, server URL, model, context size), no keys.
- `/tmp/anymodel-<uid>`: one directory per running agent, removed when it ends.

To uninstall: `/plugin uninstall anymodel@ph3on1x`, which removes the keys from secure storage, then
`rm -rf ~/.claude/plugins/store/anymodel_ph3on1x-*.json "${XDG_STATE_HOME:-$HOME/.local/state}/anymodel" /tmp/anymodel-$(id -u)`.

## How it works

The plugin's hooks module registers each agent as the subagent type `anymodel:<name>`, on its own model, and answers
every model step of such an agent itself, so none of it reaches the session's backend. It runs the task in a
separate `claude -p` pointed at the agent's provider and model, the worker, and returns the worker's final answer as
the agent's report. Claude Code talks to one backend per process, so each worker is a process of its own. A small
bridge (`hooks/bridge.sh`) carries the worker's permission questions, tool calls, your messages and Esc between it and
your session. Each run of an agent keeps its worker session, so a `SendMessage` to it continues with everything it
did before; a new `@` or `/anymodel` call starts fresh, as Claude Code's own subagents do, and so does moving the
agent to another server or model.

It relies on Claude Code behaviour the docs do not promise, so it is tested end to end: see
[test/README.md](test/README.md).
