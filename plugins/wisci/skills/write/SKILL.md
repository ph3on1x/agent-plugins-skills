---
name: write
description: This skill should be used when the user asks to "save context", "write research", "externalize findings", "persist decisions", or needs to move information from the conversation to disk. Externalizes context to persistent scratchpad files.
argument-hint: description of what to externalize
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash(git *)
---

# /write — Context Externalizer

Externalize information from the current context window into a structured, persistent markdown file in `scratchpad/`. This is the "save to disk" operation — preserve knowledge that would otherwise be lost to context limits or session endings.

## Execution Flow

1. **Parse arguments.** Read `$ARGUMENTS` to understand what information to externalize from the current context.

2. **Derive topic slug.** Apply the slug inference rules below to determine the target filename.

3. **Check scratchpad.** Use Glob to list files in `scratchpad/` and check for an existing file matching the slug.

4. **Branch on create or merge.**
   - **No existing file:** proceed to Create Mode (below)
   - **Existing file found:** proceed to Merge Mode — read `${CLAUDE_SKILL_DIR}/references/merge-procedure.md` and follow the merge procedure

5. **Write the file.** Use the Write tool (new file) or Edit tool (merge) to save to `scratchpad/<topic-slug>.md`.

6. **Confirm to the user.** Report what was written or updated, the file path, and a brief summary of contents.

## Slug Inference Rules

Derive a filename slug from `$ARGUMENTS`:

1. Extract the core topic noun phrase (strip filler: "results on", "notes about", "current state of")
2. Convert to kebab-case, lowercase
3. Truncate to a maximum of 5 words
4. Use Glob to check `scratchpad/` for an existing file matching this slug
   - **Exact match, same topic:** merge into it, report to the user
   - **Exact match, different topic:** ask the user whether to merge or create a disambiguated name
   - **No match:** create a new file

If the user specifies a target filename explicitly (e.g., `/write update auth-research with new findings`), use that filename directly.

## Create Mode

When no existing file matches:

1. Extract and structure information from the current context based on `$ARGUMENTS`
2. Organize into logical sections with `##` headings
3. Build a `## References` section listing all file paths mentioned in the content
4. Write to `scratchpad/<topic-slug>.md` using the output format below

## Output Format

```markdown
# <Title inferred from arguments>

> Last updated by /write on YYYY-MM-DD HH:MM
> Source: <what session context this was extracted from>

## Summary
<2-3 sentence overview of what this document contains>

## <Section 1>
<Structured content with all specifics preserved>

## <Section N>
...

## Key Details
- **Decisions**: <every decision made with rationale>
- **Open questions**: <anything unresolved>

## References
- `src/auth/middleware.ts` — auth middleware, token validation logic
- `src/auth/session.ts:42` — session expiry configuration
- `src/models/user.ts` — User model, referenced for role fields
```

## Preservation Rules

Never summarize or omit these specifics:

- Exact file paths and line numbers
- Error messages and error codes
- Numeric values, measurements, benchmarks
- Command outputs and their results
- Decisions and the reasoning behind them
- Names of functions, classes, variables, and modules
- URLs and references
- Sequences of steps taken and their outcomes

## Key Constraints

- `## References` is always the last section. Each reference includes a brief annotation of why it is referenced. This manifest enables staleness detection by `/select`.
- The `## References` section is rebuilt from scratch on every write — it reflects the current state, not accumulated history.
- Ensure `scratchpad/` directory exists before writing (create it if needed).
- When in doubt during merge, preserve both old and new content and flag with `<!-- REVIEW: possible overlap -->`.

## Additional Resources

### Reference Files

For detailed merge and staleness procedures, consult:
- **`references/merge-procedure.md`** — Section-level merge algorithm with staleness pruning
- **`references/staleness-detection.md`** — 4-step staleness detection procedure using git
