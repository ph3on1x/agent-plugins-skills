---
name: muse-cli-runtime
description: Internal helper contract for calling the muse-companion runtime from Claude Code
user-invocable: false
metadata:
  internal: true
---

# muse runtime

Use this skill only inside the `muse:muse-rescue` subagent. It is the one contract for forwarding a
rescue request to muse.

## Command

Run the `task` command with `Bash`. The task text goes on stdin through a quoted heredoc, so the
shell never touches it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-companion.mts" task [--write] [--full-access] [--resume-last] [--model <model>] [--effort <effort>] <<'MUSE_TASK_<suffix>'
<task text>
MUSE_TASK_<suffix>
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
  request clearly continues earlier muse work in this repository, such as "continue", "keep going",
  "resume", "apply the top fix", or "dig deeper".
- A resumed thread takes the access of the new request, the same as a fresh one: muse applies the
  access flags on every run, so a read-only thread can be continued with `--write` and back.
- `--model <value>`: pass it through only when the user asked for a model. `spark` and `wonder`
  resolve to the newest Muse Spark or Muse Wonder model in muse's model list; any other value, such
  as `muse-spark-1.2`, goes to muse, which validates it.
- `--effort <value>`: pass it through only when the user asked for one (`minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`, `ultra`); muse rejects unsupported values.

## What the runtime does

- Runs one headless Muse Code turn (`muse exec --json`) as a job that `/muse:status`, `/muse:result`,
  and `/muse:cancel` track, and prints muse's final answer, the files it edited, and the muse session
  id.
- Read-only (no `--write`): muse has no file-writing tools, and every shell command runs in a sandbox
  that blocks writes anywhere (temp dirs included) and network access. It can still read, search,
  and run tests that need no writes.
- `--write`: muse edits files in the repository. Its shell commands run in muse's sandbox, which can
  write inside the repository and temp dirs (not its `.git`) and reach the network through muse's
  proxy.
- `--full-access`: no sandbox at all, so commands can commit, build, install, and write anywhere the
  user can.
- `--resume-last` continues the latest muse task (or transferred session) from this Claude session
  (`muse exec --session-id <id>`). It fails while a task from this session is still running.
- Every run executes in a detached worker, so Claude Code's Bash time limit cannot cut it short. The
  runtime waits up to ~100s (`MUSE_COMPANION_WAIT_MS`); if the job is still running, it says so and
  names the `result <job-id> --wait` command that keeps waiting.

## Execution rules

- Call `task` once. The only other allowed call: while the output says the task is still running,
  run the `result <job-id> --wait` command it names, repeating until the task finishes. Never return
  a still-running notice: the parent expects muse's final answer.
- Do not call `setup`, `review`, `adversarial-review`, `status`, or `cancel`, and do not call `muse`
  directly.
- Return the final stdout unchanged. If the command fails, return its error output unchanged and do
  not attempt the task yourself.
