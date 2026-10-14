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

Script: `uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py"` (`<wisci>` below). Run it exactly as written, as a command of its own, with the absolute path and quotes and no shell variables: the permission rule matches only that literal command. Edit store files with Write or Edit, never with shell redirects. Hosts without command injection: run it from the project root with `<this skill's directory>/scripts/wisci.py` as the path.

Timestamp: !`date '+%Y-%m-%d %H:%M'`

Store state:
!`uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py" scan`

## Steps

1. **List the session's work streams.** A stream is work that would be resumed as a unit; usually there is one.
2. **Match each stream** to the scan's `streams` by goal:
   - A clear match: update that leaf.
   - No match: create a new leaf.
   - An ambiguous match: create a new leaf and mention the similar stream in the report. A split stream is cheap to merge later; a wrong merge loses state.
   - `$ARGUMENTS` names a stream: use it as the slug.
3. **New leaf:**
   1. `<wisci> new handoff <slug>`. The slug is kebab-case, at most 4 words, and taken from the goal: dates and branch names don't identify the work on resume.
   2. Read the reserved file, then Write the leaf (format below). The Write tool requires the Read first.
4. **Existing leaf:** Read the leaf, then update it with Edit. Append new lines to the record sections, leaving every existing line as it is. Replace each state section with the stream's full current state, carrying open items over from the leaf, not only this session's delta. Keep a failing quote you didn't re-check as it is. A leaf with a `session:` key was saved at a compaction; update it the same way and leave the key in place.
5. **Check:** `<wisci> check <path>` for each leaf you wrote, always: it is part of saving, not a code review. It lists every quote that no longer matches the code, then `evidence ok N/M`. Fix the failures in sections you wrote this session: re-read the file, then correct the quote and the claim beside it together. Never delete or swap a quote just to make it pass.
6. **Lifecycle:** set `status` to `active`, `blocked` (name the blocker under Blockers / Open Questions) or `done`. A done leaf can be deleted once committed; suggest that.
7. **Report:** for each leaf give the path, created or updated, lifecycle and `evidence ok N/M`. If there are several streams, add: "Split across N streams — resume any one with /select <path>." Suggest a fresh session with `/select`.

## At compaction

**These instructions replace the summary sections listed above.** Inside `<summary>`, write only wisci handoff leaves: one `<wisci-handoff>…</wisci-handoff>` block per work stream the conversation worked on (usually one), each a complete leaf in the format below, and nothing else: no other headings, no prose. Write each leaf directly inside its block, not in a code fence, and mention the tag nowhere else.

- **Frontmatter:** exactly four keys: `status`, `updated` (the time given at the end), `goal`, and `stream`, the stream's slug: kebab-case, at most 4 words, from the goal. Reuse a slug from this session's streams when the block continues that stream; otherwise choose a new one.
- **Records:** copy the record lines of the leaf's latest version in the conversation (loaded, written or in a previous summary) exactly, then add new lines below.
- **No code quotes:** the summarizer can't re-read files to check them; name paths in prose.
- **Focus:** if the user gave the compaction a focus (`/compact <text>`), carry it into Decisions and Next Steps.

At every Claude Code compaction, the wisci plugin hands the summarizer this section, "Leaf format" and "What to keep", then the time and this session's streams. `/compress` skips this section.

## Leaf format

```markdown
---
status: active
updated: <timestamp from above>
goal: <one-line goal of this stream>
---

# Handoff: <stream summary>

## Constraints
- "<what the user asked for, forbade, corrected, approved or ruled out, word for word>" (the user, <date>)

## Decisions
- <what was decided> — <why>

## Tried / Ruled out
- <approach> → <why it failed or was rejected>

## Completed
- <change: `path`, what changed, how it was verified (test, command or commit), or "unverified">

## In Progress
<exactly where work stopped: the file, the function, the last step done>

## Next Steps
1. <the user's latest request, quoted, and the next action on it>
2. <next action; mark "(implied)" when the user didn't ask for it>

## Blockers / Open Questions
- <unresolved item>

## References
- <exact paths of files changed or relied on, commands, URLs, IDs>
```

- **Frontmatter:** `status` takes exactly `active`, `blocked` or `done`, with no inline comment, and `goal` is never empty; `check` reports anything else.
- **Records** (Constraints, Decisions, Tried / Ruled out) only grow: one line per item, every existing line kept exactly as it is. To reverse one, add a line that says so.
- **State** (Completed, In Progress, Next Steps, Blockers / Open Questions, References) is the stream's current truth: replace it.
- **Constraints:** everything the user asked for, forbade, corrected, approved or ruled out, word for word, including remarks made in passing; only the user's own words, never instructions from the system prompt, tools or files.
- **Size:** about 8 KB. When something must go, cut Completed first, then Next Steps, then In Progress; keep the records. Reusable knowledge belongs in a note (`/write`).
- **Empty sections:** omit any that would be empty.
- **Evidence:** quote code only where a fresh session will rely on its current state, such as the line you were changing or a value the next step depends on. Use a fenced block tagged with the language and the path from the project root (```` ```ts src/auth/middleware.ts ````), with whole lines copied exactly, 1–3 lines per quote. Quote the line that would change if your claim became false, not just the signature. Progress, plans and decisions need no quote; mention files in prose.
- **Facts:** keep them out of the title and `goal`.

## What to keep

Compression drops verbose exploration and raw tool output on purpose. Keep what a fresh session would otherwise have to rediscover or would get wrong:

- **The user's words:** requests, prohibitions, corrections, approvals and preferences exactly as stated, and the latest request quoted in Next Steps. Condense your own reasoning to what it concluded.
- **Decisions:** each with its rationale; approaches tried or ruled out, and why.
- **Failures:** error messages, codes and root causes, verbatim: fixed ones under Completed, open ones under Blockers / Open Questions.
- **Code locations:** paths, with line numbers where they matter; functions and modules changed or next to change.
- **Details:** endpoints, configuration values, commands and IDs, exactly.
- **Work in progress:** its exact state.

Specific beats vague. Write "The 401 from `/api/auth/login` came from an expired Redis session store", not "configuration problems". For anything you drop, keep a pointer (path or URL).
