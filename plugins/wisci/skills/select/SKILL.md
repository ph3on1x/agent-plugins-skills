---
name: select
description: Loads stored project context — a quick orientation with an inventory of stored notes and handoffs, or everything stored on one topic, note or stream — flagging any section whose quoted code is no longer in the codebase. Use when starting or resuming a session, orienting in a project, getting an overview of the codebase before work, catching up after time away, or asking which notes and handoffs exist or what is stored about something.
argument-hint: "[topic, note or stream]"
allowed-tools: Read Glob Grep Agent Bash(git *) Bash(uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py" *)
compatibility: Requires git and uv (uv provides Python 3.11+); uses the bundled scripts/wisci.py.
---

# /select — Context Loader

Load the stored context this task needs.

Script: `uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py"` (`<wisci>` below). Run it exactly as written, as a command of its own, with the absolute path and quotes and no shell variables: the permission rule matches only that literal command. Hosts without command injection: run it from the project root with `<this skill's directory>/scripts/wisci.py` as the path.

## Store state

!`uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py" scan`

- `health`: `[path, failed, quotes]` for every store file (`context/<slug>`, `handoff/<slug>`): how many of its quoted code blocks no longer match the code.
- `streams`: `[path, lifecycle, updated, goal]` for handoffs.

## Reading stored files

Read every store file through the loader, never with Read: `<wisci> load .wisci/<path>.md`. It prints the whole note and ends with `… evidence ok N/M`. Under any section whose quoted code is no longer in its file it puts a marker naming the file and the missing code: `> check — …`. A raw Read drops the markers.

Before relying on a section marked `check`, re-read the file its marker names and go by what it says now. `ok` means the quoted code is still there, not that every claim is still true.

If the code contradicts a loaded section, flagged or not, name the store path and section, state the current fact, and suggest `/write <note path>` for a note or `/compress <stream slug>` for a handoff. Do not update the store.

A handoff whose `updated` is more than 7 days old: say so, its next steps may be outdated.

## Bare `/select`

1. **Orientation.** Read `README.md` and `CLAUDE.md` or `AGENTS.md` if present, and list the top-level directories with `git ls-files`. Sum up the project in 5–10 lines. Don't store it.
2. **Handoff streams** from the scan's `streams`:
   - none: skip.
   - one: load and present it.
   - several: list path, lifecycle, updated and goal. Load one only if exactly one is `active`. The user picks another with `/select <path>`.
3. **Inventory.** List each `context/…` entry from `health` with its evidence: `2/5 quotes failing`, `5/5 quotes ok` or `no quotes`. The user loads a note with `/select <path>`, so don't load notes here.
4. **Present:**

   ```markdown
   ## Project Overview
   <orientation>

   ### Handoff
   <stream list or loaded stream; omit if none>

   ### Available Context
   <inventory>
   ```

   No `.wisci/` yet: give the orientation, then "No stored context yet. Use /write to save some."

## `/select <topic, note or stream>`

1. **Load matching stored files.** Compare `$ARGUMENTS` with the scan's `health` paths and `streams` goals, and load every match. If `$ARGUMENTS` names a stream and the user only asked for its state, stop after presenting it.
2. **Fill only the gaps.** Explore what the stored files don't answer:
   - **Code:** search for the topic's names and patterns.
   - **History:** `git log --oneline -20 -- <paths>` and `git log --oneline --grep "<topic>"`.
   - **Docs:** `README.md`, `docs/`, comments in the relevant files.

   Spawn Explore subagents only when the scope spans 10+ files across several subsystems: at most 3, all in one message. Otherwise explore directly.
3. **Present:**

   ```markdown
   ## Selected Context: <topic>

   ### Relevant Code
   <key files, functions, relationships — paths and line numbers>

   ### History
   <relevant changes and why they matter; omit if none>

   ### Documentation
   <docs and loaded notes; omit if none>

   ### Summary
   <how the pieces fit together for the current task>
   ```

## Report

End with one line, numbers taken from the loader output:

`Loaded: <n> files (~<sum of ~tokens> tokens). Evidence: <ok>/<total> quotes ok. Skipped: <file — reason>.`
