# Complete cmux CLI Reference

Full catalog of cmux commands organized by category. Version 0.62.2+.

## Global Options

- `--id-format uuids|both` — control output format (default: refs)
- `--password <pw>` — socket auth (flag > `CMUX_SOCKET_PASSWORD` env > saved setting)
- `--json` — JSON output (supported on select commands)

Handles accept: UUIDs, short refs (`window:1`, `workspace:2`, `pane:3`, `surface:4`), or numeric indexes.

## System / Meta

| Command | Purpose |
|---------|---------|
| `cmux version` | Print version string |
| `cmux ping` | Check socket connectivity |
| `cmux capabilities` | Print server capabilities as JSON (methods, protocol, access mode) |
| `cmux identify [--workspace W] [--surface S] [--no-caller]` | Print server identity and caller context |
| `cmux tree [--all] [--workspace W] [--json]` | Print hierarchy of windows/workspaces/panes/surfaces |
| `cmux welcome` | Show welcome screen |
| `cmux shortcuts` | Open keyboard shortcuts settings |
| `cmux themes [list\|set\|clear]` | Theme management |
| `cmux feedback [--email E --body B [--image P ...]]` | Submit feedback |

## Window Management

| Command | Purpose |
|---------|---------|
| `cmux list-windows` | List open windows |
| `cmux current-window` | Print current window ID |
| `cmux new-window` | Create new window |
| `cmux focus-window --window W` | Focus (bring to front) a window |
| `cmux close-window --window W` | Close a window |

## Workspace Management

| Command | Purpose |
|---------|---------|
| `cmux list-workspaces` | List workspaces in current window |
| `cmux current-workspace` | Print current workspace ID |
| `cmux new-workspace [--cwd P] [--command T]` | Create workspace (optional cwd and startup command) |
| `cmux select-workspace --workspace W` | Switch to workspace |
| `cmux close-workspace --workspace W` | Close workspace |
| `cmux rename-workspace [--workspace W] <title>` | Rename workspace (`rename-window` is an alias) |
| `cmux move-workspace-to-window --workspace W --window W` | Move workspace to different window |
| `cmux reorder-workspace [--workspace W] [--index N\|--before W\|--after W]` | Reorder within window |
| `cmux workspace-action --action A [--workspace W]` | Context-menu actions: pin, unpin, rename, clear-name, move-up, move-down, move-top, close-others, close-above, close-below, mark-read, mark-unread |
| `cmux next-window` / `cmux previous-window` / `cmux last-window` | Cycle workspace selection |

## Pane Management

| Command | Purpose |
|---------|---------|
| `cmux list-panes [--workspace W]` | List panes in workspace |
| `cmux new-pane [--type terminal\|browser] [--direction left\|right\|up\|down] [--workspace W] [--url U]` | Create new pane |
| `cmux new-split <left\|right\|up\|down> [--workspace W] [--surface S]` | Split current pane |
| `cmux focus-pane [--pane P] [--workspace W]` | Focus a pane |
| `cmux resize-pane [--pane P] [-L\|-R\|-U\|-D] [--amount N]` | Resize pane (default: -R, amount 1) |
| `cmux swap-pane --pane P --target-pane P` | Swap two panes |
| `cmux break-pane [--pane P] [--surface S] [--no-focus]` | Break out into own pane |
| `cmux join-pane --target-pane P [--pane P] [--surface S] [--no-focus]` | Join into another pane |
| `cmux last-pane [--workspace W]` | Focus previously focused pane |

## Surface (Tab) Management

| Command | Purpose |
|---------|---------|
| `cmux new-surface [--type terminal\|browser] [--pane P] [--workspace W] [--url U]` | Create new surface in pane |
| `cmux close-surface [--surface S] [--workspace W]` | Close a surface |
| `cmux list-pane-surfaces [--workspace W] [--pane P]` | List surfaces in a pane |
| `cmux list-panels [--workspace W]` | List all surfaces in workspace |
| `cmux focus-panel --panel P [--workspace W]` | Focus a surface |
| `cmux move-surface [--surface S] [--pane P\|--workspace W\|--window W] [--before\|--after\|--index]` | Move surface |
| `cmux reorder-surface [--surface S] [--before\|--after\|--index]` | Reorder within pane |
| `cmux drag-surface-to-split --surface S <left\|right\|up\|down>` | Move surface into new split |
| `cmux rename-tab [--surface S] <title>` | Rename a tab |
| `cmux trigger-flash [--surface S]` | Flash unread indicator |
| `cmux refresh-surfaces` | Refresh surface snapshots |
| `cmux surface-health [--workspace W]` | Health details for surfaces |
| `cmux tab-action --action A [--surface S]` | Tab actions: rename, clear-name, close-left, close-right, close-others, new-terminal-right, new-browser-right, reload, duplicate, pin, unpin, mark-read, mark-unread |

## Terminal I/O

| Command | Purpose |
|---------|---------|
| `cmux send [--surface S] <text>` | Send text to terminal (`\n` = Enter, `\t` = Tab) |
| `cmux send-key [--surface S] <key>` | Send key event (enter, ctrl+c, etc.) |
| `cmux send-panel --panel P <text>` | Send text to specific panel |
| `cmux send-key-panel --panel P <key>` | Send key to specific panel |
| `cmux read-screen [--surface S] [--scrollback] [--lines N]` | Read terminal text |
| `cmux capture-pane [--surface S] [--scrollback] [--lines N]` | Alias for read-screen |
| `cmux pipe-pane [--surface S] [--command C]` | Pipe terminal text to shell command |
| `cmux clear-history [--surface S]` | Clear scrollback history |
| `cmux respawn-pane [--surface S] [--command C]` | Restart shell or run command |

## Notifications

| Command | Purpose |
|---------|---------|
| `cmux notify --title T [--subtitle S] [--body B] [--surface S]` | Send in-app notification |
| `cmux list-notifications` | List queued notifications |
| `cmux clear-notifications` | Clear all notifications |

## Sidebar Metadata

| Command | Purpose |
|---------|---------|
| `cmux set-status <key> <value> [--icon I] [--color C]` | Set sidebar status pill |
| `cmux clear-status <key>` | Remove status entry |
| `cmux list-status` | List all status entries |
| `cmux set-progress <0.0-1.0> [--label T]` | Set progress bar |
| `cmux clear-progress` | Clear progress bar |
| `cmux log [--level L] [--source S] <message>` | Append log entry (info\|progress\|success\|warning\|error) |
| `cmux list-log [--limit N]` | List log entries |
| `cmux clear-log` | Clear log entries |
| `cmux sidebar-state` | Dump all sidebar metadata |

## Synchronization & Buffers

| Command | Purpose |
|---------|---------|
| `cmux wait-for [-S\|--signal] <name> [--timeout S]` | Wait for or signal a named sync token (default timeout: 30s) |
| `cmux set-buffer [--name N] <text>` | Save text to named buffer |
| `cmux list-buffers` | List buffers |
| `cmux paste-buffer [--name N] [--surface S]` | Paste buffer into surface |

## Search & Hooks

| Command | Purpose |
|---------|---------|
| `cmux find-window [--content] [--select] <query>` | Find workspaces by title/content |
| `cmux set-hook [--list] [--unset E] \| <event> <command>` | Manage hook definitions |

## Claude Code Integration

| Command | Purpose |
|---------|---------|
| `cmux claude-hook <subcommand>` | Hook for Claude Code (reads JSON from stdin) |

Subcommands: `session-start` (alias: `active`), `stop` (alias: `idle`), `notification` (alias: `notify`), `prompt-submit`

## Markdown Viewer

| Command | Purpose |
|---------|---------|
| `cmux markdown [open] <path> [--surface S]` | Open markdown in formatted viewer with live reload |

## Browser Automation

All browser commands follow: `cmux browser [surface:N] <action> [args]`

Surface can be `--surface <ref>` or positional first token.

### Navigation

| Command | Flags |
|---------|-------|
| `open\|open-split\|new [url]` | `[--workspace W] [--window W]` |
| `goto\|navigate <url>` | `[--snapshot-after]` |
| `back\|forward\|reload` | `[--snapshot-after]` |
| `url\|get-url` | — |

### Snapshot & Interaction

| Command | Flags |
|---------|-------|
| `snapshot` | `[--interactive\|-i] [--cursor] [--compact] [--max-depth N] [--selector CSS]` |
| `click\|dblclick\|hover\|focus\|check\|uncheck\|scroll-into-view` | `[--selector CSS] [--snapshot-after]` |
| `type\|fill` | `[--selector CSS] [--text T] [--snapshot-after]` |
| `press\|key\|keydown\|keyup` | `[--key K] [--snapshot-after]` |
| `select` | `[--selector CSS] [--value V] [--snapshot-after]` |
| `scroll` | `[--selector CSS] [--dx N] [--dy N] [--snapshot-after]` |

### Waiting

| Command | Flags |
|---------|-------|
| `wait` | `[--selector CSS] [--text T] [--url-contains T] [--load-state interactive\|complete] [--function JS] [--timeout-ms MS\|--timeout S]` |

### Data Extraction

| Command | Flags |
|---------|-------|
| `get <prop>` | Props: url, title, text, html, value, attr, count, box, styles; `[--selector CSS] [--attr N] [--property N]` |
| `is <check>` | Checks: visible, enabled, checked; `[--selector CSS]` |
| `find <strategy>` | Strategies: role, text, label, placeholder, alt, title, testid, first, last, nth; `[--name] [--exact] [--index N]` |
| `eval` | `[--script JS \| <JS>]` |

### Session & State

| Command | Purpose |
|---------|---------|
| `cookies <get\|set\|clear>` | Cookie management |
| `storage <local\|session> <get\|set\|clear>` | Local/session storage |
| `state <save\|load> <path>` | Persist/restore browser state |
| `tab <new\|list\|switch\|close>` | Tab management within surface |

### Diagnostics

| Command | Purpose |
|---------|---------|
| `console <list\|clear>` | Console messages |
| `errors <list\|clear>` | JavaScript errors |
| `highlight [--selector CSS]` | Highlight element |
| `screenshot [--out P] [--json]` | Capture screenshot |
| `download [wait] [--path P] [--timeout-ms MS]` | Wait for download |

### Advanced

| Command | Purpose |
|---------|---------|
| `frame <selector\|main>` | Switch iframe context |
| `dialog <accept\|dismiss> [text]` | Handle dialogs |
| `addinitscript\|addscript` | Inject JavaScript |
| `addstyle` | Inject CSS |
| `identify` | Browser surface identity |

### Not Supported (WKWebView Limitations)

These return `not_supported`: viewport.set, geolocation.set, offline.set, trace.start/stop, network.route/unroute/requests, screencast.start/stop, input_mouse/input_keyboard/input_touch.
