# WISCI

**Context Engineering Framework for Claude Code**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-Plugin-orange.svg)](https://github.com/anthropics/claude-code)
[![Version](https://img.shields.io/badge/version-1.1.0-green.svg)]()

Ever notice your AI coding sessions get worse the longer they run? The model repeats itself, forgets what it just learned, or acts on information that's no longer true. That's not a bug — it's what happens when context fills up with noise.

WISCI gives you four slash commands — **Write**, **Isolate**, **Select**, **Compress** — that keep your Claude Code sessions sharp. Save what matters, load only what's relevant, research without polluting your context, and hand off cleanly between sessions.

## Installation

Requires Claude Code with plugin support.

```bash
/plugin marketplace add ph3on1x/wisci        # register the marketplace source
/plugin install wisci@wisci-framework        # install the plugin
```

## When to Use What

| You're thinking... | Use | What happens |
|---|---|---|
| "I'll need this info tomorrow" | `/write auth-research` | Saves your findings to `scratchpad/auth-research.md` with file references that track staleness |
| "Let me explore this without cluttering my session" | `/isolate how does the payment flow work` | 1-3 subagents research in isolated windows; results appear inline, your context stays clean |
| "Where was I?" | `/select` | Loads a codebase overview + lists your saved context files, flagging any that are stale |
| "I need my auth research back" | `/select auth-research` | Loads that specific context file, auto-stripping any sections whose source files have changed |
| "Done for the day" | `/compress` | Creates a handoff document so your next session picks up exactly where you left off |

**Helper:** `/commit` creates conventional commits enriched with a `Context:` section that logs AI-layer changes — turning `git log` into long-term memory.

## Real-World Scenarios

### Building a feature across multiple sessions

**Session 1 — Research and plan:**
```
> /isolate how does auth work in this codebase
  (subagents explore auth middleware, token handling, session management — results appear inline)

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

> /isolate what are the main API endpoints and how do they connect to the database
  (subagents explore independently — you get a structured report without reading 50 files yourself)

> /write api-overview
  (persists the exploration results — now any future session can /select api-overview instead of re-exploring)
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

### Primary Commands

| Command | What It Does |
|---------|-------------|
| `/write <topic>` | Save context to persistent scratchpad files with source tracking and section-level merge |
| `/isolate <task>` | Research with 1-3 subagents in isolated context windows — results inline, noise stays out |
| `/select [topic]` | Load context with automatic staleness detection — stale sections stripped, broken refs flagged |
| `/compress [scope]` | Create compressed handoff documents for session transitions |

### Helper Commands

| Command | What It Does |
|---------|-------------|
| `/commit [message]` | Create git commits enriched with a `Context:` section that tracks AI-layer changes — turning `git log` into long-term memory |

## The Iterate Philosophy

The "I" in WISCI is not a fifth command — it is the principle that these four commands form a continuous cycle:

```
/select  →  work  →  /isolate (as needed)  →  /write  →  /compress
    ↑                                                          |
    └───────────────────── new session ────────────────────────┘
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

| Command | Failure Modes Addressed |
|---------|------------------------|
| `/write` | **Poisoning** — preserves exact facts with source tracking. **Clash** — section-level merge consolidates without contradictions |
| `/isolate` | **Distraction** — research noise stays in separate windows. **Confusion** — each agent gets a clean, focused context |
| `/select` | **Poisoning** — strips sections whose referenced files have changed. **Confusion** — loads only relevant, validated context |
| `/compress` | **Distraction** — keeps utilization in the effective range through deliberate compaction |
</details>

## Acknowledgments

WISCI builds on foundational work in context engineering:

- **Lance Martin / LangChain** — The [WISC taxonomy](https://blog.langchain.com/context-engineering-for-agents/) (Write, Isolate, Select, Compress) that provides the structural foundation
- **Andrej Karpathy** — The [context engineering framing](https://x.com/karpathy/status/1937884699741483308) (LLM as CPU, context window as RAM, external storage as disk)
- **Drew Breunig** — The [four failure modes taxonomy](https://www.dbreunig.com/2025/05/22/context-engineering.html) (poisoning, distraction, confusion, clash)
- **Anthropic** — The Claude Code plugin platform that makes this possible

## License

[MIT](LICENSE)
