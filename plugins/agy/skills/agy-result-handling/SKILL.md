---
name: agy-result-handling
description: Internal guidance for presenting agy helper output back to the user
user-invocable: false
metadata:
  internal: true
---

# agy result handling

When the helper returns agy output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If agy marked something as an inference or uncertainty, keep that distinction.
- If there are no findings, say so explicitly and keep any residual-risk note brief.
- If agy made edits, say so explicitly and list the files it reports under "Files edited by agy".
- For `agy:agy-rescue`, do not turn a failed or incomplete agy run into a Claude-side implementation attempt. Report the failure and stop.
- For `agy:agy-rescue`, if agy was never successfully invoked, do not generate a substitute answer.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is forbidden, even when the fix is obvious.
- If the helper reports a failed agy run, include the most actionable error lines (for example the `AGY_ERROR` line or the denied action) and stop instead of guessing.
- If the helper reports that agy is missing or not signed in, direct the user to `/agy:setup` and do not improvise alternate auth flows.
