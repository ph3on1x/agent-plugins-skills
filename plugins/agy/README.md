# agy

> `/agy:review`, `/agy:adversarial-review`, `/agy:rescue`: a second opinion from Google's Gemini models without leaving Claude Code.

This Claude Code plugin drives the [Antigravity CLI](https://antigravity.google) (`agy`) the same way
OpenAI's [Codex plugin](https://github.com/openai/codex-plugin-cc) drives Codex. The commands, flags,
and job workflow match, so if you know `/codex:*` you already know `/agy:*`. Reviews run read-only.
Rescue tasks can edit your code. Long runs go to the background, and you check on them with
`/agy:status`.

## Requirements

- The Antigravity CLI, signed in with a Google account (run `agy` once). To use an API key instead,
  set `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` and export
  `GEMINI_API_KEY`; the variable alone has no effect. Usage counts against your Antigravity quota,
  and `/agy:setup` shows what remains.
- Node.js 22.18 or later. The runtime is TypeScript run by Node's built-in type stripping, with
  zero dependencies.

## Install

```text
/plugin marketplace add ph3on1x/skills
/plugin install agy@ph3on1x-skills
/reload-plugins
/agy:setup
```

`/agy:setup` checks that `agy` is installed and signed in, and offers to install it with Homebrew
when it is missing. If another plugin also uses the `/agy:` namespace (for example
`agy@antigravity-cc`), setup warns you. Uninstall that plugin so the commands resolve to this one.

## Commands

| Command | What it does |
|---|---|
| `/agy:review [--base <ref>] [--scope auto\|working-tree\|branch] [--model m]` | Structured, read-only review of your uncommitted changes, or of your branch against a base. It does not take focus text. |
| `/agy:adversarial-review [...] [focus ...]` | A steerable review that challenges the design, tradeoffs, and failure modes. Same targeting as `/agy:review`. |
| `/agy:rescue [--background\|--wait] [--resume\|--fresh] [--read-only\|--full-access] [--model m] [--effort e] task` | Hands a task to agy through the `agy:agy-rescue` subagent. It edits code by default. |
| `/agy:status [job] [--wait] [--all]` | Running and recent jobs for this session, plus whether the stop-time review gate is on. |
| `/agy:result [job]` | The stored output of a finished job. |
| `/agy:cancel [job]` | Stops a running job (both the worker and agy). |
| `/agy:setup [--enable-review-gate\|--disable-review-gate]` | Checks readiness and turns the stop-time review gate on or off for the current repository. |

The review commands ask whether to wait or to run in the background. Pass `--wait` or `--background`
to skip the question. You can also just ask in plain words, for example "ask agy to find out why the
integration test is flaky", and Claude routes it through the rescue subagent.

Examples:

```text
/agy:review --background
/agy:adversarial-review --base main challenge the retry and idempotency design
/agy:rescue fix the failing auth test with the smallest safe patch
/agy:rescue --background --model pro investigate the memory leak in the worker pool
/agy:rescue --resume apply the top fix from the last run
/agy:status
/agy:result
```

## Models and effort

If you leave out `--model`, agy uses the default model you selected in agy. The aliases `flash` and
`pro`, optionally with `-low`, `-medium`, or `-high`, resolve to the newest matching Gemini model
listed by `agy models`, so they keep working when Google ships a new release. Any other value, such
as `gemini-3.1-pro-high` or `claude-opus-4-6-thinking`, goes to agy as is. `--effort` accepts
`low`, `medium`, `high`, `xhigh`, or `max`, and agy validates both flags. Gemini model ids include
their effort level, so `--model pro --effort low` resolves to the `-low` variant. If you name a level
explicitly and it conflicts with `--effort`, agy rejects the run.

## Safety model

| Run | How agy is started | What it can do |
|---|---|---|
| Reviews, stop gate, `/agy:rescue --read-only` | Custom agent `agy-read-only` + `--sandbox` | Read files, search, and run commands. The agent has no file-editing tools, and the OS sandbox blocks every write a command attempts. |
| `/agy:rescue` (default) | Default agent + `--sandbox` | Edit files with agy's edit tools. Run commands that read, test, or use the network, but cannot write to disk (temp dirs aside). |
| `/agy:rescue --full-access` | No sandbox | Everything you can do: builds, installs, writes anywhere. |

Every run auto-approves agy's permission prompts (`--dangerously-skip-permissions`), because headless
agy ends the turn on any prompt it cannot show. The limits above come from the agent's tool list and
agy's OS sandbox, not from prompt instructions. agy has no "commands may write only inside the
workspace" mode like Codex's `workspace-write`. So the default rescue cannot run builds that write
to the repository: use `--full-access` for those, knowingly.

Known limitation: in write runs, agy's edit tools are not confined to the repository. agy can only
confine them through its global `settings.json`, which this plugin does not modify. Any edit outside
the repository is flagged in the task output.

A resumed agy thread keeps the tools it started with, because agy ignores `--agent` on resume. So
`--resume` never crosses the read-only boundary: resume a read-only thread read-only, and a write
thread with write access. Switching between write and `--full-access` is fine, because the sandbox
is applied per run.

Other guards:
- A read-only run that somehow edits a file fails loudly.
- Git context is collected with `--no-ext-diff --no-textconv`, so no repository-configured program
  runs.
- Repository content reaches the model fenced as untrusted data, but a model that edits code can
  still be steered by hostile content in the repository it is editing.

## Stop-time review gate

`/agy:setup --enable-review-gate` turns on a `Stop` hook for the current repository. When Claude
finishes a turn and the working tree has changes, agy reviews the diff together with Claude's last
message. If agy finds a concrete defect, it blocks the stop and sends the reason back to Claude.
The gate never traps you:
- It does nothing on a clean tree.
- It runs once per stop: Claude's follow-up stop is not reviewed again.
- If agy is missing, out of quota, or times out, it allows the stop and shows a note.

## How it works

`scripts/agy-companion.mts` runs every review and task as a job in a detached worker process:
1. It starts `agy --input-format stream-json --output-format stream-json` and sends the prompt on
   stdin, so large diffs never hit command-line length limits.
2. Reviews add a JSON schema, and the result comes back as `structured_output`.
3. Progress events are written to a per-job log.
4. Each job is stored as one JSON file under `$CLAUDE_PLUGIN_DATA/state/<repo>-<hash>/jobs/`.

The worker is never Claude's own process, so neither of these can kill agy mid-run:
- Claude Code's cap on a foreground Bash call (120s by default).
- The cleanup of background Bash when a turn ends.

`--background` returns the job id right away. Otherwise the command waits in slices of 100s and
prints the result. A job that outlasts a slice keeps running, and `result <job> --wait` waits for
the next slice. Set the slice with `AGY_COMPANION_WAIT_MS` if your Bash cap is higher.

Resume uses `agy --conversation <id>` and is limited to the current Claude session. The session
hooks record the session id and this plugin's data dir, exported as `AGY_COMPANION_DATA`. It never
reads or exports `CLAUDE_PLUGIN_DATA` from Bash, which other plugins also set. When the session
ends, its running jobs are stopped, and their results are kept.

agy 1.2.15 has a quirk: after one model call in a conversation fails and agy's retry recovers,
every later turn in that conversation reports `status: ERROR`. The runtime treats agy's exit code
and its `AGY_ERROR:` line as the real signals. Such a turn counts as completed, and the stale error
is shown as a note.

Differences from Codex:
- There is no `/agy:transfer`, because agy cannot import a Claude transcript.
- `--background` on any command runs agy as a detached job with its own job id. Codex instead uses
  background Bash, which the session can kill.
- Write runs differ as described in the safety model above.

## Tests

```bash
node --test skills/agy/scripts/agy.test.mts   # fake agy binary, no network, no quota
```

## Credits

The command set and workflow follow OpenAI's
[codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0). This is an independent
implementation for the Antigravity CLI.
