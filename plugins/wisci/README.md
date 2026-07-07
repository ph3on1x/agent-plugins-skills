<div align="center">

# WISCI

**Context engineering framework for AI coding agents**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.0-green.svg)]()
[![Agent Skills](https://img.shields.io/badge/Agent_Skills-Standard-blueviolet.svg)](https://agentskills.io)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-orange.svg)](https://github.com/anthropics/claude-code)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-Extension-4285F4.svg)](https://github.com/google-gemini/gemini-cli)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-Compatible-10a37f.svg)](https://github.com/openai/codex)

Ever notice your AI coding sessions get worse the longer they run?<br>
That's not a bug — it's what happens when context fills up with noise.

[Installation](#installation) • [Usage](#when-to-use-what) • [The Problem](#the-problem) • [How It Works](#how-it-works) • [v2 Migration](#migrating-from-v1) • [Examples](#real-world-scenarios)

</div>

WISCI gives you four commands — **Write**, **Isolate**, **Select**, **Compress** — that keep your sessions sharp. Save what matters, load only what's relevant, research without polluting your context, and hand off cleanly between sessions. Version 2 makes the loop close itself: a deterministic staleness engine, per-stream handoffs that never clobber each other, and session hooks that surface your stored context without being asked.

## Installation

WISCI skills use the [Agent Skills open standard](https://agentskills.io) (`SKILL.md` format), supported across all major AI coding agents. The staleness engine requires `git` and `python3` (both preinstalled on macOS/Linux dev machines).

<table>
<tr>
  <th width="200">Platform</th>
  <th>How to install</th>
</tr>
<tr>
  <td><strong>Claude Code</strong></td>
  <td><code>claude plugin marketplace add ph3on1x/wisci</code><br><code>claude plugin install wisci</code></td>
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

> [!NOTE]
> `/isolate` uses subagent spawning, which works best on Claude Code and Codex CLI. Session hooks and dynamic state injection are Claude Code features — on other platforms the skills degrade gracefully to plain instructions.

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
  <td>Saves your findings to <code>.wisci/context/auth-research.md</code> with file references that track staleness</td>
</tr>
<tr>
  <td>"I need to research something without cluttering my session"</td>
  <td><code>/isolate compare OAuth2 libraries for Node.js</code></td>
  <td>Subagents handle it in isolated windows; results appear inline and durable findings are auto-persisted to the store</td>
</tr>
<tr>
  <td>"Where was I?"</td>
  <td><code>/select</code></td>
  <td>Loads a (cached) codebase primer + your handoff streams + a staleness-checked inventory of stored context</td>
</tr>
<tr>
  <td>"I need my auth research back"</td>
  <td><code>/select auth-research</code></td>
  <td>Loads that context file, auto-stripping any sections whose source files have changed</td>
</tr>
<tr>
  <td>"Done for the day"</td>
  <td><code>/compress</code></td>
  <td>Snapshots each work stream to its own handoff file — parallel streams and other sessions' handoffs are never overwritten</td>
</tr>
<tr>
  <td>"Time to commit"</td>
  <td><code>/commit</code></td>
  <td>Creates a conventional commit with a <code>Context:</code> section that logs AI-layer changes — turning <code>git log</code> into long-term memory</td>
</tr>
</table>

## The Problem

LLM context windows degrade in four predictable ways — each addressed by a specific WISCI command:

- **Context Poisoning** — Wrong facts persist and compound across a session. `/write` preserves exact facts with source tracking. `/select` auto-strips sections whose referenced files have changed.

- **Context Distraction** — The model fixates on accumulated history instead of using its training. `/isolate` keeps research noise in separate windows. `/compress` deliberately compacts to stay in the effective range.

- **Context Confusion** — Irrelevant information leads to wrong tool selection and document usage. `/select` loads only relevant, validated context. `/isolate` gives each agent a clean, focused window.

- **Context Clash** — Information gathered incrementally across turns creates internal contradictions. `/write` uses section-level merge to consolidate without contradictions.

These failures are not edge cases — they are the default outcome of long-running sessions. Context quality degrades significantly past 40% utilization, yet most tools only react at 95% when auto-compaction kicks in. By then, the damage is done.

## How It Works

The commands form a closed loop — each session builds on the last, and hooks keep the loop running without you remembering it:

*session start (hook announces store)* → **`/select`** → work → **`/isolate`** (auto-persists via `/write`) → **`/compress`** → **`/commit`** → *new session* → ...

### The store: `.wisci/`

```
.wisci/
├── context/<topic>.md      # knowledge — /write target, section-level merge
├── handoff/<stream>.md     # work state — /compress target, one file per stream
├── handoff.md              # stream index — GENERATED by script, never hand-edited
└── primer.md               # cached codebase overview with its own staleness manifest
```

A dotfolder on purpose: stored context enters sessions only through `/select`, validated — never accidentally slurped by an unrelated file search.

- **Deterministic staleness engine** — `scripts/wisci.py` (python3 stdlib) classifies every stored file as `fresh` / `stale` / `broken`, anchored to git commit hashes (rebase-proof) and including uncommitted working-tree changes. One script call replaces dozens of model-driven git commands.
- **Per-stream handoffs** — each independent work stream gets its own file. A second session compressing different work creates a new leaf; it structurally *cannot* clobber the first. The index is derived from leaf frontmatter, so it can never drift.
- **Auto-stripping** — `/select` removes stale sections before loading and reports what every load costs in tokens.
- **Cached primer** — the codebase overview is derived once and cached; it regenerates only when referenced configs or the directory structure actually change.
- **Proactive hooks** (Claude Code) — session start announces the store state; pre-compaction instructions preserve paths, decisions, and next steps; post-compaction sessions are reminded to `/compress`.
- **Git as long-term memory** — `/commit` appends a `Context:` section to commits, making the context system's evolution queryable in `git log`.
- **Evals** — `evals/run.py` tests skill triggering (should-fire / should-not-fire prompt sets) and end-to-end behavior against fixture repos. See `evals/run.py --help`.

## Migrating from v1

v2 replaces `scratchpad/` with the structured `.wisci/` store (clean break — skills no longer read `scratchpad/`):

```bash
mkdir -p .wisci/context .wisci/handoff
git mv scratchpad/handoff*.md .wisci/handoff/ 2>/dev/null || true
git mv scratchpad/*.md .wisci/context/ 2>/dev/null || true
rmdir scratchpad 2>/dev/null || true
```

Old handoff files lack the v2 frontmatter (`status` / `updated` / `goal`) — the first `/compress` that touches a stream adds it.

## Real-World Scenarios

### Building a feature across multiple sessions

**Session 1 — Research and plan:**
```
> /select auth-layer
  (deep dive into auth middleware, token handling, session management — results appear inline)

> /isolate compare JWT vs session-based auth for our use case
  (subagents research in isolated windows — synthesis inline, durable findings persisted to .wisci/context/)

> /compress
  (creates .wisci/handoff/auth-refactor.md: goal, decisions, "Next: implement token refresh")
```

**Session 2 — Implement:**
```
  (session starts: "WISCI: 2 context files, 1 active stream. /select to load.")

> /select
  (cached primer loads instantly; shows auth-refactor stream + fresh context files)

> /select auth-refactor
  (loads the handoff — exact state, next steps, references all validated)

  ... implement the feature ...

> /commit feat: add token refresh to auth middleware
  (commits with Context: section tracking .wisci/ changes)
```

### Parallel work streams, zero clobbering

```
> /compress                       # Monday: working on auth
  (writes .wisci/handoff/auth-refactor.md)

> /compress                       # Tuesday, different session: CI work
  (writes .wisci/handoff/ci-migration.md — auth-refactor.md untouched, index lists both)

> /select ci-migration            # Wednesday: pick either stream
```

### Picking up a teammate's work

```
> /select
  (shows: payment-integration.md — stale, src/payments/handler.ts changed 2 days ago)

> /select payment-integration
  (loads with stale sections auto-stripped: "2 sections stripped. Consider /write to refresh.")

  ... review what's still valid, continue the work ...

> /write payment-integration
  (section-level merge refreshes the file; references rebuilt)
```

## Acknowledgments

WISCI builds on foundational work in context engineering:

- **Lance Martin / LangChain** — The [WISC taxonomy](https://blog.langchain.com/context-engineering-for-agents/) (Write, Isolate, Select, Compress)
- **Andrej Karpathy** — The [context engineering framing](https://x.com/karpathy/status/1937884699741483308) (LLM as CPU, context window as RAM, external storage as disk)
- **Drew Breunig** — The [four failure modes taxonomy](https://www.dbreunig.com/2025/05/22/context-engineering.html) (poisoning, distraction, confusion, clash)
- **Anthropic** — [Claude Code](https://github.com/anthropics/claude-code) and the [Agent Skills standard](https://agentskills.io)
- **Manus, Cline, llms.txt, Obsidian MOC** — prior art informing the v2 store design (restorable compression, memory-bank criticism, derived index files)

## License

[MIT](LICENSE)
