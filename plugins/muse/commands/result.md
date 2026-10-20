---
description: Show the stored final output for a finished Muse Code (muse) job in this repository
argument-hint: '[job-id] [--wait]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-companion.mts" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result, including verdict, summary, findings, next steps, and files edited by muse
- File paths and line numbers exactly as reported
- Any error messages
- The muse session ID and follow-up commands such as `/muse:status <id>`

If the result is a review with findings, stop after presenting it and ask the user which findings, if any, they want fixed. Do not fix anything on your own.
