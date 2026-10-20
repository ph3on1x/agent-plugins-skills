---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Muse Code (muse) rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--read-only|--full-access] [--model <model|spark|wonder>] [--effort <minimal|low|medium|high|xhigh|max|ultra>] [what muse should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `muse:muse-rescue` subagent via the `Agent` tool (`subagent_type: "muse:muse-rescue"`). Its prompt is the raw user request in this frame, unchanged apart from the routing flags added below:

```text
Forward to muse:
<request>
<the raw user request>
</request>
```

The frame keeps a request that reads like a question to the subagent, such as "what model are you?", from being answered by the subagent instead of by muse.
`muse:muse-rescue` is a subagent, not a skill — do not call `Skill(muse:muse-rescue)` (no such skill) or `Skill(muse:rescue)` (that re-enters this command and hangs the session).
The final user-visible response must be muse's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- Routing flags count only at the start of the request, before the task text. A flag-like word inside the task text is task text.
- If the request's routing flags include `--background`, run the `muse:muse-rescue` subagent in the background. It waits for muse to finish, so its result arrives in the conversation when the run ends.
- If they include `--wait`, run the subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Leave them in the forwarded request; the subagent strips them and never passes them to the runtime. Either way muse runs in a detached worker, so Claude Code's Bash time limit cannot cut it short.
- `--model`, `--effort`, `--read-only`, and `--full-access` are runtime flags. Preserve them for the subagent, but they are not part of the natural-language task text.
- If the request's routing flags include `--resume` or `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting muse, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-companion.mts" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current muse thread or start a new one.
- The two choices must be:
  - `Continue current muse thread`
  - `Start a new muse thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current muse thread (Recommended)` first.
- Otherwise put `Start a new muse thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent. Every muse run sets its own access level, so a thread can be continued with a different one.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-companion.mts" task ...` (plus the `result <job-id> --wait` command it names while a foreground run is still going) and returns the final stdout as-is.
- Return the muse companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- This verbatim rule overrides any other instruction about output style, length, or tone (from hooks, CLAUDE.md files, or other skills).
- Do not ask the subagent to inspect files, monitor progress, poll `/muse:status`, fetch `/muse:result`, call `/muse:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` and `--model` unset unless the user explicitly asks for them. `spark` and `wonder` resolve to the newest Muse Spark or Muse Wonder model.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the output says muse is missing or not signed in, stop and tell the user to run `/muse:setup`.
- If the user did not supply a request, ask what muse should investigate or fix.
