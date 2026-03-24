# Multi-Agent Orchestration Reference

Advanced patterns for running and coordinating multiple agents using cmux panes.

## Full Orchestration Lifecycle

### 1. Plan and Create Balanced Panes

Create one pane per agent. **Always capture surface refs and use `--surface`** to target which pane to split — never rely on auto-focus.

```bash
# 3 agents → 2×2 grid (all panes equal size)
ORIG=$(cmux identify --json | awk -F'"' '/"surface_ref"/{print $4}')
S1=$(cmux new-split right | awk '{print $2}')
S2=$(cmux new-split down --surface $S1 | awk '{print $2}')
S3=$(cmux new-split down --surface $ORIG | awk '{print $2}')

# Layout: [orchestrator 25% | agent-1 25%]
#         [agent-3 25%      | agent-2 25%]

# Verify topology
cmux tree --json
```

For fewer agents:

```bash
# 1 agent — single split
S1=$(cmux new-split right | awk '{print $2}')

# 2 agents — split right, then subdivide
S1=$(cmux new-split right | awk '{print $2}')
S2=$(cmux new-split down --surface $S1 | awk '{print $2}')
```

For pane types other than terminal:

```bash
cmux new-pane --direction right --type browser      # Browser pane
```

### 2. Launch Agents with Labels

**Always use `claude -p 'prompt'`** — the `-p` flag runs non-interactively (agent works, then exits). Never save prompts to temp files; always pass inline.

**Always instruct agents to save output to `scratchpad/`** so results survive pane closure and the main agent can review them later.

Set sidebar status before launching each agent for visibility:

```bash
# Label and launch agent 1
cmux set-status "agent-1" "starting" --color "#3498db"
cmux send --surface $S1 "claude -p 'implement user authentication. When done, save a summary of changes to scratchpad/agent-1-auth.md'\n"

# Label and launch agent 2
cmux set-status "agent-2" "starting" --color "#2ecc71"
cmux send --surface $S2 "claude -p 'write API integration tests. When done, save a summary of results to scratchpad/agent-2-tests.md'\n"

# Label and launch agent 3
cmux set-status "agent-3" "starting" --color "#e67e22"
cmux send --surface $S3 "claude -p 'update database migrations. When done, save a summary of changes to scratchpad/agent-3-migrations.md'\n"

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
cmux send --surface surface:4 "cmux wait-for auth-ready --timeout 600 && claude -p 'run integration tests'\n"
```

### 5. Collect Results

Read persisted output from `scratchpad/` files. Since agents save their summaries there, results survive pane closure:

```bash
# Primary: read persisted output (use Read tool in Claude Code)
cat scratchpad/agent-1-auth.md
cat scratchpad/agent-2-tests.md
cat scratchpad/agent-3-migrations.md

# Fallback: read screen if scratchpad file missing (only works while pane is open)
cmux read-screen --surface surface:3 --scrollback
```

### 6. Update Progress and Clean Up

Close each agent's pane as soon as it finishes — don't wait to batch-close at the end. Since agents save output to `scratchpad/`, results persist after pane closure.

```bash
# When agent-1 finishes:
cmux set-status "agent-1" "done" --color "#27ae60"
cmux set-progress 0.33 --label "1 of 3 agents complete"
cmux close-surface --surface $S1      # Close immediately — output is in scratchpad/

# When agent-2 finishes:
cmux set-status "agent-2" "done" --color "#27ae60"
cmux set-progress 0.66 --label "2 of 3 agents complete"
cmux close-surface --surface $S2

# When agent-3 finishes:
cmux set-status "agent-3" "done" --color "#27ae60"
cmux set-progress 1.0 --label "3 of 3 agents complete"
cmux close-surface --surface $S3

# After ALL agents finish — clean up sidebar
cmux clear-progress
cmux clear-status "agent-1"
cmux clear-status "agent-2"
cmux clear-status "agent-3"
cmux log "All agents completed — results in scratchpad/" --level success
```

## Workspace-Per-Project Pattern

> **Special case only.** Use this pattern when agents need different `--cwd` project roots (e.g., separate monorepo packages). For parallel tasks within the same project, use `cmux new-split` to create panes instead — it's simpler, faster, and easier to monitor.

For large projects, isolate each agent in its own workspace:

```bash
# Create dedicated workspaces
cmux new-workspace --cwd /project/frontend --command "claude -p 'rebuild React components'"
cmux new-workspace --cwd /project/backend --command "claude -p 'optimize API endpoints'"
cmux new-workspace --cwd /project/infra --command "claude -p 'update Terraform configs'"

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
cmux send --surface surface:3 "claude -p 'retry: implement auth module'\n"

# Option B: Respawn the shell entirely (cleaner — kills process and starts fresh)
cmux respawn-pane --surface surface:3
cmux send --surface surface:3 "claude -p 'retry: implement auth module'\n"

# Update sidebar status
cmux set-status "agent-1" "retrying" --color "#e74c3c"
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
- `"agent-N"` — per-agent tracking
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
