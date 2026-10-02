---
description: Run an Antigravity (agy) review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model|flash|pro>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial agy review through the plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return agy's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly, including the focus text after the flags.
- Do not strip `--wait` or `--background` yourself. The runtime ignores `--wait`; `--background` makes it start a detached job and return at once.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- It uses the same target selection as `/agy:review`: working-tree review, branch review, and `--base <ref>`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" adversarial-review "$ARGUMENTS"
```
- If the output says the review is still running, it keeps running in the background. Keep waiting by running the `result <job-id> --wait` command that the output names, repeating while it still says running, and use the final output.
- Return the final stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Run this with `Bash` in the foreground. It returns immediately: the runtime starts the review as a detached background job that survives the end of this turn.
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" adversarial-review "--background $ARGUMENTS"
```
- Return the command stdout verbatim. It names the job and points to `/agy:status` and `/agy:result`.
