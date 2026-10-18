<div align="center">

# WISCI

**Context engineering for AI coding agents, with notes that check themselves against your code.**

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fph3on1x%2Fagent-plugins-skills%2Fmain%2Fplugins%2Fwisci%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![License](https://img.shields.io/github/license/ph3on1x/agent-plugins-skills)](../../LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/ph3on1x/agent-plugins-skills?path=plugins%2Fwisci&label=last%20commit)](https://github.com/ph3on1x/agent-plugins-skills/commits/main/plugins/wisci)
<br>
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-d97757)](https://code.claude.com/docs/en/plugins)
[![Agent Skills](https://img.shields.io/badge/Agent_Skills-standard-2ea44f)](https://agentskills.io)
[![uv](https://img.shields.io/badge/runs_with-uv-de5fe9?logo=uv&logoColor=white)](https://docs.astral.sh/uv/)

[Quick start](#quick-start) · [Commands](#commands) · [How it works](#how-it-works) · [Scenarios](#scenarios) · [What's new in 3.1](#whats-new-in-31)

</div>

Long sessions get worse as the context window fills with noise. WISCI keeps what matters on disk as plain Markdown, quotes the code behind every claim, and checks those quotes each time a note loads. When the code moves on, the note says so instead of quietly misleading your agent.

- **Write** what you learned as a note whose claims quote the code they rest on.
- **Isolate** research in subagents, so only the synthesis enters your session.
- **Select** only what the task needs, with every section whose quoted code changed flagged.
- **Compress** work into per-stream handoffs for the next session or a teammate, and automatically at every Claude Code compaction, so long sessions keep their work state.
- **`/commit`** records which agent-context files changed, as git trailers.

## Quick start

In Claude Code (2.1.275 or newer):

```text
/plugin marketplace add ph3on1x/agent-plugins-skills
/plugin install wisci@ph3on1x
```

Then, in any project:

```text
/isolate how does auth work in this repo     # research in subagents, findings saved as a note
/select auth                                 # next session: load it back, flagged where the code changed
/compress                                    # stopping? hand the work off
/autocompact 500k                            # long session? each compaction now saves a handoff too
```

> [!IMPORTANT]
> WISCI needs **git** and **[uv](https://docs.astral.sh/uv/getting-started/installation/) 0.12+**. uv provides Python 3.11+ and downloads it on first use. Without uv, skills stop with `uv: command not found`, and the plugin prints an install hint at session start. `/commit` needs git 2.32+ for `git commit --trailer`. Verified on Claude Code 2.1.300.

<details>
<summary><b>Codex, Cursor, Gemini CLI, Antigravity, Copilot</b></summary>

<br>

```bash
npx skills add ph3on1x/agent-plugins-skills --skill commit compress isolate select write
```

- **No hooks.** The session-start summary and the handoff saved at every compaction ship only in the Claude Code plugin.
- **No command injection.** The model reads the skill and runs `scripts/wisci.py` through uv itself.
- **Name collisions.** `npx skills` doesn't namespace skills, so `commit` or `write` can collide with another skill of the same name. The Claude Code plugin namespaces them as `/wisci:<name>`.
- **Implicit invocation.** Codex, Gemini CLI, Antigravity and Copilot pick skills implicitly by default. `commit` ships `agents/openai.yaml` to turn that off on Codex.

</details>

## Commands

| You're thinking | Run | What happens |
|---|---|---|
| "I'll need this tomorrow" | `/write auth-research` | Saves findings to `.wisci/context/auth-research.md`, each claim about code with the lines it rests on quoted |
| "Research this without cluttering my session" | `/isolate compare OAuth2 libraries for Node.js` | Subagents research in their own context windows; you get one synthesis, and durable findings are saved as a note |
| "Where was I?" | `/select` | A short orientation from the repo's own docs, your handoff streams, and an inventory of notes with their evidence status |
| "I need my auth research back" | `/select auth-research` | Loads the note and flags every section whose quoted code is no longer in the code |
| "Done for the day" | `/compress` | Writes each work stream to its own handoff: goal, progress, next steps, ruled-out approaches, your constraints |
| "This session will run for hours" | `/autocompact 500k` (Claude Code) | At every compaction the summary is a handoff in `/compress`'s format, merged into `.wisci/handoff/`; the session continues with it already loaded |
| "Time to commit" | `/commit` | A conventional commit with one `AI-Context:` trailer per changed agent-context file |

## Why

Context fails in four recognizable ways ([Drew Breunig](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html)), and each has a WISCI answer:

| Failure | What goes wrong | WISCI's answer |
|---|---|---|
| **Poisoning** | A wrong fact persists and compounds | `/write` quotes the code each claim rests on; `/select` flags sections whose quote is gone |
| **Distraction** | Accumulated history crowds out the task | `/isolate` keeps research in separate windows; `/compress` lets you restart lean, and every compaction leaves a handoff |
| **Confusion** | Irrelevant material steers the model wrong | `/select` loads only the notes the task needs |
| **Clash** | Facts gathered across turns contradict each other | `/write` merges section by section, and a newer decision retires the older one |

Model performance drops as input grows, often unevenly ([Chroma, *Context Rot*](https://research.trychroma.com/context-rot)). There is no universal threshold; keeping utilization around 40–60% is a practitioner heuristic ([HumanLayer](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md)), not a measured limit.

> [!TIP]
> Claude Code compacts automatically near the context limit, and the wisci plugin makes every compaction summary a handoff ([Handoffs at every compaction](#handoffs-at-every-compaction)). Choose when it compacts with `/autocompact <tokens>`, for example `/autocompact 500k`.

## How it works

```mermaid
flowchart LR
    start([Session start]) -->|hook lists the store| select["/select"]
    select --> work[Work]
    work --> isolate["/isolate"]
    isolate -->|saves through| write["/write"]
    work --> write
    work --> compress["/compress"]
    work -->|context full| compact(["Compaction"])
    compact -->|summary is the handoff| work
    compress --> commit["/commit"]
    commit -.->|next session| start
```

### The store

```text
.wisci/
├── context/<topic>.md      # knowledge notes: /write
└── handoff/<stream>.md     # per-stream work state: /compress, and every compaction
```

Commit `.wisci/` to share notes through git, or gitignore it to keep them local; the evidence check works the same either way. The dotfolder keeps a casual file search from pulling notes in, by convention rather than guarantee.

### Handoffs at every compaction

When Claude Code compacts, whether automatically at the window you set with `/autocompact` or on `/compact`, the summary **is** a `/compress` handoff. Claude Code's stock summary sections are replaced:

1. `/autocompact 500k` sets when compaction happens.
2. **Before summarizing**, the PreCompact hook hands the summarizer the streams this session works on, with their saved records under "Already saved", so it writes only what is new. Then come three sections of `skills/compress/SKILL.md`, verbatim: "At compaction" (write only handoff leaves, one `<wisci-handoff>` block per work stream), "Leaf format" and "What to keep". The rules come last: placed before the records, they lost to the stock format on Haiku 8 times in 20. The skill is the only place the rules are written, so `/compress` and compaction always follow the same ones.
3. **Right after**, the SessionStart hook re-injects the saved records of those streams, word for word: Constraints, Decisions, Tried / Ruled out, newest first, within one budget for the whole output. A stream marked `done` is left out, and a stream that needs less than its share leaves the rest to the others.
4. **When the turn ends**, the Stop hook finds the summary in the session's transcript and merges each block into `.wisci/handoff/<stream>.md`. Saved record lines are kept byte for byte and new items appended once; state (Completed, In Progress, Next Steps, Blockers, References) is replaced. If the saved state is 15 minutes or more older than the compaction, the Stop message says so and names the `/compress` that saves the later work.

This repeats at every compaction.

- **Only the main session saves.** Claude Code fires the same compaction hooks for every subagent, with the main session's ids. The PostCompact hook only notes where the transcript ends; a summary row there means the main session compacted, and a subagent's compaction leaves none. Subagents still see the labelled records; isolating them needs a Claude Code mod.
- **Only this session's streams.** A compaction updates a leaf only if this session's main thread loaded or saved it with a tool call that succeeded, or an earlier compaction of this session committed it (`committed-by:` in the leaf). A block that names another stream is saved as a new leaf (`<stream>-2`), so a parallel session's handoff is never overwritten.
- **Your words, checked.** A Constraint is an exact quote. wisci finds it in what you typed or answered (AskUserQuestion) and adds the date; one it can't find is left out, so teammate messages, system rules and paraphrases never become your words.
- **Never older state.** A summary prepared early (Claude Code precomputes it) is dated by the last message it covers; if the leaf was saved after that, its state stays and only the new records are added. Claude Code can prepare it hours before it is used (9 h 31 min in one measured session), so the work in between reaches the handoff only at the next compaction or a `/compress`; the Stop message tells you when that gap is 15 minutes or more.
- **No extra cost.** The summarizer writes the handoff instead of the summary it was writing anyway: no extra model turn, no blocked tool calls.
- **`/compress` is still the careful path.** It can read files and fix a failing quote. The summarizer can't run tools, so it doesn't quote code.
- **Verified, not promised.** Claude Code passes PreCompact output to the summarizer, but the docs don't promise it. If no block comes back, the Stop hook tells you to run `/compress`.

### Quoted evidence, checked on every load

A claim about what the code does carries the lines it rests on, in a fenced block tagged with the language and the file's path:

````markdown
## Session
Sessions expire after 3600 seconds.

```ts src/auth/session.ts
export const SESSION_TTL = 3600 // seconds
```
````

When that line changes, the section still loads, under a marker naming the file and the missing code:

```text
## Session
> check — `src/auth/session.ts` no longer contains `export const SESSION_TTL = 3600 // seconds`. Re-read it before relying on this section.
Sessions expire after 3600 seconds.
```

- **The match.** The quoted lines must occur exactly once in the file, as whole lines with the same relative indentation. Trailing whitespace and line endings don't matter, so code that moved within the file still matches. A changed value, lines stitched from two places, or a line that now occurs twice does not.
- **States.** A section whose quotes all match is `ok`, one with a failing quote is `check`, and one without quotes (a decision, a plan, a requirement) has neither.
- **Writing quotes.** Writers quote 1–3 lines: the line that would change if the claim became false (the value, the condition, the call), not just a signature. `/write` and `/compress` end with `wisci.py check`, so a mistyped quote fails at once. Decisions carry their date, and a newer one on the same topic moves the older one to Ruled out.
- **Fixing wrong notes.** When the code contradicts a loaded section, flagged or not, `/select` names it, states the current fact and suggests `/write <note>` (`/compress` for a handoff); it never edits the store itself. `/isolate` saves the correction through `/write`, even after a quick lookup.
- **Nothing hidden, nothing stored.** Every section loads, and a flag clears as soon as the quoted code matches again. There are no verification records and no "mark as verified" step: the note carries its own evidence. Skills load notes through `wisci.py load`, never a raw Read, which would drop the markers.
- **Why quotes, not whole files.** Only 13–20% of code changes trigger comment updates ([Wen et al., ICPC'19](https://www.inf.usi.ch/faculty/lanza/PUBS/P/Wen2019a.pdf)), so flagging every change to a cited file is mostly noise. On three real repositories a quoted line survived 91–95% of the changes to its file. Swimm (in CI) and GitHub Copilot Memory (at read time) also check cited code, not whole files.

> [!NOTE]
> `ok` means the quoted code is still there, not that every claim is true. A behavior change that leaves the quoted lines intact, in a caller, in configuration, or a claim that something is absent, isn't flagged. Critical behavior belongs in tests.

<details>
<summary><b>Failure reasons</b></summary>

<br>

`no longer contains <line>` · `contains the quoted code N times` · `does not exist` · `is outside the project` · `is not a source file` · `is not a text file` · `is too large to check` · `has an empty quote` · `a code fence is not closed`

New store files are reserved atomically, so parallel sessions never overwrite each other's new notes or streams. Leaf writes are serialized through `.wisci/.lock`, and `/compress` saves a draft only if its leaf is unchanged since the draft was made.

</details>

<details>
<summary><b>Script reference</b></summary>

<br>

`scripts/wisci.py` is a [PEP 723](https://packaging.python.org/en/latest/specifications/inline-script-metadata/) script with no dependencies, Python 3.11+ standard library only. Every caller runs it the same way, from the project root:

```bash
uv run --no-config --no-cache --script scripts/wisci.py <command>
```

- `--script` keeps your project's dependencies out of it.
- `--no-config` ignores uv config files, the project's and your own. This matters for `npx skills` installs, which copy the script into your project. `UV_*` environment variables still apply.
- `--no-cache` keeps it working in sandboxes that block writes to `~/.cache`, such as Claude Code's Bash sandbox.

| Command | Does |
|---|---|
| `scan` | Compact JSON: `[path, failed, quotes]` for every store file, plus handoff streams |
| `load <file>` | The whole note, failing sections under a `check` marker |
| `check <file>` | Only the failing quotes, then `evidence ok N/M` |
| `new <context\|handoff> <slug>` | Reserve a new store file |
| `draft <slug> [--session ID]` | Copy a handoff leaf, or an empty one, to `.wisci/.drafts/` for `/compress` to edit |
| `save <draft> [--session ID]` | Merge the draft into its leaf: new records appended, Constraints checked against the session's transcript |
| `session-status` | The session-start summary; after a compaction, also this session's handoff records |
| `precompact` | Instructions that make the compaction summary a handoff; reads the PreCompact event on stdin |
| `mark` | Notes where the transcript ends at a compaction; reads the PostCompact event on stdin |
| `stop` | Saves the main session's compaction summaries into their leaves |
| `test` | Self-tests |

`<file>` is a store path (`.wisci/context/auth.md`) or the short name `scan` prints (`context/auth`).

</details>

<details>
<summary><b>Hooks (Claude Code)</b></summary>

<br>

- **Session start** (and after each compaction) lists stored notes and streams with their evidence status, and tells the agent to load them with `/select`, not a raw Read, which would skip the check. After a compaction it first prints the saved records of this session's streams, verbatim.
- **Before compaction** (`wisci.py precompact`), it prints the instructions that make the summary a handoff. It can't block a compaction: any failure exits 1.
- **After compaction** (`wisci.py mark`), it notes the transcript's size in `.wisci/.pending/`.
- **At the end of each turn** (`wisci.py stop`), it saves every main-session summary that followed a mark and drops the marks of subagent compactions. Without a mark it exits before starting Python. Problems (no handoff block, a quote left out) are shown to you, never to the model. Session start and PreCompact commit pending marks too, so a session that ended early is saved next time.
- Every hook runs through `hooks/run.sh`, which prints the uv install hint when uv is missing. See [Handoffs at every compaction](#handoffs-at-every-compaction).

</details>

### Git as long-term memory

`/commit` adds one `AI-Context:` trailer per agent-context file it commits (`.wisci/`, `CLAUDE.md`, `AGENTS.md`, Cursor, Copilot, Codex and Gemini rules, plugin skills and hooks), so `git log` shows how your agent context evolved:

```bash
git log --format='%h %(trailers:key=AI-Context,valueonly,separator=%x3B )'
```

## Scenarios

**A feature across sessions**

```text
> /select auth-layer               # stored notes (changed parts flagged) + code + git history
> /isolate compare JWT vs session-based auth for our use case
> /compress                        # writes .wisci/handoff/auth-refactor.md

  — next day —
  (session start lists: "handoff/auth-refactor — active, 2/2 quotes ok …")
> /select auth-refactor
  … implement …
> /commit feat: add token refresh to auth middleware
```

**Parallel streams**

```text
> /compress     # Monday, auth work: writes .wisci/handoff/auth-refactor.md
> /compress     # Tuesday, another session, CI work: writes .wisci/handoff/ci-runners.md
> /select ci-runners
```

**A long session with auto-compaction**

```text
> /autocompact 500k                # Claude Code: compact when the context reaches 500k tokens
  … hours of work …
  (context reaches 500k: the summary is the handoff, merged into .wisci/handoff/payment-retries.md)
  … the session keeps going from the summary, which is the handoff; this repeats at every compaction …
  — next day —
> /select payment-retries          # the same handoff, its quotes checked
```

**A teammate's notes after the code moved on**

```text
> /select
  context/payment-integration — 1/2 quotes failing
> /select payment-integration
  (Webhook Flow loads under "> check — `src/payments/webhook.ts` no longer contains `return evt.type` …")
  Webhook Flow is out of date: events now go through `dispatch(evt.type)`.
  Run /write .wisci/context/payment-integration.md to fix it.
> /write payment-integration       # re-reads the handler, corrects the section and its quote
```

## What's new in 4.0

- **Only the main session writes handoffs.** Subagent compactions no longer overwrite or add leaves; compaction summaries are read from the session's transcript.
- **No repeated records.** The summarizer sees what is already saved and adds only new items; wisci keeps saved lines byte for byte and drops exact repeats. One case still adds rewordings: a summary Claude Code prepared before a `/compress` restates, in other words, what that `/compress` saved. wisci keeps them rather than risk dropping a record only the summary had.
- **Constraints are your words.** Each is an exact quote that wisci finds in your messages or answers and dates; anything else is left out.
- **State never goes back in time.** A precomputed summary can't replace a newer leaf.
- **`/compress` edits a draft.** `draft` copies the leaf, `save` merges it back and refuses if the leaf changed meanwhile or a saved record was edited.
- **Leaves a cold reader can use.** Codes explained at first use, pointers with what matters there, outcomes rather than attempts, one fact in one place, no secrets.

> [!WARNING]
> **Upgrading from 3.x:** no migration. Existing leaves load and merge as written; their `session:` key is ignored and dropped at the next save. In a session that was already running when you upgraded, run `/compress <stream>` once: it adopts the leaf. Otherwise that session's next compaction saves to a new `<stream>-2` leaf, because a leaf that 3.x saved at compaction carries no proof this session owns it. If you commit `.wisci/`, commit the `.wisci/.gitignore` that wisci creates too: it keeps `.lock`, `.drafts/` and `.pending/` out of git.

## What's new in 3.2

- **The compaction summary is your handoff.** Claude Code's stock summary sections are replaced by `/compress` leaves, one per work stream.
- **Nothing a compaction can lose:**
  - Constraints, Decisions and Tried / Ruled out only grow: old lines are kept byte for byte when a leaf is updated, and they are re-injected right after each compaction.
  - A compaction updates only a stream this session loaded or wrote; any other gets its own leaf.
- **Better leaves:**
  - New Decisions and References sections.
  - Completed says how each item was verified.
  - Next Steps quotes your latest request.
  - A size budget that cuts Completed first.
- **One source of truth.** Every rule for handoffs, compaction included, lives in `skills/compress/SKILL.md`; the engine only adds the time and the stream list.
- **`check` validates a handoff's frontmatter**, so a bad `status` is caught when it's written, not at the next session start.

## What's new in 3.1

- **Handoffs at every compaction.** The compaction summary ends with a handoff in `/compress`'s format, saved to `.wisci/handoff/`. Set `/autocompact` and a long session can compact again and again without losing its work state. See [Handoffs at every compaction](#handoffs-at-every-compaction).
- **No more "run /compress" after compaction.** That rebuilt the handoff from an already-lossy summary; the handoff is now written before the history is dropped.
- **Shorter hook commands.** Hooks run through `hooks/run.sh`, so less hook text lands in your context.

## What's new in 3.0

- **Quoted evidence** replaces `## References` manifests and whole-file change tracking. A flag now means the quoted code is gone, and it names the missing line.
- **Flag, don't strip.** Every section loads; a failing one sits under a `check` marker instead of disappearing.
- **Self-healing notes.** `/select` points out the fix for a wrong note, and `/isolate` saves it.
- **Stateless and lighter.** No primer, no generated handoff index, no `index` command. One stdlib script, run through uv.
- **Gated on three models.** Every release runs trigger, task and outcome evals on Sonnet, Opus and Haiku, and must pass the release gate.

> [!WARNING]
> **Upgrading from 2.x:** there is no migration. Install uv first. 2.x notes load as written, with no quotes, until you next `/write` them. 3.0 doesn't use `.wisci/primer.md` or `.wisci/handoff.md`, so you can delete both.

## Development

<details>
<summary><b>Self-tests, linters and the release gate</b></summary>

<br>

Run these from `plugins/wisci`. Every eval step uses your Claude Code login; check `claude auth status` first.

```bash
uv run --no-config --no-cache --script scripts/wisci.py test
npx pyright --pythonversion 3.11 scripts/wisci.py
uvx ruff check --target-version py311 scripts evals
```

`evals/` holds three suites:

- **Trigger cases** (tag `trigger`) check that each skill fires on its requests and stays silent on near-misses.
- **Task cases** (tag `task`) check behavior in a scaffolded repo with `claude plugin eval`.
- **`evals/outcomes.py`** checks what native graders can't express: git trailers under different attribution settings, byte-identical untouched files, notes healed after a real session, a real compaction that must leave a handoff, a missing uv, the Bash sandbox, a hostile project uv config, and zero permission prompts.

The release gate runs all three suites on Sonnet, Opus and Haiku into one matrix directory, then `evals/gates.py` checks completeness and thresholds. Trigger recall (at least 80%, at most one false fire per skill) gates Sonnet and Opus; Haiku's is recorded, because Haiku often answers small requests itself, as the skills allow. Safety outcomes gate every model, and so does the safety task case `select-flags-changed`, which must pass every run:

```bash
export DISABLE_AUTOUPDATER=1   # a Claude Code update mid-matrix fails the provenance check
R=evals/results/matrix-$(date +%Y%m%d-%H%M) && mkdir "$R"
uv run --no-config --no-cache --script evals/gates.py init "$R"
for M in claude-sonnet-5-5 claude-opus-5-5 claude-haiku-5-5; do
  claude plugin eval . --tag trigger --ablation none --scaffold --trust-plugin --no-publish --runs 1 -j 4 --threshold 0 \
    --model $M --allow-tools Skill Read Glob Grep Agent Bash Write Edit --json "$R/trigger-$M.json"
  claude plugin eval . --tag task --ablation none --scaffold --trust-plugin --no-publish --runs 2 -j 3 --threshold 0 \
    --model $M --allow-tools Bash Write Edit Skill Agent --json "$R/task-$M.json"
  uv run --no-config --no-cache --script evals/outcomes.py --model $M -j 3 --out "$R/outcomes-$M.json"
done
uv run --no-config --no-cache --script evals/gates.py check "$R"
```

`gates.py check` writes `evals/baselines.json`, the per-model reference for future description changes. Scaffolds need a Python 3.11+ on `PATH`: they run with a temporary `HOME`, so uv-managed Pythons are invisible to them.

</details>

## Acknowledgments

- **LangChain**: [Context engineering for agents](https://www.langchain.com/blog/context-engineering-for-agents), the Write, Select, Compress, Isolate taxonomy.
- **Andrej Karpathy**: [the term "context engineering"](https://x.com/karpathy/status/1937902205765607626), and the LLM-as-CPU, context-as-RAM framing from his talks.
- **Drew Breunig**: [how contexts fail](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html): poisoning, distraction, confusion, clash.
- **Anthropic**: [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [Claude Code](https://code.claude.com/docs), and the [Agent Skills standard](https://agentskills.io).
- **Manus, Cline, llms.txt, Obsidian MOC**: prior art behind the store design.

## License

[MIT](../../LICENSE)
