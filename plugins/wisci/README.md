# WISCI — Context Engineering Framework for Claude Code

WISCI gives Claude Code four slash commands for proactive context management: **Write**, **Isolate**, **Select**, **Compress**, plus an **Iterate** philosophy. It solves the core problems of working with LLMs — context window limits, session transitions, and stale information — by externalizing knowledge to persistent, staleness-tracked files.

## Installation

```
/plugin marketplace add ph3on1x/wisci
/plugin install wisci@wisci-marketplace
```

## Commands

| Command | Description |
|---------|-------------|
| `/write <topic>` | Externalize context to persistent scratchpad files with structured sections and reference tracking |
| `/select [topic]` | Load context — bare invocation gives a codebase overview + scratchpad listing; with arguments, performs a targeted deep dive |
| `/isolate <task>` | Delegate research to 1-3 subagents with isolated context windows, keeping results inline |
| `/compress [scope]` | Create a compressed handoff document for session transitions |

## The Iterate Philosophy

The "I" in WISCI stands for Iterate — the continuous loop of writing context, selecting it back, isolating research, and compressing for handoff. It's a philosophy of refinement, not a fifth command. Each cycle sharpens the context your sessions work with.

## How It Works

WISCI stores context in `scratchpad/` as topic-based markdown files. Each file includes a `## References` section that lists every source file it depends on. When you run `/select`, WISCI checks git history to detect whether referenced files have changed since the context was last written — stale sections are automatically stripped, and broken references (deleted files) are flagged. This prevents the most common failure mode in long-running projects: acting on outdated information.

### Typical Workflow

1. **Research** — Use `/isolate` to explore a topic with dedicated subagents
2. **Save** — Use `/write` to persist findings to `scratchpad/`
3. **Resume** — Use `/select` to reload context in a new session (stale content auto-stripped)
4. **Handoff** — Use `/compress` to create a minimal handoff document when switching tasks

## License

[MIT](LICENSE)
