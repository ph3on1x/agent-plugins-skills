# claude-cmux-skill

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A comprehensive skill for integrating [cmux](https://github.com/manaflow-ai/cmux) terminal features into [Claude Code](https://claude.ai/code) agents.

## What is cmux?

`cmux` is a native macOS terminal built specifically for AI coding agents. It provides:
- **Split Panes & Subagent Orchestration**: Run multiple agents in isolated panes, monitor their output, coordinate with sync tokens.
- **Terminal I/O**: Read screen output from any surface, pipe to commands, share data via buffers.
- **Browser Automation**: Full scriptable browser with element refs, form filling, waiting, and state persistence.
- **Sidebar Metadata**: Status pills, progress bars, and log entries for orchestration visibility.
- **Notifications**: Context-aware in-app alerts and macOS system notifications.

## What's Included

This is a Claude Code plugin that teaches agents how to leverage `cmux` effectively, with a focus on multi-agent orchestration.

```
cmux-skill/
├── .claude-plugin/
│   ├── plugin.json         # Plugin metadata
│   └── marketplace.json    # Marketplace catalog
└── skills/
    └── using-cmux/
        ├── SKILL.md                          # Core skill (auto-triggers)
        └── references/
            ├── orchestration.md              # Multi-agent orchestration patterns
            ├── browser-automation.md         # Full browser command reference
            ├── notifications.md              # Notification systems & hooks
            └── complete-cli.md              # Complete CLI command catalog
```

The skill uses **progressive disclosure** — core concepts load automatically when triggered, while detailed references load only when Claude needs them.

## Key Features

- **Subagent Orchestration** — Create panes, launch agents, monitor output via `read-screen`, coordinate with `wait-for`, track progress in sidebar.
- **Terminal I/O** — Read terminal output from any surface, pipe through commands, share data between panes via buffers.
- **Element-Ref Browser Control** — Snapshot-based browser automation with persistent element refs.
- **Intelligent Notification Matrix** — Context-aware selection between `cmux notify` and `osascript`.
- **Full CLI Coverage** — Complete reference for 100+ cmux commands across windows, workspaces, panes, surfaces, browser, notifications, and sidebar.

## Installation

### Prerequisites

- [cmux](https://github.com/manaflow-ai/cmux) must be installed (macOS 14.0+).
- [Claude Code](https://claude.ai/code) CLI must be installed.

### Plugin Install (Recommended)

In Claude Code, run:

```
/plugin marketplace add ph3on1x/claude-cmux-skill
/plugin install claude-cmux-skill@claude-cmux-skill
```

### Alternative: Plugin Manager UI

1. Run `/plugin` in Claude Code to open the plugin manager
2. Navigate to **Discover** tab
3. Search for "claude-cmux-skill" and install

## Usage

Once installed, Claude Code automatically detects the skill when running inside a `cmux` environment (detected via `CMUX_*` environment variables). No slash command needed — the skill triggers automatically based on context.

- **Automatic Usage**: Claude uses `cmux` features when tasks involve terminal management, parallel agents, or browser automation.
- **Manual Invocation**: Explicitly ask Claude to "use the using-cmux skill" if needed.

## Updating

```
/plugin update claude-cmux-skill@claude-cmux-skill
```

## Uninstallation

```
/plugin uninstall claude-cmux-skill@claude-cmux-skill
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
