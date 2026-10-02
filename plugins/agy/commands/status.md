---
description: Show active and recent Antigravity (agy) jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Present the job table from the command output as a single compact Markdown table, plus the progress lines for running jobs and the review-gate line.
- Do not add extra prose outside that.
- Preserve job IDs, kinds, statuses, phases, times, and summaries.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
