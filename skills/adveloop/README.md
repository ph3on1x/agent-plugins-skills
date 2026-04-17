# adveloop

A Claude Code plugin that runs an adversarial development loop:

- **Planner** (your interactive session) collaborates with you to define deliverables, then drives a Generator and Evaluator through each one.
- **Generator** builds or fixes the deliverable in a fresh cmux pane.
- **Evaluator** examines the work in a fresh pane and returns pass/fail + notes.
- Feedback loops back to the Generator on failure (default: up to 3 retries, then Planner asks you).

Each deliverable can start from either end of that loop. Build new code with `Mode: build` (Generator first); audit or fix existing code with `Mode: review` (Evaluator first — if it passes the initial review, the Generator never runs).

## Prerequisites

- **cmux** — `/adveloop` must run inside a cmux session (`CMUX_SOCKET_PATH` set).
- **`/cmux` skill** — install [claude-cmux-skill](https://github.com/ph3on1x/claude-cmux-skill) via the plugin marketplace. adveloop delegates every pane/signal operation to it.

If either is missing, `/adveloop` halts on the first turn with a clear message.

## Install

Inside Claude Code, add both marketplaces and install:

```
/plugin marketplace add ph3on1x/claude-cmux-skill
/plugin install cmux@claude-cmux-skill

/plugin marketplace add ph3on1x/adveloop
/plugin install adveloop@adveloop
```

The first pair installs the required `/cmux` skill; the second installs adveloop itself. To update later, run `/plugin marketplace update adveloop`.

## Usage

```
/adveloop [short product description or review scope]
```

Examples:

- `/adveloop "minimal URL shortener with SQLite"` — build from scratch (Planner drafts build-mode deliverables by default).
- `/adveloop "review /login for XSS and input validation and fix any issues found"` — review existing code; the Evaluator runs first against the codebase, then the Generator fixes what the Evaluator flagged.
- Mixed runs are fine: one description can produce both `build` and `review` deliverables, and the Planner runs them in order.

The Planner will:

1. Work with you to define 3–8 deliverables — concrete, testable outcomes. Each one carries a `Mode` (`build` or `review`) the Planner infers from intent and shows in the approval screen. Iterate via AskUserQuestion until you approve.
2. For each deliverable, run the loop appropriate to its mode:
   - **`build`**: spawn the Generator, wait for it, spawn the Evaluator, wait for its verdict.
   - **`review`**: spawn the Evaluator first against the existing codebase. If it passes, deliverable done — zero Generator runs. If it fails, the verdict becomes the first feedback round and the Generator is spawned to fix the issues, then the Evaluator re-checks.
3. On pass → advance. On fail → feedback goes into the next Generator round. After 3 failed Gen→Eval rounds, the Planner asks whether to retry more, edit the deliverable, skip, or abort. (The free initial review in review mode doesn't consume a retry slot — review deliverables still get 3 fix attempts.)

If `.adveloop/deliverables.md` already exists when you re-run `/adveloop`, you'll be offered continue / rewrite / abort. If you hand-edited the file between runs (especially `Mode` fields), prefer rewrite — the Planner only inspects artifacts, not semantic changes.

## Deliverable modes

| Mode | Starting point | Use for |
|---|---|---|
| `build` (default) | Generator runs first, Evaluator verifies | Greenfield features, new endpoints, new modules |
| `review` | Evaluator runs first against existing code | Audits, hardening passes, bug hunts, fixing/polishing existing code |

Mode is recorded per deliverable in `.adveloop/deliverables.md`:

```
## 1. Harden /login against XSS
Mode: review

The /login handler must reject unsafe input, escape all rendered user data, and
return 400 with a structured error on malformed payloads. Evaluator confirms by
exercising the endpoint with sample XSS payloads.
```

A deliverable missing the `Mode:` line is treated as `build` for backward compatibility with older `.adveloop/` directories.

## Files adveloop owns

```
.adveloop/
├── deliverables.md            # approved list; leading HTML comment carries run_id
└── tasks/
    └── <N>/
        ├── gen-task.md        # deliverable + prior feedback + signal name
        ├── gen-result.md      # Generator's summary
        ├── eval-task.md       # deliverable + Generator summary + signal name
        ├── eval-result.json   # {"passed": bool, "notes": string}
        └── feedback-<R>.json  # evaluator verdict from failed round R (in review mode, feedback-0.json is the initial review's verdict)
```

Generated application code goes to your project root directly. Add `.adveloop/` to your `.gitignore` if you don't want the metadata tracked — `/adveloop` offers to do this on first run.

## Design

- **Single Planner session** drives the loop. If it crashes, re-run `/adveloop` — the Planner reads `.adveloop/` and asks whether to continue or rewrite.
- **Fresh `claude` session per pane, per retry**, for maximum context isolation.
- **Signals are namespaced** with a `run_id` timestamp (e.g. `adveloop-2026-04-17-1523-gen-done-2-1`), so stale signals from a prior run cannot accidentally unblock the current one.
- **adveloop never invokes `cmux` directly.** All cmux operations go through the `/cmux` skill.
- **Shell safety**: dynamic content (deliverables, feedback) is written to a task file on disk. The pane's bootstrap message only says "read this file and follow it." Backticks and `$(…)` in the deliverable can never be executed by the pane's shell.

## Spawn flags

Spawned panes are launched with:

| Flag | Purpose |
|---|---|
| `--dangerously-skip-permissions` | Full autonomy inside the pane. You've already approved by running `/adveloop`. |
| `--append-system-prompt-file <path>` | Role instructions read directly by `claude`. No shell interpolation of role text, so markdown backticks are safe. |
| `--name adveloop-{gen,eval}-<run_id>-<N>-<retry>` | Each pane's title identifies it unambiguously. |

Env: `DISABLE_AUTOUPDATER=1`, `DISABLE_COST_WARNINGS=1` — no mid-run pauses.

Deliberately NOT passed: `--model` (inherits parent), `-p` (cmux requires interactive mode), `-c` / `--resume` (fresh session per retry).

