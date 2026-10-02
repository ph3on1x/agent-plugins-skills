---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Antigravity (agy) rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--read-only|--full-access] [--model <model|flash|pro>] [--effort <low|medium|high|xhigh|max>] [what agy should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding the raw user request as the prompt.
`agy:agy-rescue` is a subagent, not a skill — do not call `Skill(agy:agy-rescue)` (no such skill) or `Skill(agy:rescue)` (that re-enters this command and hangs the session).
The final user-visible response must be agy's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- Run the `agy:agy-rescue` subagent in the foreground. It returns quickly for `--background` runs.
- `--background` means agy runs as a detached background job; the subagent passes it to the runtime, which returns a job id immediately. `--wait` means agy runs to completion before the subagent returns.
- If neither is present, the subagent decides: small, clearly bounded asks run in the foreground; open-ended, multi-step, or long work runs with `--background`.
- `--model`, `--effort`, `--read-only`, and `--full-access` are runtime flags. Preserve them for the subagent, but they are not part of the natural-language task text.
- If the request includes `--resume` or `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting agy, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current agy thread or start a new one.
- The two choices must be:
  - `Continue current agy thread`
  - `Start a new agy thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current agy thread (Recommended)` first.
- Otherwise put `Start a new agy thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent, and tell the subagent the thread's `candidate.profile` from the helper: a `read-only` thread must be resumed without `--write` (agy cannot change a thread's tools).
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It uses one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" task ...` and returns that command's stdout as-is.
- Return the agy companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/agy:status`, fetch `/agy:result`, call `/agy:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` and `--model` unset unless the user explicitly asks for them. `flash` and `pro` (optionally `-low`, `-medium`, `-high`) resolve to the newest Gemini model of that family.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the output says agy is missing or not signed in, stop and tell the user to run `/agy:setup`.
- If the user did not supply a request, ask what agy should investigate or fix.
