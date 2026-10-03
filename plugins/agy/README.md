# Antigravity plugin for Claude Code

Use Antigravity from inside Claude Code for code reviews or to delegate tasks to Antigravity.

This plugin is for Claude Code users who want an easy way to start using Google's Gemini models,
through the [Antigravity CLI](https://antigravity.google) (`agy`), from the workflow they already
have. It mirrors OpenAI's [Codex plugin](https://github.com/openai/codex-plugin-cc): if you know
`/codex:*`, you already know `/agy:*`.

## What You Get

- `/agy:review` for a normal read-only Antigravity review
- `/agy:adversarial-review` for a steerable challenge review
- `/agy:rescue`, `/agy:status`, `/agy:result`, and `/agy:cancel` to delegate work and manage
  background jobs

## Requirements

- **Google account or Gemini API key.**
  - Usage will contribute to your Antigravity quota. `/agy:setup` shows what remains.
- **Node.js 22.18 or later.** The runtime is TypeScript run by Node's built-in type stripping, with
  zero dependencies.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add ph3on1x/agent-plugins-skills
```

Install the plugin:

```bash
/plugin install agy@ph3on1x
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/agy:setup
```

`/agy:setup` will tell you whether agy is ready. If agy is missing and Homebrew is available, it can
offer to install agy for you.

If you prefer to install agy yourself, use:

```bash
brew install --cask antigravity-cli
# or
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

If agy is installed but not signed in yet, run it once to complete the browser sign-in:

```bash
!agy
```

To use an API key instead, see
[Can I use a Gemini API key?](#can-i-use-a-gemini-api-key-instead-of-a-google-account)

After install, you should see:

- the slash commands listed below
- the `agy:agy-rescue` subagent in `/agents`

If another plugin also uses the `/agy:` namespace (for example `agy@antigravity-cc`), `/agy:setup`
warns you. Uninstall that plugin so the commands resolve to this one.

One simple first run is:

```bash
/agy:review --background
/agy:status
/agy:result
```

## Usage

### `/agy:review`

Runs a normal Antigravity review on your current work. Findings come back structured and ordered by
severity, with exact file paths and line numbers.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to
> run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review, or `--scope auto|working-tree|branch` to pick the target
explicitly. It also supports `--wait`, `--background`, and `--model`; with neither `--wait` nor
`--background`, it asks which you want. It is not steerable and does not take custom focus text.
Use [`/agy:adversarial-review`](#agyadversarial-review) when you want to challenge a specific
decision or risk area.

Examples:

```bash
/agy:review
/agy:review --base main
/agy:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use
[`/agy:status`](#agystatus) to check on the progress and [`/agy:cancel`](#agycancel) to cancel the
ongoing task.

### `/agy:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different
approach would have been safer or simpler.

It uses the same review target selection as `/agy:review`, including `--base <ref>` for branch
review. It also supports `--wait` and `--background`. Unlike `/agy:review`, it can take extra focus
text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or
  reliability

Examples:

```bash
/agy:adversarial-review
/agy:adversarial-review --base main challenge whether this was the right caching and retry design
/agy:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/agy:rescue`

Hands a task to agy through the `agy:agy-rescue` subagent.

Use it when you want agy to:

- investigate a bug
- try a fix
- continue a previous agy task
- take a faster or cheaper pass with a smaller model
- give a second opinion from a different model family

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's
> generally recommended to force the task to be in the background or move the agent to the
> background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and
`--fresh`, the plugin can offer to continue the latest rescue thread from this Claude session.

Rescue edits code by default. Pass `--read-only` for investigation without edits, or
`--full-access` when agy must build, install, or write to disk from its commands (see the
[safety model](#safety-model)).

Examples:

```bash
/agy:rescue investigate why the tests started failing
/agy:rescue fix the failing test with the smallest safe patch
/agy:rescue --resume apply the top fix from the last run
/agy:rescue --model flash --effort medium investigate the flaky integration test
/agy:rescue --read-only find the root cause of the memory leak in the worker pool
/agy:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to agy:

```text
Ask agy to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, agy uses the default model you selected in agy.
- if you say `flash` or `pro`, the plugin maps that to the newest matching Gemini model listed by
  `agy models` (see [models and effort](#models-and-effort))
- follow-up rescue requests can continue the latest agy task from this Claude session

### `/agy:status`

Shows running and recent agy jobs for the current Claude session, and whether the review gate is on.
Pass `--all` to list every job in the repository.

Examples:

```bash
/agy:status
/agy:status task-mfz1a2b-x7k3p
/agy:status --all
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/agy:result`

Shows the final stored agy output for a finished job.
When available, it also includes the agy conversation ID so you can reopen that run directly in agy
with `agy --conversation <id>`.

Examples:

```bash
/agy:result
/agy:result task-mfz1a2b-x7k3p
```

### `/agy:cancel`

Cancels an active background agy job. It stops both the worker and agy.

Examples:

```bash
/agy:cancel
/agy:cancel task-mfz1a2b-x7k3p
```

### `/agy:setup`

Checks whether agy is installed and authenticated.
If agy is missing and Homebrew is available, it can offer to install agy for you.

You can also use `/agy:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/agy:setup --enable-review-gate
/agy:setup --disable-review-gate
```

When the review gate is enabled for the current repository, the plugin uses a `Stop` hook to run a
targeted agy review of the working-tree diff together with Claude's last message. If that review
finds a concrete defect, the stop is blocked so Claude can address it first.

The gate never traps you:

- It does nothing on a clean tree.
- It runs once per stop: Claude's follow-up stop is not reviewed again.
- If agy is missing, out of quota, or times out, it allows the stop and shows a note.

> [!WARNING]
> The review gate runs an agy review on every Claude stop that leaves changes, and may drain your
> Antigravity quota quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/agy:review
```

### Hand A Problem To Antigravity

```bash
/agy:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/agy:adversarial-review --background
/agy:rescue --background investigate the flaky test
```

Then check in with:

```bash
/agy:status
/agy:result
```

## Antigravity Integration

The agy plugin wraps the [Antigravity CLI](https://antigravity.google) in headless mode
(`agy --output-format stream-json`). It uses the global `agy` binary installed in your environment
and applies the same settings and sign-in.

### Models And Effort

If you leave out `--model`, agy uses the default model you selected in agy. The aliases `flash` and
`pro`, optionally with `-low`, `-medium`, or `-high`, resolve to the newest matching Gemini model
listed by `agy models`, so they keep working when Google ships a new release. Any other value, such
as `gemini-3.1-pro-high` or `claude-opus-4-6-thinking`, goes to agy as is. `--effort` accepts
`low`, `medium`, `high`, `xhigh`, or `max`, and agy validates both flags. Gemini model ids include
their effort level, so `--model pro --effort low` resolves to the `-low` variant. If you name a level
explicitly and it conflicts with `--effort`, agy rejects the run.

### Moving The Work Over To Antigravity

Delegated tasks can also be resumed directly inside agy by running `agy --conversation <id>` with the
conversation ID you received from `/agy:result`.

This way you can review the agy work or continue the work there.

## Safety Model

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
the repository is flagged in the task output, including the output of a failed run.

A resumed agy thread keeps the tools it started with, because agy ignores `--agent` on resume. So
`--resume` never crosses the read-only boundary: resume a read-only thread read-only, and a write
thread with write access. Switching between write and `--full-access` is fine, because the sandbox
is applied per run.

Other guards:
- A read-only run that uses an edit tool fails loudly, even when agy reports no file name.
- Git context is collected with fsmonitor, external diff, and textconv disabled, so no
  repository-configured program runs.
- Repository content reaches the model fenced as untrusted data, but a model that edits code can
  still be steered by hostile content in the repository it is editing.

## How It Works

`scripts/agy-companion.mts` runs every review and task as a job in a detached worker process:
1. It starts `agy --input-format stream-json --output-format stream-json` and sends the prompt on
   stdin, so large diffs never hit command-line length limits.
2. Reviews add a JSON schema, and the result comes back as `structured_output`.
3. Progress events are written to a per-job log.
4. Each job is stored as one JSON file under `$CLAUDE_PLUGIN_DATA/state/<repo>-<hash>/jobs/`.

The worker is never Claude's own process, so neither of these can kill agy mid-run:
- Claude Code's cap on a foreground Bash call (120s by default).
- The cleanup of background Bash when a turn ends.

The review commands' `--background` returns the job id right away. Otherwise the runtime waits in
slices of 100s and prints the result. A job that outlasts a slice keeps running, and
`result <job> --wait` waits for the next slice. Set the slice with `AGY_COMPANION_WAIT_MS` if your
Bash cap is higher.

`/agy:rescue --background` works as in Codex: Claude runs the rescue subagent in the background, the
subagent waits for the job slice by slice, and agy's answer arrives in the conversation when the run
ends.

Resume uses `agy --conversation <id>` and is limited to the current Claude session. The session
hooks record the session id and this plugin's data dir, exported as `AGY_COMPANION_DATA`. It never
reads or exports `CLAUDE_PLUGIN_DATA` from Bash, which other plugins also set. When the session
ends, its running jobs are stopped, and their results are kept.

agy 1.2.15 has a quirk: after one model call in a conversation fails and agy's retry recovers,
every later turn in that conversation reports `status: ERROR`. The runtime treats agy's exit code
and its `AGY_ERROR:` line as the real signals. Such a turn counts as completed, and the stale error
is shown as a note.

### Differences From Codex

- There is no `/agy:transfer`, because agy cannot import a Claude transcript.
- Every run, foreground or background, is a detached job with its own job id. Codex runs foreground
  work inside the Bash call and background reviews in background Bash, which Claude Code can cut
  short or kill.
- Write runs differ as described in the [safety model](#safety-model).

## FAQ

### Do I need a separate Antigravity account for this plugin?

If you are already signed into agy on this machine, that account should work immediately here too.
This plugin uses your local agy CLI authentication.

If you only use Claude Code today and have not used Antigravity yet, you will also need to sign in to
agy with a Google account or set it up with a Gemini API key. Run `/agy:setup` to check whether agy
is ready, and use `!agy` to sign in if it is not.

### Does the plugin use a separate Antigravity runtime?

No. This plugin delegates through your local [Antigravity CLI](https://antigravity.google) on the
same machine.

That means:

- it uses the same agy install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same agy settings I already have?

Yes. If you already use agy, the plugin picks up the same settings, including your default model.
It never modifies `~/.gemini/antigravity-cli/settings.json`.

### Can I use a Gemini API key instead of a Google account?

Yes. Set `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` and export
`GEMINI_API_KEY`. The variable alone has no effect.

## Tests

```bash
node --test plugins/agy/scripts/agy.test.mts   # fake agy binary, no network, no quota
```

## Credits

The command set and workflow follow OpenAI's
[codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0). This is an independent
implementation for the Antigravity CLI.
