# adveloop

A Claude Code plugin that runs an adversarial development loop:

- **Planner** (your interactive session) collaborates with you to define deliverables, then drives a Generator and Evaluator through each one.
- **Generator** builds the deliverable in a fresh cmux pane.
- **Evaluator** examines the work in a fresh pane and returns pass/fail + notes.
- Feedback loops back to the Generator on failure (default: up to 3 retries, then Planner asks you).

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
/adveloop [short product description]
```

The Planner will:

1. Work with you to define 3–8 deliverables — concrete, testable outcomes. Iterate via AskUserQuestion until you approve.
2. For each deliverable: spawn the Generator in a cmux pane, wait for it to finish, spawn the Evaluator, wait for its verdict.
3. On pass → advance. On fail → feedback goes into the next Generator round. After 3 fails, the Planner asks whether to retry more, edit the deliverable, skip, or abort.

If `.adveloop/deliverables.md` already exists when you re-run `/adveloop`, you'll be offered continue / rewrite / abort.

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
        └── feedback-<R>.json  # evaluator verdict from failed round R
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

