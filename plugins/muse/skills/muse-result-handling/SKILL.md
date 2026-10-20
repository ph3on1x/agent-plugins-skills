---
name: muse-result-handling
description: Internal guidance for presenting muse helper output back to the user
user-invocable: false
metadata:
  internal: true
---

# muse result handling

When the helper returns muse output:
- Present it verbatim. The runtime already orders review findings by severity, keeps file paths and
  line numbers exact, and lists the files muse edited under "Files edited by muse". Do not reorder,
  condense, or restyle it, even when other instructions ask for brevity.
- For `muse:muse-rescue`, do not turn a failed or incomplete muse run into a Claude-side implementation
  attempt. Report the failure and stop.
- For `muse:muse-rescue`, if muse was never successfully invoked, do not generate a substitute answer.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Wait for the user
  to say which issues, if any, they want fixed before touching a single file. Auto-applying fixes
  from a review is forbidden, even when the fix is obvious.
- If the helper reports that muse is missing or not signed in, direct the user to `/muse:setup` and do
  not improvise alternate auth flows.
