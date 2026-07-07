---
name: select
description: Loads validated project context into the session — bare invocation gives a codebase primer plus an inventory of stored context and handoffs; with arguments it runs a targeted deep dive on one topic. Use when starting or resuming a session, orienting in a project, or loading stored context for a task.
argument-hint: "[topic] (optional — omit for codebase primer)"
allowed-tools: Read Glob Grep Agent Bash(git *) Bash(python3 *)
compatibility: Requires git and python3 (bundled wisci.py script)
---

# /select — Context Loader

Load exactly the context the current task needs. Every stored file is validated by staleness detection before it enters the window — outdated content is stripped, never loaded.

## Store state

!`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/wisci.py" scan`

> If the scan above shows an error or an unexpanded variable, run the bundled script manually: it is at [scripts/wisci.py](scripts/wisci.py) relative to this skill's directory. Run `python3 <that path> scan` with Bash.

The scan classifies every file in `.wisci/` (`fresh` / `stale` / `broken`), lists what changed, and enumerates handoff streams. Trust it — do not re-derive staleness with your own git commands.

## Mode Detection

Check `$ARGUMENTS`:
- **Empty or blank:** execute **bare mode** — read and follow [references/bare-mode.md](references/bare-mode.md)
- **Has content:** execute **targeted mode** — read and follow [references/targeted-mode.md](references/targeted-mode.md)

## Staleness Action Rules

Apply to every context file before loading:

- **Fresh:** load as-is.
- **Stale:** load with stale sections stripped. A section "depends on" a reference if that reference's path appears in the section body.
  - Strip sections whose dependent references appear in the scan's `changed` list.
  - If a changed reference appears only in `## References` and in no section body, strip nothing — prepend instead:
    ```
    > **Note:** Referenced file <path> has changed since this context was written.
    ```
  - When sections are stripped, prepend:
    ```
    > **Note:** N sections stripped — their referenced files changed. Consider /write <topic> to refresh.
    ```
- **Broken:** do not load. Report: "<filename> references code that no longer exists. Delete it or refresh with /write."
- **Handoff leaves older than 7 days** (scan `age_days`): warn before loading — "handoff is N days old; its next steps may be outdated."
- Files without a `## References` manifest have no trackable references — treat as fresh.

## Output Contract

End every invocation with a load report:

```
Loaded: <n> files (~<k> tokens). Stripped: <n> stale sections. Skipped: <files, reason>.
```

Estimate tokens as total loaded bytes / 4. The point: the user sees what this load cost their context window.

## Key Constraints

- **Runs inline** (not forked) — loaded context must land in the main window. Targeted mode may spawn child agents for exploration.
- Never load stale or broken content; the stripping rules are not optional.
- The handoff index (`.wisci/handoff.md`) is script-generated — read it for routing, never edit it.
