# Muse Code plugin for Claude Code

Use Muse Code from inside Claude Code for code reviews or to delegate tasks to Muse Code.

This plugin is for Claude Code users who want an easy way to start using Meta's Muse Wonder and Muse
Spark models, through the [Muse Code CLI](https://dev.meta.ai/docs/muse-code) (`muse`), from the
workflow they already have. It mirrors OpenAI's [Codex plugin](https://github.com/openai/codex-plugin-cc)
and this repository's [`agy` plugin](../agy): if you know `/codex:*` or `/agy:*`, you already know
`/muse:*`.

## What You Get

- `/muse:review` for a normal read-only Muse Code review
- `/muse:adversarial-review` for a steerable challenge review
- `/muse:rescue`, `/muse:status`, `/muse:result`, and `/muse:cancel` to delegate work and manage
  background jobs
- `/muse:transfer` to continue the current Claude Code conversation in Muse Code

## Requirements

- **Meta account or Meta API key.**
  - Usage will contribute to your Muse Code quota. `/muse:setup` shows what the last run reported.
- **Node.js 22.18 or later.** The runtime is TypeScript run by Node's built-in type stripping, with
  zero dependencies.
- **macOS or Linux** for the sandboxed runs (Seatbelt on macOS, bubblewrap on Linux). The plugin is
  tested on macOS with Muse Code 1.4.11.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add ph3on1x/agent-plugins-skills
```

Install the plugin:

```bash
/plugin install muse@ph3on1x
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/muse:setup
```

`/muse:setup` will tell you whether muse is ready. If muse is missing, it can offer to run Meta's
installer for you.

If you prefer to install muse yourself, use:

```bash
curl -fsSL https://dev.meta.ai/install.sh | sh
```

If muse is installed but not signed in yet, sign in once in the browser:

```bash
!muse login
```

To use an API key instead, export `META_API_KEY` or store one with `muse auth set --api-key-stdin`.

After install, you should see:

- the slash commands listed below
- the `muse:muse-rescue` subagent in `/agents`

If another plugin also uses the `/muse:` namespace (several community ports do), `/muse:setup` warns
you. Uninstall that plugin so the commands resolve to this one.

One simple first run is:

```bash
/muse:review --background
/muse:status
/muse:result
```

## Usage

### `/muse:review`

Runs a normal Muse Code review on your current work. Findings come back structured and ordered by
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
Use [`/muse:adversarial-review`](#museadversarial-review) when you want to challenge a specific
decision or risk area.

Examples:

```bash
/muse:review
/muse:review --base main
/muse:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use
[`/muse:status`](#musestatus) to check on the progress and [`/muse:cancel`](#musecancel) to cancel the
ongoing task.

### `/muse:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different
approach would have been safer or simpler.

It uses the same review target selection as `/muse:review`, including `--base <ref>` for branch
review. It also supports `--wait` and `--background`. Unlike `/muse:review`, it can take extra focus
text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or
  reliability

Examples:

```bash
/muse:adversarial-review
/muse:adversarial-review --base main challenge whether this was the right caching and retry design
/muse:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/muse:rescue`

Hands a task to muse through the `muse:muse-rescue` subagent.

Use it when you want muse to:

- investigate a bug
- try a fix
- continue a previous muse task
- take a faster or cheaper pass with a smaller model
- give a second opinion from a different model family

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's
> generally recommended to force the task to be in the background or move the agent to the
> background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and
`--fresh`, the plugin can offer to continue the latest rescue thread from this Claude session.

Rescue edits code by default. Pass `--read-only` for investigation without edits, or
`--full-access` when muse must commit, install, or write outside the repository from its commands
(see the [safety model](#safety-model)).

Examples:

```bash
/muse:rescue investigate why the tests started failing
/muse:rescue fix the failing test with the smallest safe patch
/muse:rescue --resume apply the top fix from the last run
/muse:rescue --model spark --effort medium investigate the flaky integration test
/muse:rescue --read-only find the root cause of the memory leak in the worker pool
/muse:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to muse:

```text
Ask muse to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, muse uses its own defaults (currently Muse Wonder)
- if you say `spark` or `wonder`, the plugin maps that to the newest matching model in muse's model
  list (see [models and effort](#models-and-effort))
- follow-up rescue requests can continue the latest muse task from this Claude session

### `/muse:status`

Shows running and recent muse jobs for the current Claude session, and whether the review gate is
on. Pass `--all` to list every job in the repository.

Examples:

```bash
/muse:status
/muse:status task-mfz1a2b-x7k3p
/muse:status --all
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/muse:result`

Shows the final stored muse output for a finished job.
When available, it also includes the muse session ID so you can reopen that run directly in muse
with `muse resume <id>`.

Examples:

```bash
/muse:result
/muse:result task-mfz1a2b-x7k3p
```

### `/muse:cancel`

Cancels an active background muse job. It stops both the worker and muse.

Examples:

```bash
/muse:cancel
/muse:cancel task-mfz1a2b-x7k3p
```

### `/muse:transfer`

Continues the current Claude Code conversation in Muse Code. Muse imports the conversation with its
own `resume-claude` importer into a new read-only session and replies with a short recap of the
goal, the current state, and the next step. Continue it in the muse CLI with `muse resume <id>`, or
from Claude Code with `/muse:rescue --resume`.

Pass `--source <claude-jsonl>` to transfer another Claude Code transcript instead of this session's.
Like Codex, it accepts only transcripts under `~/.claude/projects`, so no other file can be sent to
Meta by mistake.

Examples:

```bash
/muse:transfer
/muse:transfer --source ~/.claude/projects/<project>/<session>.jsonl
```

> [!WARNING]
> The whole transcript is sent to Meta, and Muse reads it with model calls, so a long conversation
> costs quota. If contributor mode is on in muse, Meta may use it for product improvement.

### `/muse:setup`

Checks whether muse is installed and signed in, and shows the quota the last muse run reported and
whether Muse Code's contributor mode is on.
If muse is missing, it can offer to run Meta's installer for you.

You can also use `/muse:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/muse:setup --enable-review-gate
/muse:setup --disable-review-gate
```

When the review gate is enabled for the current repository, the plugin uses a `Stop` hook to run a
targeted muse review of the working-tree diff together with Claude's last message. If that review
finds a concrete defect, the stop is blocked so Claude can address it first.

The gate never traps you:

- It does nothing on a clean tree.
- It runs once per stop: Claude's follow-up stop is not reviewed again.
- If muse is missing, out of quota, or times out, it allows the stop and shows a note.

> [!WARNING]
> The review gate runs a muse review on every Claude stop that leaves changes, and may drain your
> Muse Code quota quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/muse:review
```

### Hand A Problem To Muse Code

```bash
/muse:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/muse:adversarial-review --background
/muse:rescue --background investigate the flaky test
```

Then check in with:

```bash
/muse:status
/muse:result
```

## Muse Code Integration

The muse plugin wraps the [Muse Code CLI](https://dev.meta.ai/docs/muse-code) in headless mode
(`muse exec --json`). It uses the global `muse` binary installed in your environment and applies the
same sign-in and settings, except where the [safety model](#safety-model) overrides them for a run.

### Models And Effort

If you leave out `--model`, muse uses its default model. Muse Code has no model aliases of its own;
the plugin adds `spark` and `wonder`, which resolve to the newest `muse-spark-*` or `muse-wonder-*`
model in muse's model list (never a `-contributor` variant), so they keep working when Meta ships a
new release. Any other value, such as `muse-spark-1.2`, goes to muse as is. `--effort` accepts
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`, and muse validates both flags.

### Moving The Work Over To Muse Code

Delegated tasks can also be resumed directly inside muse by running `muse resume <id>` with the
session ID you received from `/muse:result`. `/muse:transfer` moves the Claude Code conversation
itself.

This way you can review the muse work or continue the work there.

## Safety Model

| Run | How muse is started | What it can do |
|---|---|---|
| Reviews, stop gate, transfer, `/muse:rescue --read-only` | Custom read-only permission profile + `--disable-write` | Read files, search, and run commands. muse has no file-writing tools, and the OS sandbox blocks every write a command attempts (temp dirs included) and its network access. |
| `/muse:rescue` (default) | `--approval-mode never` in muse's sandbox | Edit files in the repository. Run commands that write inside the repository and temp dirs and reach the network through muse's proxy. The repository's `.git` stays read-only, so muse cannot commit. |
| `/muse:rescue --full-access` | muse's built-in `:unrestricted` profile | Everything you can do: commits, builds, installs, writes anywhere. |

Every run is headless, so nothing ever waits for an approval. Muse's own read-only profiles ask a
human before a write, which would hang a headless run, so the plugin brings its own read-only profile
that denies instead. Every run replaces your muse `permissions` setting for that run only, so a
custom default profile in your settings never changes what a plugin run may do, and your settings
file is never modified.

Every run, resumes included, also passes:

- `--disable-request-user-input`: muse never stops to ask a question nobody can answer.
- `--no-foreign-personal-context`: muse does not load your `~/.claude/CLAUDE.md` and `~/.claude`
  skills, which are written for Claude Code. Your repository's `AGENTS.md`/`CLAUDE.md` still load
  when you trust the workspace in muse.
- `-c hooks={}`: your muse hooks do not fire for plugin runs. They run outside the sandbox, and they
  would react to runs you never see.

The plugin never passes `--trust-workspace`: muse loads a repository's skills, rules, hooks, and MCP
servers only when you trusted it in muse yourself.

A resumed muse session gets the access level of the new request, because muse applies these flags
on every run. So `--resume` can continue a read-only thread with edits, and the reverse.

Other guards:
- A read-only run that uses a file-writing tool fails loudly, even when the write was refused.
- A read-only run in a repository compares the working tree before and after, because a shell
  command's write never shows in muse's output. A change adds a warning naming the paths but does
  not fail the run: Claude, you, or another job may have edited them meanwhile, as during any
  background review.
- The prompt reaches muse through a private temporary file (`0600`), never through the repository.
- muse does not see this plugin's variables or `MUSE_PERMISSION_PROFILE_FAIL_OPEN`, which would let
  an unknown profile run unrestricted.
- Git context is collected with fsmonitor, external diff, and textconv disabled, so no
  repository-configured program runs.
- Repository content reaches the model fenced as untrusted data, but a model that edits code can
  still be steered by hostile content in the repository it is editing.

Known limitation: cancelling stops muse with SIGTERM, which stops its tools. If muse ignores that, the
plugin uses SIGKILL after 3 seconds, and a shell command muse started can then outlive it.

## How It Works

`scripts/muse-companion.mts` runs every review and task as a job in a detached worker process:
1. It starts `muse exec --json --prompt-file <file> --session-id <id>`. The prompt goes through a
   private file because `muse exec` does not read stdin, so large diffs never hit command-line length
   limits.
2. Reviews and the stop gate add `--output-schema`, and muse's final answer is the JSON itself. They
   also pass `--disable-reminders`: Muse's reminder agents can reopen a finished turn, and a second
   answer would break the JSON result.
3. Progress (commands muse ran, files it edited) is written to a per-job log.
4. Each job is stored as one JSON file under `$CLAUDE_PLUGIN_DATA/state/<repo>-<hash>/jobs/`.

The worker is never Claude's own process, so neither of these can kill muse mid-run:
- Claude Code's cap on a foreground Bash call (120s by default).
- The cleanup of background Bash when a turn ends.

The review commands' `--background` returns the job id right away. Otherwise the runtime waits in
slices of 100s and prints the result. A job that outlasts a slice keeps running, and
`result <job> --wait` waits for the next slice. Set the slice with `MUSE_COMPANION_WAIT_MS` if your
Bash cap is higher.

`/muse:rescue --background` works as in Codex: Claude runs the rescue subagent in the background, the
subagent waits for the job slice by slice, and muse's answer arrives in the conversation when the run
ends.

Resume reuses the muse session id (`muse exec --session-id <id>`) and is limited to the current Claude
session. The session hooks record the session id, the session's transcript path, and this plugin's
data dir, exported as `MUSE_COMPANION_DATA`. It never reads or exports `CLAUDE_PLUGIN_DATA` from
Bash, which other plugins also set. When the session ends, its running jobs are stopped, and their
results are kept.

`/muse:setup` asks muse for the account over its session protocol (`muse serve`) with the offline
echo provider, so it never costs quota. Muse Code has no quota query that works without a model
call, so setup shows the allowance the last muse run reported.

The `muse exec --json` record format is not documented by Meta. The plugin was built against Muse
Code 1.4.11, and `scripts/fixtures/` holds real recorded runs that its tests replay.

### Differences From Codex

- Every run, foreground or background, is a detached job with its own job id. Codex runs foreground
  work inside the Bash call and background reviews in background Bash, which Claude Code can cut
  short or kill.
- Reviews use the plugin's own review prompt and JSON schema: muse has no built-in reviewer.
- `/muse:transfer` is a muse model turn (muse's `resume-claude` importer), not a file import: the
  transcript goes to Meta at once, and it costs quota.
- Rescue has `--read-only` and `--full-access` in addition to the default write access, as in `agy`.

## FAQ

### Do I need a separate Muse Code account for this plugin?

If you are already signed into muse on this machine, that account should work immediately here too.
This plugin uses your local muse CLI authentication.

If you only use Claude Code today and have not used Muse Code yet, you will also need to sign in to
muse with a Meta account or set it up with an API key. Run `/muse:setup` to check whether muse is
ready, and use `!muse login` to sign in if it is not.

### Does the plugin use a separate Muse Code runtime?

No. This plugin delegates through your local [Muse Code CLI](https://dev.meta.ai/docs/muse-code) on
the same machine.

That means:

- it uses the same muse install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same muse settings I already have?

Yes, except for what the [safety model](#safety-model) sets for each run: permissions, hooks, and
`~/.claude` context. It never modifies `~/.config/muse/settings.json`.

### Does Meta see my code?

Everything muse reads or is sent (diffs, files, transfer transcripts) goes to Meta's API, as with
any muse session. If contributor mode is on in muse (`/muse:setup` shows it), Meta may use that
content for product improvement. Turn it off with `/settings` in muse.

### Can I use a Meta API key instead of a Meta account?

Yes. Export `META_API_KEY`, or store a key with `muse auth set --api-key-stdin`. A key takes priority
over a browser sign-in.

## Tests

```bash
node --test plugins/muse/scripts/muse.test.mts   # fake muse binary, no network, no quota
MUSE_COMPANION_LIVE=1 node --test plugins/muse/scripts/muse.test.mts   # also the real muse, echo provider, no quota
```

## Credits

The command set and workflow follow OpenAI's
[codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0) and this repository's
`agy` plugin. This is an independent implementation for the Muse Code CLI.
