---
name: agy-cli-runtime
description: Internal helper contract for calling the agy-companion runtime from Claude Code
user-invocable: false
---

# agy runtime

Use this skill only inside the `agy:agy-rescue` subagent.

Primary helper (task text on stdin via a quoted heredoc whose delimiter gets a random 8-letter suffix that no line of the task text equals):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" task [--write] [--full-access] [--background] [--resume-last] [--model <m>] [--effort <e>] <<'AGY_TASK_<suffix>'
<task text>
AGY_TASK_<suffix>
```

What the runtime does:
- Runs one headless Antigravity turn (`agy --output-format stream-json`), records it as a job for `/agy:status`, `/agy:result`, and `/agy:cancel`, and prints agy's final answer plus the files it edited and the agy conversation id.
- `--write`: agy can edit files with its edit tools; its shell commands run in a sandbox that can read, run tests, and reach the network but cannot write to disk (temp dirs aside). Use it for fix and implementation requests.
- `--full-access` (with `--write`): no sandbox at all, so commands can build, install, and write anywhere the user can. Only when the user's request contains the literal `--full-access` flag; never inferred.
- Without `--write` (read-only): agy runs as a custom agent with no file-editing tools, and every shell command runs in a sandbox that blocks writes anywhere. It can still read, search, and run tests that need no writes.
- Every run executes in a detached worker. In the foreground the runtime waits up to ~100s (`AGY_COMPANION_WAIT_MS`); if the job is still running it says so and names `result <job-id> --wait` to keep waiting.
- `--background`: returns the job id immediately instead of waiting.
- `--resume-last`: continues the latest agy task thread from this Claude session (`agy --conversation <id>`). It fails if a task from this session is still running, or if it would cross the read-only boundary (agy fixes a thread's tools when the thread starts), so resume a read-only thread read-only and a write thread with `--write`.
- `--model`: `flash`, `pro`, `flash-low`, `pro-low`, `flash-medium` resolve to the newest matching Gemini model from `agy models`; any other value is passed to agy, which validates it.
- `--effort`: passed to agy (`low`, `medium`, `high`, `xhigh`, `max`); agy rejects unsupported values.

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Invoke `task` once and return its stdout unchanged. The one exception: when a foreground run reports that the task is still running, keep waiting with the `result <job-id> --wait` command it names (repeat while it still says running) and return that final stdout.
- Prefer the helper over calling `agy` directly or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, or `cancel` from `agy:agy-rescue`, and call `result` only as `result <job-id> --wait` in the case above.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Prompt drafting with the `gemini-prompting` skill is the only Claude-side work allowed.

Safety rules:
- Default to `--write` unless the user asked for read-only behaviour or only wants review, diagnosis, or research.
- Preserve the user's task text apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- If the command fails, return its error output verbatim; do not attempt the task yourself.
