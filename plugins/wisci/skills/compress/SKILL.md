---
name: compress
description: Snapshots session work state — goal, done work, in-progress state, next steps, ruled-out approaches, user constraints — into per-stream handoffs in .wisci/handoff/ for a later session or teammate. Use when the user wants to wrap up, stop for the day, save progress, create a handoff, or continue in a fresh session because context is filling up. Not for compressing files or data, or for summarizing the conversation inline.
argument-hint: "[stream slug]"
allowed-tools: Read Write Edit Glob Grep Bash(git *) Bash(uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py" *)
compatibility: Requires git and uv (uv provides Python 3.11+); uses the bundled scripts/wisci.py.
---

# /compress — Session Handoff

Capture what a fresh session needs to resume this work, one file per work stream in `.wisci/handoff/`. Streams this session didn't work on are never touched, so parallel sessions don't overwrite each other.

Reusable knowledge (research, architecture, decisions worth keeping after the work ships) belongs in a note. Suggest `/write <topic>` rather than burying it here.

Script: `uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py"` (`<wisci>` below). Run it exactly as written, as a command of its own, with the absolute path and quotes and no shell variables: the permission rule matches only that literal command. You edit drafts with Write or Edit, never with shell redirects; only `save` writes a leaf. Hosts without command injection: run it from the project root with `<this skill's directory>/scripts/wisci.py` as the path, and leave out `--session`.

Store state:
!`uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py" scan`

## Steps

1. **List the session's work streams.** A stream is work that would be resumed as a unit; usually there is one.
2. **Match each stream** to the scan's `streams` by goal:
   - A clear match: update that leaf.
   - No match: create a new leaf.
   - An ambiguous match: create a new leaf and mention the similar stream in the report. A split stream is cheap to merge later; a wrong merge loses state.
   - `$ARGUMENTS` names a stream: use it as the slug.
3. **Draft:** `<wisci> draft <slug> --session ${CLAUDE_SESSION_ID}` prints a draft's path: a copy of the leaf, or an empty leaf for a new slug. A new slug is kebab-case, at most 4 words, and taken from the goal: dates and branch names don't identify the work on resume. Read the draft, then edit it into the format below:
   - **Records:** add new items at the end of each record section, and leave every saved line as it is.
   - **State:** replace each state section with the stream's full current state, carrying open items over from the leaf, not only this session's delta.
   - **Lifecycle:** set `status` to `active`, `blocked` (name the blocker under Blockers / Open Questions) or `done`.
   - Keep a failing quote you didn't re-check as it is.
4. **Save:** `<wisci> save <draft path> --session ${CLAUDE_SESSION_ID}`.
   - It refuses a draft whose leaf changed meanwhile, or whose saved record lines were edited or removed. Then draft again and redo the edits.
   - It leaves out a Constraint that isn't the user's exact words and names it. Quote the words exactly or move the point to Decisions, then add it with a new draft.
   - It ends with the `check` report, every time: it is part of saving, not a code review. It lists every quote that no longer matches the code, then `evidence ok N/M`. Fix the failures in sections you wrote this session with a new draft: re-read the file, then correct the quote and the claim beside it together. Never delete or swap a quote just to make it pass.
5. **Report:** for each leaf give the path, created or updated, lifecycle and `evidence ok N/M`. If there are several streams, add: "Split across N streams — resume any one with /select <path>." Suggest a fresh session with `/select`. A done leaf can be deleted once committed; suggest that.

## At compaction

**These instructions replace the summary sections listed above.** Inside `<summary>`, write only wisci handoff leaves: one `<wisci-handoff>…</wisci-handoff>` block per work stream the conversation worked on (usually one), each a leaf in the format below, and nothing else: no other headings, no prose. Write each leaf directly inside its block, not in a code fence, and mention the tag nowhere else.

- **Frontmatter:** `status`, `goal`, and `stream`, the stream's slug: kebab-case, at most 4 words, from the goal. Reuse a slug from this session's streams when the block continues that stream; otherwise choose a new one.
- **Records are new items only.** wisci keeps every line listed under "Already saved", so never repeat or reword one. Write only what is new since; leave a record section out when nothing is.
- **No code quotes:** the summarizer can't re-read files to check them; name paths in prose.
- **Focus:** if the user gave the compaction a focus (`/compact <text>`), carry it into Decisions and Next Steps.

At every Claude Code compaction, the wisci plugin hands the summarizer this session's saved records and streams, then this section, "Leaf format" and "What to keep". `/compress` skips this section.

## Leaf format

```markdown
---
status: active
goal: <one-line goal of this stream>
---

# Handoff: <stream name>

## Constraints
- "<the user's exact words>"

## Decisions
- <what was decided> — <why>

## Tried / Ruled out
- <approach> → <why it failed or was rejected>

## Completed
- <outcome needed to resume: what changed, its `path`, how it was verified (test, command or commit) or "unverified">

## In Progress
<exactly where work stopped: the file, the function, the last step done; for running work, its handle (job ID, PID, log path)>

## Next Steps
1. [user] <the user's latest request, quoted> — <the next action on it>
2. [agent] <an action the agent committed to>
3. (implied) <an action nobody asked for>

## Blockers / Open Questions
- <unresolved item>

## References
- `<path, command, URL or ID>` — <what matters there>
```

- **Frontmatter:** `status` takes exactly `active`, `blocked` or `done`, with no inline comment, and `goal` is never empty. wisci writes `updated` and `committed-by`; leave them as they are.
- **Records** (Constraints, Decisions, Tried / Ruled out) only grow: one item per line, and wisci keeps every saved line exactly as it is. To reverse one, add a line that says so.
- **Constraints:** what the user asked for, forbade, corrected, approved or ruled out that still holds later, quoted exactly from their own message or AskUserQuestion answer, at least 3 words; nothing else on the line. A question or a one-off reply is not a Constraint. wisci checks each quote against the user's messages, leaves out any it can't find, and adds the date and the question. Lessons the agent learned go to Decisions; rules from CLAUDE.md, the system prompt, tools, files or other agents are never Constraints.
- **State** (Completed, In Progress, Next Steps, Blockers / Open Questions, References) is the stream's current truth: replace it. Finished work leaves In Progress; answered questions and resolved blockers are removed.
- **Size:** the state sections about 6 KB; the records come on top. When something must go, cut Completed first, then Next Steps, then In Progress. Reusable knowledge belongs in a note (`/write`).
- **Empty sections:** omit any that would be empty.
- **Evidence:** quote code only where a fresh session will rely on its current state, such as the line you were changing or a value the next step depends on. Use a fenced block tagged with the language and the path from the project root (```` ```ts src/auth/middleware.ts ````), with whole lines copied exactly, 1–3 lines per quote. Quote the line that would change if your claim became false, not just the signature. Progress, plans and decisions need no quote; mention files in prose.
- **Title and goal:** name the stream; keep status and facts out of them.

## What to keep

Compression drops verbose exploration and raw tool output on purpose. Keep what a fresh session would otherwise have to rediscover or would get wrong, written for a reader who never saw this conversation:

- **The user's words:** requests, prohibitions, corrections, approvals and preferences as exact quotes, and the latest request quoted in Next Steps. Condense your own reasoning to what it concluded.
- **Decisions and Tried:** lasting choices and rejected approaches, each with its reason; to-dos belong in Next Steps, progress in the state sections.
- **Failures:** error messages, codes and root causes, verbatim: fixed ones under Completed, open ones under Blockers / Open Questions.
- **Code locations:** paths, with line numbers where they matter; functions and modules changed or next to change.
- **Details:** endpoints, configuration values, commands and IDs, exactly.
- **Work in progress:** its exact state.
- **Plain terms:** explain every code name, abbreviation and label at first use ("F, the pivot forecaster"). A pointer is a path or ID plus what matters there, never "see above" or "as discussed".
- **Outcomes, not attempts:** what happened and what it showed.
- **One fact, one place:** state each fact once, in the section it belongs to.
- **Orchestration:** name each worker agent or teammate with the path of its handoff or output; don't copy their state here.
- **Secrets:** never copy keys, tokens, passwords or other credentials.

Specific beats vague. Write "The 401 from `/api/auth/login` came from an expired Redis session store", not "configuration problems". For anything you drop, keep a pointer (path or URL).
