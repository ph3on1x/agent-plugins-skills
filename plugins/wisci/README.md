# WISCI

**Context Engineering Framework for AI Coding Agents**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.2.0-green.svg)]()
[![Agent Skills](https://img.shields.io/badge/Agent_Skills-Standard-blueviolet.svg)](https://agentskills.io)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-orange.svg)](https://github.com/anthropics/claude-code)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-Extension-4285F4.svg)](https://github.com/google-gemini/gemini-cli)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-Compatible-10a37f.svg)](https://github.com/openai/codex)

---

Ever notice your AI coding sessions get worse the longer they run? The model repeats itself, forgets what it just learned, or acts on information that's no longer true. That's not a bug — it's what happens when context fills up with noise.

WISCI gives you four slash commands — **Write**, **Isolate**, **Select**, **Compress** — that keep your AI coding sessions sharp. Save what matters, load only what's relevant, research without polluting your context, and hand off cleanly between sessions.

## Installation

WISCI skills use the [Agent Skills open standard](https://agentskills.io) (`SKILL.md` format), which is supported across all major AI coding agents.

<table>
<tr>
  <th width="200">Platform</th>
  <th>How to install</th>
</tr>
<tr>
  <td><strong>Claude Code</strong></td>
  <td><code>/plugin marketplace add ph3on1x/wisci</code><br><code>/plugin install wisci@wisci-framework</code></td>
</tr>
<tr>
  <td><strong>Gemini CLI</strong></td>
  <td><code>gemini extensions install &lt;github-url&gt;</code></td>
</tr>
<tr>
  <td><strong>Codex CLI</strong></td>
  <td>Clone the repo, then run <code>./scripts/setup-platforms.sh</code></td>
</tr>
<tr>
  <td><strong>Cursor</strong></td>
  <td>Auto-discovers skills — no setup needed if Claude Code plugin is installed. Otherwise, run <code>./scripts/setup-platforms.sh</code></td>
</tr>
</table>

> **Note:** `/isolate` uses subagent spawning, which works best on Claude Code and Codex CLI. On platforms without inline subagent support, research runs in a single agent — functional, but without parallel exploration.

## When to Use What

<table>
<tr>
  <th width="280">You're thinking...</th>
  <th width="280">Use</th>
  <th>What happens</th>
</tr>
<tr>
  <td>"I'll need this info tomorrow"</td>
  <td><code>/write auth-research</code></td>
  <td>Saves your findings to <code>scratchpad/auth-research.md</code> with file references that track staleness</td>
</tr>
<tr>
  <td>"I need to research something without cluttering my session"</td>
  <td><code>/isolate compare OAuth2 libraries for Node.js</code></td>
  <td>1-3 subagents handle it in isolated windows (websearch, docs, any task); results appear inline, your context stays clean</td>
</tr>
<tr>
  <td>"Where was I?"</td>
  <td><code>/select</code></td>
  <td>Loads a codebase overview + lists your saved context files, flagging any that are stale</td>
</tr>
<tr>
  <td>"I need my auth research back"</td>
  <td><code>/select auth-research</code></td>
  <td>Loads that specific context file, auto-stripping any sections whose source files have changed</td>
</tr>
<tr>
  <td>"Done for the day"</td>
  <td><code>/compress</code></td>
  <td>Creates a handoff document so your next session picks up exactly where you left off</td>
</tr>
</table>

## Real-World Scenarios

### Building a feature across multiple sessions

**Session 1 — Research and plan:**
```
> /select auth-layer
  (deep dive into auth middleware, token handling, session management — results appear inline)

> /isolate compare JWT vs session-based auth for our use case
  (subagents websearch best practices and read external docs — results inline, context stays clean)

> /write auth-research
  (saves findings to scratchpad/auth-research.md with exact file paths and line numbers)

> /compress
  (creates scratchpad/handoff.md: "Researched auth system. OAuth2 flow in src/auth/. Next: implement token refresh.")
```

**Session 2 — Implement:**
```
> /select
  (loads codebase overview, shows: auth-research.md [fresh], handoff.md [fresh])

> /select auth-research
  (loads your research — all file references still valid, nothing stripped)

  ... implement the feature ...

> /write auth-research
  (merges new implementation decisions into the existing file — section-level merge, no duplicates)

> /commit feat: add token refresh to auth middleware
  (commits with Context: section tracking scratchpad changes)
```

### Onboarding to an unfamiliar codebase

```
> /select
  (instant codebase overview: directory structure, tech stack, conventions, available context files)

> /select api-layer
  (deep dive into the API layer — subagents explore routes, handlers, and database connections)

> /isolate what are the best practices for testing Express middleware
  (subagents websearch and read external docs — results inline without polluting your context)

> /write onboarding-notes
  (persists everything — now any future session can /select onboarding-notes instead of re-exploring)
```

### Picking up a teammate's work

```
> /select
  (shows available context: payment-integration.md [stale — src/payments/handler.ts changed 2 days ago])

> /select payment-integration
  (loads the file with stale sections auto-stripped, adds note: "3 sections stripped. Consider /write to refresh.")

  ... review what's still valid, continue the work ...

> /write payment-integration
  (refreshes the file with current state — stale sections replaced, references updated)
```

## Commands

<table>
<tr>
  <th width="200">Command</th>
  <th>What It Does</th>
</tr>
<tr>
  <td><code>/write &lt;topic&gt;</code></td>
  <td>Save context to persistent scratchpad files with source tracking and section-level merge</td>
</tr>
<tr>
  <td><code>/isolate &lt;task&gt;</code></td>
  <td>Delegate any task to 1-3 subagents in isolated context windows — websearch, research, exploration — results inline, noise stays out</td>
</tr>
<tr>
  <td><code>/select [topic]</code></td>
  <td>Load project context (codebase overview or saved scratchpad files) with automatic staleness detection</td>
</tr>
<tr>
  <td><code>/compress [scope]</code></td>
  <td>Create compressed handoff documents for session transitions</td>
</tr>
<tr>
  <td><code>/commit [message]</code></td>
  <td>Create git commits enriched with a <code>Context:</code> section that tracks AI-layer changes — turning <code>git log</code> into long-term memory</td>
</tr>
</table>

## The Iterate Philosophy

The "I" in WISCI is not a fifth command — it is the principle that these four commands form a continuous cycle:

```
  /select  →  work  →  /isolate (as needed)  →  /write  →  /compress
     ↑                                                         │
     └──────────────────────  new session  ────────────────────┘
```

Sessions are disposable but knowledge is not. Each cycle compounds what your project knows. The `scratchpad/` directory becomes a living knowledge base that survives session boundaries, context compactions, and team handoffs.

## How It Works

- **Topic-based storage** — Context lives in `scratchpad/` as markdown files organized by topic. Each file has structured `##` sections preserving exact file paths, decisions, and reasoning.
- **Staleness detection** — Every scratchpad file includes a `## References` manifest. When loaded, git history is checked to detect whether referenced files have changed.
- **Section-level merge** — `/write` merges at `##` heading boundaries — stale sections are pruned automatically.
- **Auto-stripping** — `/select` removes stale content before loading. Outdated sections are stripped, broken references flagged.
- **Git as long-term memory** — `/commit` appends a `Context:` section to commits that logs changes to AI-layer files, making the context system's evolution queryable in `git log`.

## Why WISCI, Not Another Framework

<details>
<summary>WISCI is a toolbox, not a blueprint</summary>

Most development frameworks are prescriptive — they define a specific workflow, a rigid spec format, or a step-by-step process you must follow. They sound good in theory, but in practice they fight against the way you actually work.

WISCI takes the opposite approach. It does not tell you what to build, how to structure your tasks, or which process to follow. It gives you four tools — each designed to address a specific, well-understood context engineering failure mode — and gets out of your way.

You decide when to write context, what to isolate, which topics to select, and when to compress. There is no prescribed order, no mandatory spec format, no opinionated scaffold. Your workflow stays yours — you just stop losing context along the way.
</details>

<details>
<summary>The context failure modes WISCI addresses</summary>

LLM context windows fail in four predictable ways:

- **Context Poisoning** — Errors or hallucinations persist in context, cascading into future responses. A single wrong assumption compounds across an entire session.
- **Context Distraction** — As context grows, the model fixates on accumulated history instead of using its training. Past actions get repeated rather than new strategies developed.
- **Context Confusion** — Irrelevant information leads to wrong tool selection or document usage. Performance degrades as the number of available but unrelated context items increases.
- **Context Clash** — Information gathered incrementally across turns creates internal contradictions. Research shows a 39% performance drop when information is sharded across multiple interactions.

These failures are not edge cases — they are the default outcome of long-running sessions. Context quality degrades significantly past 40% utilization, yet most tools only react at 95% when auto-compaction kicks in. By then, the damage is done.

<table>
<tr>
  <th width="160">Command</th>
  <th>Failure Modes Addressed</th>
</tr>
<tr>
  <td><code>/write</code></td>
  <td><strong>Poisoning</strong> — preserves exact facts with source tracking. <strong>Clash</strong> — section-level merge consolidates without contradictions</td>
</tr>
<tr>
  <td><code>/isolate</code></td>
  <td><strong>Distraction</strong> — research noise stays in separate windows. <strong>Confusion</strong> — each agent gets a clean, focused context</td>
</tr>
<tr>
  <td><code>/select</code></td>
  <td><strong>Poisoning</strong> — strips sections whose referenced files have changed. <strong>Confusion</strong> — loads only relevant, validated context</td>
</tr>
<tr>
  <td><code>/compress</code></td>
  <td><strong>Distraction</strong> — keeps utilization in the effective range through deliberate compaction</td>
</tr>
</table>
</details>

## Acknowledgments

WISCI builds on foundational work in context engineering:

- **Lance Martin / LangChain** — The [WISC taxonomy](https://blog.langchain.com/context-engineering-for-agents/) (Write, Isolate, Select, Compress) that provides the structural foundation
- **Andrej Karpathy** — The [context engineering framing](https://x.com/karpathy/status/1937884699741483308) (LLM as CPU, context window as RAM, external storage as disk)
- **Drew Breunig** — The [four failure modes taxonomy](https://www.dbreunig.com/2025/05/22/context-engineering.html) (poisoning, distraction, confusion, clash)
- **Anthropic** — The [Claude Code](https://github.com/anthropics/claude-code) platform and [Agent Skills standard](https://agentskills.io) that make this possible

## License

[MIT](LICENSE)
