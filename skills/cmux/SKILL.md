---
name: using-cmux
description: This skill should be used when running inside a cmux terminal and needing to orchestrate subagents in split panes, monitor agent output, coordinate parallel work, automate browsers, or manage notifications. Triggers include CMUX_* environment variables present, the user asking to "split pane", "run agents in parallel", "monitor subagent", "read terminal output", "open browser in cmux", "notify me", "create workspace", "check surface health", or any cmux terminal management task.
---

# Using cmux

cmux is a macOS terminal built for AI coding agents. The session runs inside cmux when `CMUX_SOCKET_PATH` is set.

## Quick Orientation

```bash
cmux identify --json    # Current workspace, pane, surface
cmux tree --json        # Full hierarchy of windows/workspaces/panes/surfaces
```

**Hierarchy:** Window -> Workspace (sidebar tab) -> Pane (split region) -> Surface (terminal or browser tab)

**Refs format:** `workspace:2`, `pane:1`, `surface:7` — always prefer short refs over UUIDs.

### Environment Variables (Auto-Set)

| Variable | Purpose |
|----------|---------|
| `CMUX_SOCKET_PATH` | Control socket (CLI uses automatically) |
| `CMUX_WORKSPACE_ID` | Current workspace UUID |
| `CMUX_SURFACE_ID` | Current surface UUID |

Commands default to the current workspace/surface when flags are omitted.

## Subagent Orchestration

The core pattern for running multiple agents in parallel, each in its own pane.

### Creating Panes

```bash
cmux new-split right                    # Vertical split (creates new pane + surface)
cmux new-split down                     # Horizontal split
cmux new-pane --direction right         # Alternative, supports --type terminal|browser
```

After splitting, identify the new surface:

```bash
cmux list-panes                         # List all panes with surface refs
cmux tree --json                        # Full topology with all refs
```

### Launching Subagents

Send commands to any surface by ref:

```bash
cmux send --surface surface:5 "claude 'implement auth module'\n"
cmux send --surface surface:6 "claude 'write unit tests'\n"
```

Use `send-key` for control sequences:

```bash
cmux send-key --surface surface:5 ctrl+c    # Interrupt a process
cmux send-key --surface surface:5 enter      # Send Enter
```

### Monitoring Subagent Output

Read terminal content from any surface without switching to it:

```bash
# Read current screen content
cmux read-screen --surface surface:5

# Read with scrollback history
cmux read-screen --surface surface:5 --scrollback

# Read last N lines only
cmux read-screen --surface surface:5 --lines 50

# Pipe output to a shell command for processing
cmux pipe-pane --surface surface:5 --command "grep -c 'DONE'"
```

`read-screen` (alias: `capture-pane`) is the primary tool for checking whether a subagent has finished, encountered errors, or produced results.

### Sidebar Status & Progress

Provide orchestration visibility in the sidebar:

```bash
# Set a status pill (key is unique per tool)
cmux set-status "agent-1" "running" --icon "terminal" --color "#00ff00"
cmux set-status "agent-2" "testing" --icon "test" --color "#ffaa00"

# Show progress bar (0.0 to 1.0)
cmux set-progress 0.5 --label "2 of 4 agents complete"

# Append log entries with severity levels
cmux log "Agent 1 finished auth module" --level success
cmux log "Agent 2 hit test failure" --level warning
cmux log --level error "Build failed in surface:6"

# Read back all sidebar state
cmux sidebar-state
```

Clean up after orchestration:

```bash
cmux clear-status "agent-1"
cmux clear-progress
cmux clear-log
```

### Synchronization

Named synchronization tokens for coordinating between agents:

```bash
# In surface:5 — agent signals completion
cmux wait-for --signal auth-complete

# In main pane — wait for that signal (blocks until signaled or timeout)
cmux wait-for auth-complete --timeout 300
```

### Cleanup

Close individual surfaces when agents finish:

```bash
cmux close-surface --surface surface:5
cmux close-surface --surface surface:6
```

Check surface health before cleanup:

```bash
cmux surface-health                     # Health details for all surfaces in workspace
```

### Inter-Pane Data Sharing

Share data between panes using named buffers:

```bash
# Store result from one agent
cmux set-buffer --name "auth-result" "JWT module implemented at src/auth.ts"

# Retrieve in another context
cmux paste-buffer --name "auth-result" --surface surface:6
```

For detailed orchestration patterns, advanced multi-agent workflows, and error recovery, consult **`references/orchestration.md`**.

## Browser Automation

**Core workflow:** Open -> Snapshot (get refs) -> Act with refs -> Wait for changes.

```bash
# Open browser (returns surface ref)
cmux browser open https://example.com --json

# Take interactive snapshot — ALWAYS use --interactive
cmux browser surface:7 snapshot --interactive

# Interact using element refs (e1, e2, etc.) — never CSS selectors
cmux browser surface:7 click e2
cmux browser surface:7 fill e3 "search query"

# Wait for navigation, then re-snapshot (DOM changes invalidate refs)
cmux browser surface:7 wait --load-state complete --timeout-ms 15000
cmux browser surface:7 snapshot --interactive
```

For the complete browser API (forms, keyboard, scrolling, finding elements, JS eval, session/state, cookies, diagnostics), consult **`references/browser-automation.md`**.

## Notifications

Two notification systems for different contexts:

```bash
# In-app: blue ring, sidebar badge, notification panel
cmux notify --title "Claude Code" --body "Waiting for approval"

# System-level: macOS Notification Center, sounds, visible outside cmux
osascript -e 'display notification "Build complete" with title "Claude Code" sound name "Submarine"'
```

| Need | Use |
|------|-----|
| User is in cmux | `cmux notify` |
| User may be in another app | `osascript` with sound |
| Context-aware (pane/workspace) | `cmux notify` |
| Must persist after cmux closes | `osascript` |

For the full notification comparison, hook integration, and decision matrix, consult **`references/notifications.md`**.

## Reading Terminal Output

`read-screen` is the critical tool for observing what any terminal surface is displaying:

```bash
# Current visible content (what appears on screen right now)
cmux read-screen --surface surface:5

# Include scrollback buffer for full history
cmux read-screen --surface surface:5 --scrollback

# Last N lines — efficient for checking recent output
cmux read-screen --surface surface:5 --lines 20

# Process output through a shell command
cmux pipe-pane --surface surface:5 --command "tail -5"
```

To detect whether a Claude Code agent has completed, read the last few lines and look for the shell prompt (`$` or `>`), or specific completion indicators in the output.

## Workspace Management

```bash
cmux new-workspace --cwd /path/to/project    # New workspace with working directory
cmux new-workspace --cwd /proj --command "claude 'do task'\n"  # With startup command
cmux select-workspace --workspace workspace:2 # Switch workspaces
cmux close-workspace --workspace workspace:3  # Close workspace
cmux list-workspaces                          # List all workspaces
cmux rename-workspace "auth-feature"          # Rename current workspace
cmux find-window --content "error" --select   # Find workspace by terminal content
```

## Claude Code Hook Integration

cmux provides a built-in hook for Claude Code session lifecycle:

```bash
cmux claude-hook session-start   # Mark session as active (alias: active)
cmux claude-hook stop            # Mark session as idle (alias: idle)
cmux claude-hook notification    # Forward notification (alias: notify)
cmux claude-hook prompt-submit   # Handle prompt submission
```

These hooks update sidebar metadata automatically — showing active/idle status, suppressing redundant notifications, and tracking agent PIDs.

## Command Quick Reference

| Task | Command |
|------|---------|
| Where am I? | `cmux identify --json` |
| Full topology | `cmux tree --json` |
| Split pane | `cmux new-split right\|down` |
| Send to surface | `cmux send --surface surface:N "cmd\n"` |
| Send key event | `cmux send-key --surface surface:N ctrl+c` |
| Read screen | `cmux read-screen --surface surface:N --lines 50` |
| Set status pill | `cmux set-status "key" "value"` |
| Set progress | `cmux set-progress 0.5 --label "text"` |
| Log message | `cmux log "message" --level info` |
| Wait for signal | `cmux wait-for <name> --timeout 30` |
| Signal done | `cmux wait-for --signal <name>` |
| Close surface | `cmux close-surface --surface surface:N` |
| Surface health | `cmux surface-health` |
| Open browser | `cmux browser open <url> --json` |
| Get element refs | `cmux browser surface:N snapshot --interactive` |
| Click element | `cmux browser surface:N click e3` |
| In-app notify | `cmux notify --title T --body B` |
| Store buffer | `cmux set-buffer --name "key" "value"` |
| Flash pane | `cmux trigger-flash` |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using UUIDs everywhere | Use short refs: `workspace:2`, `surface:7` |
| No way to check subagent progress | Use `cmux read-screen --surface surface:N --lines 50` |
| CSS selectors in browser | Use element refs from `snapshot --interactive`: `e3`, `e5` |
| Forgetting `--interactive` on snapshot | Always use `--interactive` to get element refs |
| Not waiting after navigation | Use `wait --load-state complete` after page loads |
| Not re-snapshotting after navigation | DOM changes invalidate refs — re-snapshot |
| Using cmux notify for system alerts | Use `osascript` when user may be outside cmux |
| No visibility into orchestration | Use `set-status`, `set-progress`, `log` for sidebar updates |
| Low-level input commands | Use high-level: `click`, `fill`, `type` instead of `input_*` |

## Additional Resources

### Reference Files

- **`references/orchestration.md`** — Advanced multi-agent patterns, error recovery, polling loops, workspace-per-project strategies
- **`references/browser-automation.md`** — Complete browser API: forms, keyboard, scrolling, finding elements, JS eval, session/state, cookies, diagnostics, WKWebView limitations
- **`references/notifications.md`** — Notification comparison, decision matrix, hook integration, Claude Code hook configuration
- **`references/complete-cli.md`** — Full cmux CLI catalog: every command, flag, and capability organized by category
