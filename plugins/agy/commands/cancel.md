---
description: Cancel an active background Antigravity (agy) job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" cancel "$ARGUMENTS"`

Present the command output to the user exactly as returned.
