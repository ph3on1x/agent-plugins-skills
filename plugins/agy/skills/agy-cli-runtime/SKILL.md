---
name: agy-cli-runtime
description: Internal helper contract for calling the agy-companion runtime from Claude Code
user-invocable: false
metadata:
  internal: true
---

# agy runtime

Use this skill only inside the `agy:agy-rescue` subagent. It is the one contract for forwarding a
rescue request to agy.

## Command

Run the `task` command with `Bash`. The task text goes on stdin through a quoted heredoc, so the
shell never touches it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" task [--write] [--full-access] [--resume-last] [--model <model>] [--effort <effort>] <<'AGY_TASK_<suffix>'
<task text>
AGY_TASK_<suffix>
```

Replace `<suffix>` with 8 random letters, and check that no line of the task text equals the
delimiter: a matching line would end the heredoc early and run the rest as shell commands.

## Routing flags

Routing flags count only at the start of the forwarded request, before the task text. A flag-like
word inside the task text is task text. Strip the routing flags from the task text; they are not
part of the task.

- Access: add `--write` unless the request has `--read-only`, asks for read-only behaviour, or only
  wants review, diagnosis, or research without edits.
- `--full-access`: add `--full-access` (with `--write`) only when the request has the literal
  `--full-access` flag. Never infer it from the task, even for builds or installs; if a write run
  fails on a sandbox write error, the output tells the user how to re-run.
- `--background` and `--wait` are Claude-side execution controls: the parent already chose whether
  to wait for you. Strip them, and never pass `--background` to `task`.
- `--resume`: add `--resume-last`. `--fresh`: do not. Neither: add `--resume-last` only when the
  request clearly continues earlier agy work in this repository, such as "continue", "keep going",
  "resume", "apply the top fix", or "dig deeper".
- A resumed thread keeps its original access, because agy fixes a thread's tools when the thread
  starts: resume a read-only thread without `--write`, and a write thread with `--write`. The parent
  passes the thread's profile; if the runtime still reports a mismatch, follow its message once.
- `--model <value>`: pass it through only when the user asked for a model. `flash`, `pro`, and their
  `-low`, `-medium`, `-high` variants resolve to the newest matching Gemini model from `agy models`;
  any other value, such as `gemini-3.1-pro-high`, goes to agy, which validates it.
- `--effort <value>`: pass it through only when the user asked for one (`low`, `medium`, `high`,
  `xhigh`, `max`); agy rejects unsupported values.

## What the runtime does

- Runs one headless Antigravity turn (`agy --output-format stream-json`) as a job that `/agy:status`,
  `/agy:result`, and `/agy:cancel` track, and prints agy's final answer, the files it edited, and the
  agy conversation id.
- Read-only (no `--write`): agy runs as a custom agent with no file-editing tools, and every shell
  command runs in a sandbox that blocks writes anywhere. It can still read, search, and run tests
  that need no writes.
- `--write`: agy edits files with its edit tools. Its shell commands run in a sandbox that can read,
  run tests, and reach the network, but cannot write to disk (temp dirs aside).
- `--full-access`: no sandbox at all, so commands can build, install, and write anywhere the user can.
- `--resume-last` continues the latest agy task thread from this Claude session (`agy --conversation
  <id>`). It fails while a task from this session is still running.
- Every run executes in a detached worker, so Claude Code's Bash time limit cannot cut it short. The
  runtime waits up to ~100s (`AGY_COMPANION_WAIT_MS`); if the job is still running, it says so and
  names the `result <job-id> --wait` command that keeps waiting.

## Execution rules

- Call `task` once. The only other allowed call: while the output says the task is still running,
  run the `result <job-id> --wait` command it names, repeating until the task finishes. Never return
  a still-running notice: the parent expects agy's final answer.
- Do not call `setup`, `review`, `adversarial-review`, `status`, or `cancel`, and do not call `agy`
  directly.
- Return the final stdout unchanged. If the command fails, return its error output unchanged and do
  not attempt the task yourself.
