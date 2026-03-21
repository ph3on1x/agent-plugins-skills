# WISCI

**Context Engineering Framework for Claude Code**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-Plugin-orange.svg)](https://github.com/anthropics/claude-code)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)]()

Context engineering is "the art of filling the context window with just the right information for the next step" (Andrej Karpathy). WISCI implements this as four slash commands — **Write**, **Isolate**, **Select**, **Compress** — plus an **Iterate** philosophy that keeps your Claude Code sessions working with accurate, focused context instead of accumulated noise.

## The Problem

LLM context windows fail in four predictable ways:

- **Context Poisoning** — Errors or hallucinations persist in context, cascading into future responses. A single wrong assumption compounds across an entire session.
- **Context Distraction** — As context grows, the model fixates on accumulated history instead of using its training. Past actions get repeated rather than new strategies developed.
- **Context Confusion** — Irrelevant information leads to wrong tool selection or document usage. Performance degrades as the number of available but unrelated context items increases.
- **Context Clash** — Information gathered incrementally across turns creates internal contradictions. Research shows a 39% performance drop when information is sharded across multiple interactions.

These failures are not edge cases — they are the default outcome of long-running sessions. Context quality degrades significantly past 40% utilization, yet most tools only react at 95% when auto-compaction kicks in. By then, the damage is done.

## How WISCI Solves It

| Command | What It Does | Failure Modes Addressed |
|---------|-------------|------------------------|
| `/write <topic>` | Externalize context to persistent, structured scratchpad files | **Poisoning** — preserves exact facts with source tracking. **Clash** — section-level merge consolidates without contradictions |
| `/isolate <task>` | Delegate research to 1-3 subagents with isolated context windows | **Distraction** — research noise stays in separate windows. **Confusion** — each agent gets a clean, focused context |
| `/select [topic]` | Load context with automatic staleness detection and stripping | **Poisoning** — strips sections whose referenced files have changed. **Confusion** — loads only relevant, validated context |
| `/compress [scope]` | Create compressed handoff for session transitions | **Distraction** — keeps utilization in the effective range through deliberate compaction |

### Helper Commands

| Command | What It Does |
|---------|-------------|
| `/commit [message]` | Create git commits enriched with a `Context:` section that tracks AI-layer changes — turning `git log` into long-term memory |

## Why WISCI, Not Another Framework

Most development frameworks are prescriptive — they define a specific workflow, a rigid spec format, or a step-by-step process you must follow. They sound good in theory, but in practice they fight against the way you actually work. They were built by someone, for something, and you spend more time conforming to the framework than solving your problem.

WISCI takes the opposite approach. It is not a workflow. It does not tell you what to build, how to structure your tasks, or which process to follow. It gives you four tools — each designed to address a specific, well-understood context engineering failure mode — and gets out of your way.

You decide when to write context, what to isolate, which topics to select, and when to compress. There is no prescribed order, no mandatory spec format, no opinionated scaffold. WISCI is the toolbox, not the blueprint. Your workflow stays yours — you just stop losing context along the way.

## Installation

```
/plugin marketplace add ph3on1x/wisci
/plugin install wisci@wisci-framework
```

## The Iterate Philosophy

The "I" in WISCI is not a fifth command — it is the principle that these four commands form a continuous cycle:

```
/select  →  work  →  /isolate (as needed)  →  /write  →  /compress
    ↑                                                          |
    └───────────────────── new session ────────────────────────┘
```

Sessions are disposable but knowledge is not. Each cycle through Write → Select → Isolate → Compress compounds what your project knows. The `scratchpad/` directory becomes a living knowledge base that survives session boundaries, context compactions, and team handoffs.

The right optimization target is not tokens per request — it is tokens per task. Proactive context management through the WISCI cycle keeps every session operating in the effective range, rather than degrading silently until auto-compaction triggers at 95%.

## How It Works

- **Topic-based storage** — Context lives in `scratchpad/` as markdown files organized by topic, not date-prefixed logs. Each file has structured `##` sections preserving exact file paths, decisions, error codes, and reasoning.

- **Staleness detection** — Every scratchpad file includes a `## References` manifest listing the source files it depends on. When `/select` loads a file, it checks git history to detect whether referenced files have changed since the context was written.

- **Section-level merge** — `/write` merges new information at `##` heading boundaries — a deliberate middle ground between per-fact granularity (too complex) and full-file replacement (too lossy). Stale sections are pruned automatically during merge.

- **Auto-stripping** — `/select` removes stale content before loading it into your context window. No passive warnings — outdated sections are stripped, and broken references (deleted files) are flagged. This prevents the most common form of context poisoning: acting on information that no longer reflects the codebase.

- **Git as long-term memory** — `/commit` enriches git commits with a `Context:` section that logs changes to AI-layer files (scratchpad, rules, commands, instructions). This makes the AI context system's evolution visible and queryable in `git log`, so future sessions can trace when a rule was added, why a decision was made, or what context changed alongside code.

## Typical Workflow

1. **Research** — Use `/isolate` to explore a topic with dedicated subagents
2. **Save** — Use `/write` to persist findings to `scratchpad/`
3. **Commit** — Use `/commit` to create enriched git commits that track AI-layer changes
4. **Resume** — Use `/select` to reload context in a new session (stale content auto-stripped)
5. **Handoff** — Use `/compress` to create a minimal handoff document when switching tasks

## Acknowledgments

WISCI builds on foundational work in context engineering:

- **Lance Martin / LangChain** — The [WISC taxonomy](https://blog.langchain.com/context-engineering-for-agents/) (Write, Isolate, Select, Compress) that provides the structural foundation
- **Andrej Karpathy** — The [context engineering framing](https://x.com/karpathy/status/1937884699741483308) (LLM as CPU, context window as RAM, external storage as disk)
- **Drew Breunig** — The [four failure modes taxonomy](https://www.dbreunig.com/2025/05/22/context-engineering.html) (poisoning, distraction, confusion, clash)
- **Anthropic** — The Claude Code plugin platform that makes this possible

## License

[MIT](LICENSE)
