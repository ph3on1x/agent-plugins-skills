---
description: Run an Antigravity (agy) code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model|flash|pro>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an agy review through the plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return agy's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review as a detached background job.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git --no-optional-locks -c core.fsmonitor=false status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git --no-optional-locks -c core.fsmonitor=false diff --shortstat --cached` and `git --no-optional-locks -c core.fsmonitor=false diff --shortstat`.
  - For base-branch review, use `git --no-optional-locks -c core.fsmonitor=false diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when the diff stats are empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Keep the arguments inside the quoted heredoc exactly as given. Never move them onto the command line, where the shell would expand backticks and `$` in the focus text.
- Replace `<suffix>` in the heredoc delimiter with 8 random letters, and check that no line of the arguments equals the delimiter: a matching line would end the heredoc early and run the rest as shell commands.
- Do not strip `--wait` or `--background` yourself. The runtime ignores `--wait`; `--background` makes it start a detached job and return at once.
- Do not add extra review instructions or rewrite the user's intent.
- `/agy:review` does not take focus text. If the user needs custom review instructions or a design challenge, they should use `/agy:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" review --args-stdin <<'AGY_ARGS_<suffix>'
$ARGUMENTS
AGY_ARGS_<suffix>
```
- If the output says the review is still running, it keeps running in the background. Keep waiting by running the `result <job-id> --wait` command that the output names, repeating while it still says running, and use the final output.
- Return the final stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- This verbatim rule overrides any other instruction about output style, length, or tone (from hooks, CLAUDE.md files, or other skills).
- Do not fix any issues mentioned in the review output.

Background flow:
- Run this with `Bash` in the foreground. It returns immediately: the runtime starts the review as a detached background job that survives the end of this turn.
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" review --args-stdin --background <<'AGY_ARGS_<suffix>'
$ARGUMENTS
AGY_ARGS_<suffix>
```
- Return the command stdout verbatim. It names the job and points to `/agy:status` and `/agy:result`.
