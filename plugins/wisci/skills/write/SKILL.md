---
name: write
description: Externalizes knowledge from the conversation into persistent, staleness-tracked markdown files under .wisci/context/. Use when research results, decisions, or findings are worth keeping beyond this session, or when the user wants context saved to disk.
argument-hint: description of what to externalize
allowed-tools: Read Write Edit Glob Grep Bash(git *) Bash(python3 *)
compatibility: Requires git and python3 (bundled wisci.py script)
---

# /write — Context Externalizer

Move knowledge from the context window into a structured, persistent file in `.wisci/context/`. This is the "save to disk" operation — preserve what would otherwise be lost to context limits or session endings.

**Boundary:** `/write` stores reusable *knowledge* (research, decisions, architecture notes). Session work *state* (goal, in-progress, next steps) belongs in `/compress`.

Timestamp: !`date '+%Y-%m-%d %H:%M'`

## Execution Flow

1. **Parse arguments.** Read `$ARGUMENTS` to determine what to externalize from the current context.

2. **Derive topic slug.** Extract the core topic noun phrase (strip filler: "results on", "notes about"), kebab-case, lowercase, max 5 words. If the user names a target file explicitly, use it.

3. **Check for existing file.** Glob `.wisci/context/` for the slug:
   - **No match:** Create Mode below.
   - **Exact match, same topic:** Merge Mode — read and follow [references/merge-procedure.md](references/merge-procedure.md).
   - **Exact match, different topic:** ask the user — merge or disambiguated new name.

4. **Write** to `.wisci/context/<topic-slug>.md` (create directories as needed).

5. **Confirm.** Report path, created vs merged, and a one-line content summary.

## Create Mode

1. Extract and structure the information from the current context per `$ARGUMENTS`
2. Organize into logical `##` sections
3. Build a `## References` section listing every file path mentioned in the content
4. Write using the output format below

## Output Format

```markdown
# <Title inferred from arguments>

> Last updated by /write on <timestamp from above>
> Source: <what session context this was extracted from>

## Summary
<2-3 sentence overview>

## <Section 1>
<Structured content with all specifics preserved>

## Key Details
- **Decisions**: <every decision made, with rationale>
- **Open questions**: <anything unresolved>

## References
- `src/auth/middleware.ts` — auth middleware, token validation logic
- `src/auth/session.ts:42` — session expiry configuration
```

## Preservation Rules

Never summarize away:

- Exact file paths and line numbers
- Error messages and error codes
- Numeric values, measurements, benchmarks
- Command outputs and their results
- Decisions and the reasoning behind them
- Function, class, variable, and module names
- URLs and references

When condensing verbose material, compression must be reversible: keep the pointer (file path, URL, commit hash) next to every condensed claim so the detail is one Read away.

## Key Constraints

- `## References` is always the last section, each entry annotated with why it is referenced. This manifest powers staleness detection by `/select` and the bundled script ([scripts/wisci.py](scripts/wisci.py)).
- The `## References` section is rebuilt from scratch on every write — current state, not accumulated history.
- When in doubt during merge, preserve both versions and flag with `<!-- REVIEW: possible overlap -->`.
