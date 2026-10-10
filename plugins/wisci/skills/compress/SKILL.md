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
4. **Existing leaf:** Read the leaf, then Write the stream's full current state. Include open items carried over from the leaf, not only this session's delta. Keep a failing quote you didn't re-check as it is.
5. **Check:** `<wisci> check <path>` for each leaf you wrote, always: it is part of saving, not a code review. It lists every quote that no longer matches the code, then `evidence ok N/M`. Fix the failures in sections you wrote this session: re-read the file, then correct the quote and the claim beside it together. Never delete or swap a quote just to make it pass.
6. **Lifecycle:** set `status` to `active`, `blocked` (name the blocker under Blockers) or `done`. A done leaf can be deleted once committed; suggest that.
7. **Report:** for each leaf give the path, created or updated, lifecycle and `evidence ok N/M`. If there are several streams, add: "Split across N streams — resume any one with /select <path>." Suggest a fresh session with `/select`.

## Leaf format

```markdown
---
status: active
updated: <timestamp from above>
goal: <one-line goal of this stream>
---

# Handoff: <stream summary>

## Completed
- <change — `path`, what changed, why>

## In Progress
<the exact current state of partial work>

## Next Steps
1. <immediate next action>

## Tried / Ruled out
- <approach> → <why it failed or was rejected>

## Constraints
- <the user's requirement, constraint or preference, in their words>

## Blockers / Open Questions
- <unresolved items>
```

- **Frontmatter:** `status` takes exactly `active`, `blocked` or `done`. The script rejects anything else, including inline comments.
- **Empty sections:** omit any that would be empty.
- **Evidence:** quote code only where a fresh session will rely on its current state, such as the line you were changing or a value the next step depends on. Use a fenced block tagged with the language and the path from the project root (```` ```ts src/auth/middleware.ts ````), with whole lines copied exactly, 1–3 lines per quote. Quote the line that would change if your claim became false, not just the signature. Progress, plans and decisions need no quote; mention files in prose.
- **Facts:** keep them out of the title and `goal`.

## What to keep

Compression drops verbose exploration and raw tool output on purpose. Keep what a fresh session would otherwise have to rediscover:

- **Code locations:** paths, with line numbers where they matter; functions and modules changed or next to change.
- **Decisions:** each with its rationale; approaches tried or ruled out, and why.
- **Failures:** error messages, codes and root causes.
- **Details:** endpoints and configuration values.
- **The user's requests, constraints and preferences:** exactly as stated.
- **Work in progress:** its exact state.

Specific beats vague. Write "The 401 from `/api/auth/login` came from an expired Redis session store", not "configuration problems". For anything you drop, keep a pointer (path or URL).
