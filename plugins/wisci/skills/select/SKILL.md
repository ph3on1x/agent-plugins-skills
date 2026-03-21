---
name: select
description: This skill should be used when the user asks to "load context", "prime session", "what's in scratchpad", "show project overview", or needs to load relevant context into the current window. Bare invocation gives codebase overview; with arguments gives targeted deep dive.
argument-hint: "[topic] (optional — omit for codebase primer)"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Agent
  - Bash(git *)
---

# /select — Context Loader

Load relevant context into the current window. This is the "load from disk" operation — retrieve exactly the information needed for the current task.

## Mode Detection

Check `$ARGUMENTS`:
- **Empty or blank:** execute **bare mode** — read and follow `${CLAUDE_SKILL_DIR}/references/bare-mode.md`
- **Has content:** execute **targeted mode** — read and follow `${CLAUDE_SKILL_DIR}/references/targeted-mode.md`

## Staleness Detection

Both modes use staleness detection to validate context files before loading or listing them. For the full procedure, read `${CLAUDE_SKILL_DIR}/references/staleness-detection.md`.

### Staleness Action Rules

After running staleness detection, apply these rules:

**When loading context files (targeted mode):**

- **Fresh files:** load as-is into the context
- **Stale files:** load with stale sections stripped. A section "depends on" a reference if that reference's file path appears in the section body.
  - Strip sections whose dependent references have changed
  - If a stale reference only appears in `## References` and not in any section body, do not strip any section — instead prepend this warning to the file:
    ```
    > **Note:** Referenced file <path> has changed since this context was written.
    ```
  - When sections are stripped, prepend this note:
    ```
    > **Note:** N sections were stripped because their referenced files have changed. Consider /write <topic> to refresh this file.
    ```
- **Broken files:** do not load. Report to the user:
  ```
  "<filename> references code that no longer exists. Delete it or refresh with /write."
  ```

**When listing context files (bare mode):**

- Report all files with staleness status: `fresh`, `stale`, or `broken`
- For stale files: list which referenced files changed, when, and how many sections are affected
- For broken files: list which referenced files no longer exist

## Output Formats

### Bare Mode Output

```markdown
## Project Overview

### Structure
<Directory tree with annotations>

### Tech Stack
<Languages, frameworks, key dependencies>

### Conventions
<Coding patterns, naming conventions, architecture style>

### Available Context
- auth-research.md          fresh
- payment-integration.md    stale (2 sections stripped; src/payments/webhook.ts changed 2 days ago)
- handoff.md                broken (src/old-module.ts no longer exists) — not loaded
```

### Targeted Mode Output

```markdown
## Selected Context: <topic>

### Relevant Code
<Key files, functions, and their relationships>

### History
<Relevant git changes and their context>

### Documentation
<Related docs, comments, or previously written context>

### Summary
<How these pieces fit together for the current task>
```

## Key Constraints

- **This skill runs inline** (not as a forked subagent). Targeted mode may spawn child agents via the Agent tool for deep exploration.
- Stale content stripping is automatic — never load outdated information into the context window.
- `scratchpad/` files use `## References` as their staleness manifest. Files without this section are treated as having no trackable references (always classified as fresh).

## Additional Resources

### Reference Files

For mode-specific procedures and staleness detection, consult:
- **`references/bare-mode.md`** — Full codebase primer procedure
- **`references/targeted-mode.md`** — Targeted exploration procedure
- **`references/staleness-detection.md`** — 4-step staleness detection using git
