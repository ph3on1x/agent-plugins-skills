# Notifications Reference

Detailed guide for cmux in-app notifications vs macOS system notifications, including hook integration.

## Notification Lifecycle

Received -> Unread -> Read -> Cleared

Notifications are suppressed when the cmux window is focused, the workspace is active, or the notification panel is open.

## Notification Protocols

cmux supports multiple notification protocols:
- **cmux CLI:** `cmux notify --title T --body B`
- **OSC 9:** Standard terminal notification escape sequence
- **OSC 99:** Kitty protocol (supports subtitles and IDs)
- **OSC 777:** RXVT protocol

## Notification Management

```bash
cmux list-notifications    # List queued notifications
cmux clear-notifications   # Clear all notifications
```

## cmux notify (In-App)

```bash
cmux notify --title "Claude Code" --body "Waiting for approval"
```

**What it does:**
- Blue ring around the pane
- Sidebar notification badge
- Entry in notification panel (Cmd+Shift+U to jump to unread)
- Tied to workspace/surface context

**Best for:** Workflow notifications, attention signals within cmux, agent state changes.

## osascript (System-Level)

```bash
osascript -e 'display notification "Build complete" with title "Claude Code" subtitle "Tests" sound name "Submarine"'
```

**What it does:**
- macOS Notification Center notification
- Can play sounds (`sound name "Submarine"`, `sound name "Glass"`, etc.)
- Persists in notification history
- Visible when user is in OTHER apps
- Can have action buttons (limited)

**Best for:**
- Critical alerts when user is outside cmux
- Sound-based attention getters
- Notifications that must persist after cmux closes
- System-level integration

## Decision Matrix

| Need | Use |
|------|-----|
| User in cmux, needs to know agent is waiting | `cmux notify` |
| User in another app, critical alert | `osascript` with sound |
| Build/test complete, informational | `cmux notify` |
| Error requiring immediate attention | `osascript` with sound |
| Notification must survive app restart | `osascript` |
| Context-aware (which pane/workspace) | `cmux notify` |

## Hook Integration

Add to `~/.claude/settings.json` for automatic notifications:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "idle_prompt",
        "hooks": [
          { "type": "command", "command": "cmux notify --title 'Claude Code' --body 'Waiting for input'" }
        ]
      },
      {
        "matcher": "permission_prompt",
        "hooks": [
          { "type": "command", "command": "cmux notify --title 'Claude Code' --subtitle 'Permission' --body 'Approval needed'" }
        ]
      }
    ]
  }
}
```

## Claude Code Built-in Hook

cmux provides a dedicated Claude Code hook command that reads JSON from stdin:

```bash
cmux claude-hook session-start    # (alias: active) — mark session as active
cmux claude-hook stop             # (alias: idle) — mark session as idle
cmux claude-hook notification     # (alias: notify) — forward notification
cmux claude-hook prompt-submit    # — handle prompt submission
```

The advanced hook lifecycle injects 6 events: SessionStart, Stop, SessionEnd, Notification, UserPromptSubmit, PreToolUse. It suppresses desktop notifications when the active workspace has an active agent PID, and includes PID tracking with 30-second cleanup sweeps.

## Custom Notification Command

In cmux Settings, configure a custom notification command that runs arbitrary shell commands with these environment variables:
- `CMUX_NOTIFICATION_TITLE`
- `CMUX_NOTIFICATION_SUBTITLE`
- `CMUX_NOTIFICATION_BODY`
```
