---
name: compress
description: This skill should be used when the user asks to "compress session", "create handoff", "end session", "save progress for later", or needs to transition work to a new session. Creates compressed handoff documents for session transitions.
argument-hint: "[scope] (optional — omit for full session)"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash(git *)
---

# /compress — Session Handoff Creator

Create a compressed handoff document that captures everything needed to continue the current work in a fresh session. Distill session work into a narrative optimized for resuming, not archival.

## Execution Flow

1. **Parse scope.** Read `$ARGUMENTS`. If empty, scope to the full session. If provided, scope to the specified work stream.

2. **Derive filename.**
   - No arguments: target file is `scratchpad/handoff.md`
   - With arguments: derive a slug using the slug inference rules below, prefix with `handoff-`, target file is `scratchpad/handoff-<slug>.md`

3. **Check for existing handoff.** Use Glob to check if the target file already exists in `scratchpad/`.

4. **Analyze session context.** Review the current conversation to extract:
   - **Goal** — what the session set out to accomplish
   - **Completed work** — what was done, with file paths and specific changes
   - **Decisions** — every decision made and its rationale
   - **In-progress work** — what is partially done, current state
   - **Next steps** — immediate actions needed to continue
   - **Blockers / open questions** — unresolved issues

5. **Build the References section.** Collect all file paths that were modified, read, or are relevant to resuming work. Annotate each with a brief description of why it matters.

6. **Write or merge.**
   - **No existing handoff:** write a new file using the output format below
   - **Existing handoff found:** perform an intelligent merge (see merge rules below)

7. **Write the file.** Use the Write tool (new file) or Edit tool (merge) to save to `scratchpad/`.

8. **Confirm and suggest.** Report what was written and where. Suggest: "Start a fresh session and use `/select` to reload this context."

## Slug Inference Rules

When arguments are provided, derive the filename slug:

1. Extract the core topic noun phrase from arguments (strip filler: "results on", "notes about", "current state of")
2. Convert to kebab-case, lowercase
3. Truncate to a maximum of 5 words
4. Use Glob to check `scratchpad/` for an existing file with this slug
   - **Exact match, same topic:** merge into it
   - **Exact match, different topic:** ask the user whether to merge or create a disambiguated name
   - **No match:** create new file

## Handoff Merge Rules

When merging into an existing handoff:

- **Completed:** append new completed items to the existing list (grows over time)
- **In Progress:** replace entirely with current state
- **Next Steps:** replace entirely with current priorities
- **Decisions Made:** add new decisions; update changed decisions with current rationale
- **Blockers / Open Questions:** replace with current blockers
- **References:** rebuild from scratch based on current session state
- **Goal:** update only if the goal has shifted

## Output Format

```markdown
# Handoff: <session/scope summary>

> Last updated by /compress on YYYY-MM-DD HH:MM

## Goal
<What we were trying to accomplish>

## Completed
<What was done, with specific details>
- <change 1: file path, what changed, why>
- <change 2: ...>

## In Progress
<What's partially done, current state>

## Decisions Made
- <Decision>: <rationale>

## Next Steps
1. <Immediate next action>
2. <Following action>
3. ...

## Blockers / Open Questions
- <Any unresolved issues>

## References
- `src/auth/middleware.ts` — modified, added token refresh logic
- `src/auth/session.ts:42` — session expiry config, relevant to next steps
- `src/models/user.ts` — User model, role fields referenced in auth decisions
```

## Preservation Rules

Compression is intentionally lossy — summarize verbose exploration, dead ends, and raw tool outputs. However, always preserve these specifics that a fresh session would need to re-discover:

- File paths modified or relevant to resuming work
- Decisions made and their rationale
- Error codes, error messages, and root causes identified
- Exact endpoints, API routes, or configuration values discovered
- Names of functions, classes, or modules changed or next to change
- Blockers, open questions, and unresolved issues
- Current state of in-progress work (what is done, what is not)

Never reduce specifics to vague summaries. "The 401 error from `/api/auth/login` was caused by an expired Redis session store" must not become "configuration problems."

## Key Constraints

- The handoff file represents current state, not historical snapshots. Git preserves history.
- `## References` is always the last section. Each reference includes a brief annotation.
- For parallel work streams, the user scopes with arguments: `/compress auth module`, `/compress api migration`.
- Results go to `scratchpad/` only. Ensure the directory exists before writing (create it if needed).
