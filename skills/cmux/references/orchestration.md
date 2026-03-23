# Multi-Agent Orchestration Reference

Advanced patterns for running and coordinating multiple agents using cmux panes.

## Full Orchestration Lifecycle

### 1. Plan and Create Panes

Create one pane per agent task:

```bash
# Create splits for 3 parallel agents
cmux new-split right      # pane for agent 1
cmux new-split down       # pane for agent 2
cmux focus-pane --pane pane:1
cmux new-split down       # pane for agent 3

# Verify topology
cmux tree --json
```

Alternatively, create panes with specific types:

```bash
cmux new-pane --direction right --type terminal    # Terminal pane
cmux new-pane --direction down --type browser      # Browser pane
```

### 2. Launch Agents with Labels

Set sidebar status before launching each agent. **Use the surface ref as the status key** so the Stop hook automatically updates it to "done" when the agent finishes:

```bash
# Label and launch agent 1 (key = surface ref from new-split output)
cmux set-status "surface:3" "starting" --color "#3498db"
cmux send --surface surface:3 "claude 'implement user authentication'\n"

# Label and launch agent 2
cmux set-status "surface:4" "starting" --color "#2ecc71"
cmux send --surface surface:4 "claude 'write API integration tests'\n"

# Label and launch agent 3
cmux set-status "surface:5" "starting" --color "#e67e22"
cmux send --surface surface:5 "claude 'update database migrations'\n"

# Set overall progress
cmux set-progress 0.0 --label "0 of 3 agents complete"
```

### 3. Monitor Agent Progress

Poll agent output to track completion:

```bash
# Read last 30 lines from each surface
cmux read-screen --surface surface:3 --lines 30
cmux read-screen --surface surface:4 --lines 30
cmux read-screen --surface surface:5 --lines 30

# Check with scrollback for full history
cmux read-screen --surface surface:3 --scrollback

# Pipe output through a filter
cmux pipe-pane --surface surface:3 --command "grep -E '(error|complete|done|fail)'"
```

Indicators that a Claude Code agent has finished:
- `cmux list-status` shows `surface:N=done` (auto-set by Stop hook)
- The prompt has returned (look for `$` or `>` at the end)
- Output contains completion messages
- `surface-health` shows idle status

### 4. Coordinate with Synchronization

Use named sync tokens when agents have dependencies:

```bash
# Agent 1 signals when auth module is ready
# (Run this IN agent 1's task or send via cmux send)
cmux send --surface surface:3 "cmux wait-for --signal auth-ready\n"

# Agent 2 waits for auth before starting integration tests
cmux send --surface surface:4 "cmux wait-for auth-ready --timeout 600 && claude 'run integration tests'\n"
```

### 5. Collect Results

Read final output from each agent:

```bash
# Capture full scrollback for review
cmux read-screen --surface surface:3 --scrollback > /tmp/agent-1-output.txt
cmux read-screen --surface surface:4 --scrollback > /tmp/agent-2-output.txt

# Or use buffers for structured data passing
cmux set-buffer --name "agent-1-result" "$(cmux read-screen --surface surface:3 --lines 10)"
```

### 6. Update Progress and Clean Up

```bash
# Status pills auto-update to "done" via Stop hook — just update progress
cmux set-progress 0.33 --label "1 of 3 agents complete"

# After all agents finish, clean up
cmux clear-progress
cmux clear-status "surface:3"
cmux clear-status "surface:4"
cmux clear-status "surface:5"
cmux log "All agents completed successfully" --level success

# Close agent surfaces
cmux close-surface --surface surface:3
cmux close-surface --surface surface:4
cmux close-surface --surface surface:5
```

## Workspace-Per-Project Pattern

For large projects, isolate each agent in its own workspace:

```bash
# Create dedicated workspaces
cmux new-workspace --cwd /project/frontend --command "claude 'rebuild React components'"
cmux new-workspace --cwd /project/backend --command "claude 'optimize API endpoints'"
cmux new-workspace --cwd /project/infra --command "claude 'update Terraform configs'"

# Switch between them to check progress
cmux select-workspace --workspace workspace:2
cmux read-screen --lines 20

# Rename for clarity
cmux rename-workspace --workspace workspace:2 "frontend"
cmux rename-workspace --workspace workspace:3 "backend"
cmux rename-workspace --workspace workspace:4 "infra"
```

## Pane Layout Management

### Resize Panes

```bash
cmux resize-pane --pane pane:2 -R --amount 20    # Expand right by 20
cmux resize-pane --pane pane:2 -D --amount 10    # Expand down by 10
cmux resize-pane --pane pane:2 -L --amount 5     # Shrink from left by 5
```

### Swap and Rearrange

```bash
cmux swap-pane --pane pane:2 --target-pane pane:3   # Swap two panes
cmux break-pane --pane pane:2                        # Break out into own pane
cmux join-pane --target-pane pane:1                  # Join into another pane
```

### Move Surfaces Between Panes

```bash
cmux move-surface --surface surface:5 --pane pane:2
cmux drag-surface-to-split --surface surface:5 right  # Create new split with surface
```

## Error Recovery

### Detecting Failures

```bash
# Check for error indicators in output
cmux pipe-pane --surface surface:3 --command "grep -ci 'error\|failed\|exception'"

# Check surface health
cmux surface-health

# Read last lines for error messages
cmux read-screen --surface surface:3 --lines 10
```

### Restarting a Failed Agent

```bash
# Interrupt the current process
cmux send-key --surface surface:3 ctrl+c

# Option A: Clear and restart in the same shell
cmux clear-history --surface surface:3
cmux send --surface surface:3 "claude 'retry: implement auth module'\n"

# Option B: Respawn the shell entirely (cleaner — kills process and starts fresh)
cmux respawn-pane --surface surface:3
cmux send --surface surface:3 "claude 'retry: implement auth module'\n"

# Update sidebar status
cmux set-status "surface:3" "retrying" --color "#e74c3c"
```

### Emergency Stop All

```bash
# Send Ctrl+C to all agent surfaces
cmux send-key --surface surface:3 ctrl+c
cmux send-key --surface surface:4 ctrl+c
cmux send-key --surface surface:5 ctrl+c
```

## Sidebar Metadata Reference

### Status Pills

```bash
cmux set-status <key> <value> [--icon <name>] [--color <#hex>]
cmux clear-status <key>
cmux list-status
```

Keys are unique per tool. Common patterns:
- `"surface:N"` — per-agent tracking (auto-updated by SessionStart/Stop hooks)
- `"build"` — build status
- `"tests"` — test run status

### Progress Bar

```bash
cmux set-progress <0.0-1.0> [--label <text>]
cmux clear-progress
```

### Log Entries

```bash
cmux log <message> [--level <level>] [--source <name>]
cmux list-log [--limit <n>]
cmux clear-log
```

Levels: `info`, `progress`, `success`, `warning`, `error`

### Full State Dump

```bash
cmux sidebar-state    # Returns cwd, git branch, ports, status, progress, logs
```

## Practical Limits

- **5-7 concurrent agents** is the practical ceiling on a laptop before API rate limits, merge conflicts, and review bottlenecks dominate
- Each split consumes terminal resources; monitor with `surface-health`
- Agents sharing the same working directory may conflict on file writes — consider workspace-per-project isolation for write-heavy tasks
