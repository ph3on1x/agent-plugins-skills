<div align="center">

# claude-cmux-skill

**Orchestrate independent Claude Code sessions in cmux — split panes, monitor agents, automate browsers, coordinate parallel work**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.5.0-green.svg)]()
[![Agent Skills](https://img.shields.io/badge/Agent_Skills-Standard-blueviolet.svg)](https://agentskills.io)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-orange.svg)](https://github.com/anthropics/claude-code)
[![cmux](https://img.shields.io/badge/cmux-Terminal-blue.svg)](https://github.com/manaflow-ai/cmux)
[![macOS](https://img.shields.io/badge/macOS-14.0+-999999.svg)](https://www.apple.com/macos/)

Running multiple AI agents but can't see what they're doing?<br>
That's what happens when your terminal wasn't built for agent orchestration.

[Installation](#installation) • [Usage](#when-to-use-what) • [The Problem](#the-problem) • [How It Works](#how-it-works) • [Examples](#real-world-scenarios)

</div>

This skill teaches Claude Code how to use [cmux](https://github.com/manaflow-ai/cmux) — a native macOS terminal built for AI coding agents. It auto-triggers when running inside cmux and provides full coverage of pane splitting, launching and monitoring independent Claude Code sessions, browser automation, sidebar metadata, notifications, and inter-pane coordination.

## Installation

<table>
<tr>
  <th width="200">Platform</th>
  <th>How to install</th>
</tr>
<tr>
  <td><strong>Claude Code</strong></td>
  <td><code>claude plugin marketplace add ph3on1x/claude-cmux-skill</code><br><code>claude plugin install claude-cmux-skill</code></td>
</tr>
</table>

> [!NOTE]
> Requires [cmux](https://github.com/manaflow-ai/cmux) (macOS 14.0+) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI. The skill auto-triggers when `CMUX_*` environment variables are detected — no slash command needed.

## When to Use What

<table>
<tr>
  <th width="280">You're thinking...</th>
  <th width="280">Use</th>
  <th>What happens</th>
</tr>
<tr>
  <td>"I need three agents working in parallel"</td>
  <td>Ask Claude to split panes and launch agents</td>
  <td>Creates split panes, launches independent Claude Code sessions, monitors output via <code>read-screen</code>, coordinates with sync tokens</td>
</tr>
<tr>
  <td>"What's my other agent doing?"</td>
  <td>Ask Claude to check agent progress</td>
  <td>Reads terminal output from any surface without switching to it, reports status</td>
</tr>
<tr>
  <td>"I need to test this in a browser"</td>
  <td>Ask Claude to open a browser pane</td>
  <td>Opens browser surface, snapshots for element refs, interacts via <code>click</code>/<code>fill</code> — no CSS selectors</td>
</tr>
<tr>
  <td>"Notify me when the build finishes"</td>
  <td>Ask Claude to set up a notification</td>
  <td>Uses <code>cmux notify</code> (in-app) or <code>osascript</code> (system-level) based on context</td>
</tr>
<tr>
  <td>"I need agents to share data"</td>
  <td>Ask Claude to use buffers or sync tokens</td>
  <td>Stores results in named buffers, signals completion with <code>wait-for</code> tokens</td>
</tr>
</table>

## The Problem

AI coding agents are powerful individually. But when you need multiple agents working in parallel:

- **No visibility** — you can't see what other agents are doing without switching panes manually
- **No coordination** — agents can't signal completion or share results with each other
- **No orchestration** — splitting work across panes, monitoring progress, and collecting results requires manual effort

## How It Works

The skill uses **progressive disclosure** — core concepts load automatically when triggered, while detailed references load only when Claude needs them.

```
claude-cmux-skill/
├── .claude-plugin/
│   ├── plugin.json              # Plugin metadata
│   └── marketplace.json         # Marketplace catalog
├── hooks/
│   └── hooks.json               # Agent tool blocking + lifecycle hooks
└── skills/
    └── using-cmux/
        ├── SKILL.md             # Core skill (auto-triggers)
        └── references/
            ├── orchestration.md       # Multi-agent patterns
            ├── browser-automation.md  # Full browser API
            ├── notifications.md       # Notification systems
            └── complete-cli.md        # Complete CLI catalog
```

### Key Capabilities

<table>
<tr>
  <th width="200">Capability</th>
  <th>What Claude can do</th>
</tr>
<tr>
  <td><strong>Agent Orchestration</strong></td>
  <td>Split panes, launch independent Claude Code sessions, monitor output via <code>read-screen</code>, coordinate with <code>wait-for</code> sync tokens, track progress in sidebar</td>
</tr>
<tr>
  <td><strong>Terminal I/O</strong></td>
  <td>Read terminal output from any surface, pipe through commands, share data between panes via named buffers</td>
</tr>
<tr>
  <td><strong>Browser Automation</strong></td>
  <td>Snapshot-based browser control with element refs — <code>click</code>, <code>fill</code>, <code>type</code> using refs like <code>e3</code> instead of CSS selectors</td>
</tr>
<tr>
  <td><strong>Sidebar Metadata</strong></td>
  <td>Status pills, progress bars, and log entries for real-time orchestration visibility</td>
</tr>
<tr>
  <td><strong>Notifications</strong></td>
  <td>Context-aware selection between in-app (<code>cmux notify</code>) and system-level (<code>osascript</code>) alerts</td>
</tr>
<tr>
  <td><strong>Workspace Management</strong></td>
  <td>Create, switch, rename, and close workspaces with optional startup commands</td>
</tr>
</table>

## Real-World Scenarios

### Parallel feature implementation

```
You: "Implement auth and payments modules in parallel"

Claude splits two panes, launches an independent session in each:
  surface:5 → "claude 'implement auth module'"
  surface:6 → "claude 'implement payments module'"

Claude monitors both via read-screen, updates sidebar progress,
and collects results when sessions finish.
```

### Browser testing with agent oversight

```
You: "Open the app in a browser and verify the login flow works"

Claude opens a browser surface, navigates to localhost:3000,
snapshots the page for element refs, fills the login form,
clicks submit, waits for navigation, and re-snapshots to
verify the dashboard loaded.
```

### Multi-agent coordination with data sharing

```
You: "Research the API, then have another agent write tests based on findings"

Agent 1 explores the API, stores findings in a named buffer:
  cmux set-buffer --name "api-findings" "endpoints: /users, /orders..."

Agent 1 signals completion:
  cmux wait-for --signal api-research-done

Agent 2 was waiting for the signal, retrieves the buffer,
and writes tests based on the shared findings.
```

## Acknowledgments

- **[cmux](https://github.com/manaflow-ai/cmux)** — The native macOS terminal for AI coding agents
- **Anthropic** — [Claude Code](https://github.com/anthropics/claude-code) and the [Agent Skills standard](https://agentskills.io)

## License

[MIT](LICENSE)
