# personal-computer reference

Everything the [README](README.md) leaves out: settings, what is checked, what is kept, limits, security and
troubleshooting.

## Requirements

- Claude Code 2.1.310 or later (tested on 2.1.310).
- A Mac with Apple silicon: the detection models run on [MLX](https://github.com/ml-explore/mlx).
- [uv](https://docs.astral.sh/uv/): it runs the scanner with its own Python (3.12 or 3.13, which uv fetches if
  needed) and dependencies.
- [anymodel](../anymodel) 0.2.0 or later, which installs with the plugin, and an agent of it on a model you trust
  with your data. `mask` mode needs no agent.
- Disk for the detection models, in the Hugging Face cache: 3.7 GB for both, 2.6 GB for OpenAI Privacy Filter
  alone, 1.1 GB for PII-Tracer alone.

## What goes where

| To | What |
|---|---|
| **Your private agent's server** | Everything the agent works with: Claude's brief, the files it reads and the commands it runs, as with any [anymodel agent](../anymodel/REFERENCE.md#what-goes-where). A local model keeps it on your machine; `/personal-computer check` says when the agent is not on this machine and names the host its data goes to. |
| **Anthropic** | Output without personal data, as it is. In place of output with personal data: a notice of what was found, by type and count. Your private agent's answer, masked if it holds personal data. In `mask` mode, the output with placeholders. In `ask` mode, what you choose to share. What the models miss. |
| **Hugging Face** | The model downloads at setup, from [`mlx-community/openai-privacy-filter-bf16`](https://huggingface.co/mlx-community/openai-privacy-filter-bf16) and [`perplexity-ai/PII-Tracer`](https://huggingface.co/perplexity-ai/PII-Tracer). Nothing you check. |

## Settings

`/personal-computer` opens the pane, where each setting is one key away; `/plugin configure personal-computer` holds
the same. A change reloads the plugin and applies at once.

| Setting | Values | What it does |
|---|---|---|
| **Private agent** (`agent`) | an anymodel agent's name | The agent Claude asks for the part of a task that needs withheld data, as in `@anymodel:<name>`. Add one with `/plugin configure anymodel`. |
| **When personal data is found** (`mode`) | `private` (default), `mask`, `ask` | `private`: the output is withheld, Claude gets a notice and asks your agent. `mask`: Claude gets the output with placeholders. `ask`: you choose each time: process privately, mask, share as is, or leave out. With no one to ask (`claude -p`), it stays private. |
| **Check your prompts** (`prompts`) | `ask` (default), `mask`, `off` | `ask`: a prompt with personal data asks you: mask it, send it as is, or cancel. `mask`: masks it without asking. `off`: prompts are not checked. With no one to ask (`claude -p`), `ask` masks. |
| **Detection models** (`detectors`) | `both` (default), `opf`, `pii-tracer` | Which models check. One alone needs less disk and memory, and finds less. Run `/personal-computer setup` after a change. |

## Commands

| You type | What happens |
|---|---|
| `/personal-computer` | Opens the pane: on or off, a line per part, the settings, **Set up** (`s`) and **Check again**. |
| `/personal-computer check` | Prints the same, for `claude -p` and other places without a pane. Exits 1 when a part fails. |
| `/personal-computer setup` | Downloads the models that are missing, starts the scanner and runs its self-test: it must find the name and the IBAN in a test text. When it passes, the plugin is on, in every session. |
| `/personal-computer cleanup [days]` | Removes kept files older than `days` (by default Claude Code's `cleanupPeriodDays`, 30 unless set). The current session's placeholders stay, however old. |

To turn it off, disable the plugin in `/plugin`. Until setup has passed once, it is off: nothing is checked, and
Claude Code works as before.

## What is checked

While on, in the main session and in every subagent:

- **Tool output**: every tool's result before Claude reads it: Read, Bash, Grep, Glob, WebFetch, MCP tools and the
  rest. A PDF is checked by its text layer, read by the scanner. A scanned page with no text is not read (no OCR).
- **Files Claude Code attaches by itself**: a file you name after an `@`, and a file Claude read that changed on disk
  since.
- **Answers**: your private agent's answer, and every background task's notification (subagents run in the
  background by default). One that holds personal data reaches Claude masked, and a toast gives the path of the full
  text.
- **Your prompts**, pasted text included, by the `prompts` setting. Slash commands are not checked.

Not checked:

- **SendMessage results**: Claude Code's delivery status. A masked agent id could no longer be addressed.
- **Context other hooks and plugins add** for Claude.
- **Images**: the text models cannot read them. An image a tool returns is withheld, and Claude is told to ask you
  what it shows. An `@`-mentioned image is not read (in `ask` mode you can share it). An image you paste into a
  prompt: in `ask` mode you choose to send it or not; in `mask` mode it goes as is.

## Detection

Two open models check each text on your machine, and checksums confirm IBANs and card numbers:

| | What it finds | Speed (per 1,000 tokens, M-series Mac) |
|---|---|---|
| [OpenAI Privacy Filter](https://huggingface.co/openai/privacy-filter) | names, email addresses, phone numbers, postal addresses, account numbers, secrets | 10–15 ms |
| [PII-Tracer](https://huggingface.co/perplexity-ai/PII-Tracer) | the same types | 28–64 ms |
| Checksums | IBANs (mod 97), card numbers (Luhn) | — |

Both run on each text by default, in one scanner process; a value either finds counts. A short output takes tens of
milliseconds; the first check after the scanner starts waits for it to load the models.

| Counted | Not counted |
|---|---|
| Names, email addresses, phone numbers, postal addresses, account and card numbers, secrets | Dates, URLs, amounts, reference numbers under 6 digits, ids with letters, published test card numbers and IBANs, your own name and email (from git and your Mac account) |

Each type counts above its own score: a name at 0.7, as both models flag ordinary capitalized words lower; a secret
at 0.9; the others at 0.5. The thresholds are in `hooks/pii.js`.

## Mask mode

Each value gets a placeholder by type and order: `[PERSON_1]`, `[ADDRESS_1]`, `[IBAN_1]`, `[EMAIL_1]`, `[PHONE_1]`,
`[ACCOUNT_1]`, `[CARD_1]`, `[SECRET_1]`, the same one each time it appears in the session. When Claude writes or edits
a file (Write, Edit), the placeholders in it become the real values on disk; Claude's view keeps the placeholders. A
command Claude runs gets the placeholders as they are. The table is kept per
session, so a resumed session (`--resume`, `--continue`) writes the real values too.

## What it keeps

In `~/.local/state/personal-computer` (`$XDG_STATE_HOME/personal-computer`):

- `setup.json`: that setup passed, which turns the plugin on.
- `scanner.json` and `scanner.log`: the running scanner's port and its log.
- `withheld/`: withheld outputs (for your private agent to read), masked answers in full, and each session's
  placeholders, `<session-id>.placeholders.json`. Readable by you only (mode 600).

The files in `withheld/` are removed at each session start once they are older than Claude Code's
`cleanupPeriodDays` (30 days by default), as Claude Code removes its transcripts; `/personal-computer cleanup [days]`
removes them sooner.

The models are in the Hugging Face cache (`~/.cache/huggingface/hub`, or `$HF_HUB_CACHE`, `$HF_HOME`), shared with
other tools that use it.

## The pane, the footer and the warning line

| | Terminal | Desktop app | VS Code | Mobile, Remote Control |
|---|:-:|:-:|:-:|:-:|
| Pane (`/personal-computer`) | yes | yes | yes | no |
| Footer label **personal computer** | yes | yes | no | no |
| Warning line under the prompt | yes | yes | yes | yes |

The pane's first line says how it stands: `○ Off: not set up yet. Nothing is checked.`, `◌ Downloading …` while
setup runs, `● On: what reaches Claude is checked first`, or `⚠ On, but it cannot check: outputs are withheld`. The
warning line, while a check fails: `⚠ personal-computer: can't check for personal data, so outputs are withheld ·
/personal-computer`.

## Troubleshooting

| You see | Do |
|---|---|
| `platform FAILED: …: the detection models run on MLX, which needs a Mac with Apple silicon` | It needs a Mac with Apple silicon; elsewhere it cannot be turned on. |
| `uv MISSING: install it` | Install [uv](https://docs.astral.sh/uv/), then **Set up** again. |
| `models MISSING: … Run /personal-computer setup` | Run setup; it downloads what is missing. |
| `the download ended, but … is not in the Hugging Face cache` | The download was cut short or the cache is elsewhere: check `HF_HUB_CACHE` and `HF_HOME`, and disk space, then **Set up** again. |
| `the PII scanner did not start (its log: …/scanner.log)` | Read the log for the cause, then **Check again**. |
| `agent MISSING: none set` or `no anymodel agent named "…"` | Pick your agent in the pane, or add one with `/plugin configure anymodel`. |
| `agent ok: …: not this machine, so personal data goes to …` | Your agent runs elsewhere: what it reads goes to that host. Use a local model if it must stay on this machine. |
| `No private agent is set up` in Claude's notice | Pick your agent in the pane, or use `mask` mode. |
| `claude plugin list` shows personal-computer `✘ failed to load: Dependency "anymodel@ph3on1x" is not installed` | Install anymodel again: `/plugin install anymodel@ph3on1x`. Until then nothing is checked. |
| An output you expected withheld reached Claude | Detection is statistical. Use `both` detectors, and send the case (with made-up values) as an issue. |

## Limits

- **Detection is statistical**: a model can miss a value, or flag a word that is none (a shop on a statement row can
  count as an address). The defaults favour finding. Test fixtures with realistic data get withheld too.
- **What it cannot check, it withholds**, once on. While a check fails, Claude cannot read tool output.
- **Without anymodel it does not load**: Claude Code keeps it disabled while anymodel is missing, and outputs are not
  checked. Uninstalling anymodel prints `required by personal-computer` but goes ahead.
- **Remote Control mirrors your screen**: what the terminal shows, such as a file Claude wrote in `mask` mode or an
  output you chose to see, reaches claude.ai.
- **A forked session** (`--fork-session`) cannot restore the placeholders from before the fork: a file Claude writes
  there keeps them. New values get new numbers.
- **Changing a setting reloads the plugin**, so the pane locks its settings while setup runs.
- **The private agent's tools are not sandboxed**: it works with your files under your permission rules, as any
  subagent does.
- **Claude Code's local transcripts** (`~/.claude/projects`) can hold personal data: your private agent's own
  transcript, a file you name after an `@` as it was read, and what Claude wrote to a file in `mask` mode. They stay
  on your machine until Claude Code removes them. A background notification queued while the scanner is still
  starting is recorded there as it is; Claude reads the checked one.

## Security

- The scanner listens on 127.0.0.1 only, serves all your sessions from one process, and exits after 30 minutes
  without a request.
- The values it finds are never in a notice, a toast or the pane: those give types and counts.
- Kept files are readable by you only, and removed with Claude Code's transcripts.
- It changes nothing in Claude Code's connection: no proxy, no `ANTHROPIC_BASE_URL`, your own login.
- Other plugins with hooks modules see what Claude Code passes them, as they see any plugin's calls: install only
  plugins you trust.

## Files and uninstalling

To uninstall: `/plugin uninstall personal-computer@ph3on1x`, then remove what it kept and the models:

```bash
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/personal-computer"
rm -rf ~/.cache/huggingface/hub/models--mlx-community--openai-privacy-filter-bf16 \
       ~/.cache/huggingface/hub/models--perplexity-ai--PII-Tracer
```

The scanner, if running, exits by itself after 30 minutes.

## How it works

The plugin is a Claude Code mod: a hooks module that Claude Code runs in its own process. It hooks each tool call's
result (`tool.call`), the files Claude Code attaches (`prompt.attachment`, `prompt.mention`), your prompts and
background notifications (`prompt.submit`), the transcript's queue records (`session.append`) and anymodel's answers
(`anymodel.screen`), and sends each text to the scanner, a `uv` script (`scanner/scan.py`) with the two models. What
the scanner finds is filtered and counted in `hooks/pii.js`. A withheld output is saved for your private agent, and
Claude reads the notice in its place.

It relies on Claude Code behaviour the docs do not promise, so it is tested against real sessions: see
[test/README.md](test/README.md).
