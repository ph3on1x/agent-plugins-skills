# WISCI Design: Topic-Based Storage & Staleness Detection

## Overview

This spec defines two changes to the WISCI framework PRD:

1. **Topic-based storage** — Replace date-prefixed chronological files with topic-named living documents that are updated in place via intelligent merge.
2. **Staleness detection** — Add git-based validation to `/select` that warns users when context files reference code that has changed.

These changes address context poisoning (the #1 risk of persistent context files) while keeping the framework's philosophy of simplicity and file-based storage.

---

## 1. Topic-Based Storage Model

### Current behavior (to be replaced)

Files in `context/` are named with date prefixes: `2026-03-20-auth-research.md`. Each `/write` and `/compress` creates a new file. The directory accumulates chronologically.

### New behavior

Files in `context/` are named by topic. No date prefixes. Git history serves as the changelog.

**Naming convention:**

- Kebab-case descriptive names: `auth-research.md`, `payment-integration.md`
- Handoffs use a `handoff-` prefix: `handoff.md`, `handoff-auth-module.md`
- The command infers the topic slug from the `$ARGUMENTS` provided

**Examples:**

```
/write auth research              → context/auth-research.md
/write payment integration notes  → context/payment-integration-notes.md
/compress                         → context/handoff.md
/compress auth module             → context/handoff-auth-module.md
```

**Directory example:**

```
project-root/
  context/
    auth-research.md
    payment-integration.md
    handoff.md
    handoff-api-migration.md
  src/
  ...
```

### PRD sections affected

- **Section 2 (Storage)** — Remove date-prefix convention, replace with topic-based naming.
- **Section 3 (/write)** — File naming changes, add merge behavior.
- **Section 6 (/compress)** — Handoff files follow the same update-in-place model.

---

## 2. Intelligent Merge on `/write`

### When a topic file does not exist

`/write` creates it as the current PRD describes — structured markdown with summary, sections, key details, and a `## References` manifest at the bottom.

### When a topic file already exists

`/write` performs a three-step merge:

1. **Read** the existing file from `context/`.
2. **Compare** existing content against new information from the current context window, classifying each piece as:
   - **Still valid** — information that hasn't changed or been contradicted
   - **Updated** — information that has a newer, more accurate version
   - **Contradicted** — information now known to be wrong
   - **New** — information not present in the existing file
3. **Produce** a merged document that preserves valid content, replaces updated/contradicted content, and integrates new content in the appropriate sections.

### Merge principles

- **Merge is not append.** The file should not grow unboundedly. If new research supersedes old research, the old content is replaced. Git preserves history.
- **The `## References` manifest is rebuilt from scratch** on every write — it reflects the current state of the file, not accumulated history.
- **Preservation rules still apply.** File paths, error codes, decisions with rationale, and function names are never silently dropped during merge. Content is only removed when newer information explicitly supersedes it.

### `/compress` merge behavior

`/compress` follows the same merge logic when updating an existing handoff file:

- The "Completed" section grows as work progresses
- "In Progress" and "Next Steps" are replaced with current state
- Stale decisions are updated with current rationale
- The `## References` section is rebuilt

---

## 3. Staleness Detection on `/select`

### When it runs

Every time `/select` loads one or more context files — both in bare mode (validating all files in `context/`) and in targeted mode (validating specific files being loaded).

### Step 1 — Build the reference set

- Parse the `## References` manifest at the bottom of the file (explicit tracking)
- Scan the file body for additional file paths and function/class/module names (implicit scanning)
- Deduplicate into a single set of referenced code paths

### Step 2 — Check git

- Get the context file's last modified time (from filesystem or `git log` for the context file itself)
- For each referenced path, check `git log --since=<mtime> -- <path>`
- Check whether referenced paths still exist on disk

### Step 3 — Classify

| Status | Meaning | Criteria |
|--------|---------|----------|
| **Fresh** | Safe to load | No referenced code has changed since the file was last written |
| **Stale** | Load with caution | Referenced code has changed — report lists which files changed and when |
| **Broken** | Do not trust | Referenced files or functions no longer exist |

### Step 4 — Report and recommend

**In bare `/select`** (codebase primer mode), the staleness report is part of the "Available Context" section:

```markdown
### Available Context
- auth-research.md          fresh
- payment-integration.md    stale (src/payments/webhook.ts changed 2 days ago)
- handoff.md                broken (src/old-module.ts no longer exists)
```

**In targeted `/select topic`**, the report appears before content is loaded:

- **Stale:** "This file references code that has changed. Consider `/write <topic>` to refresh it, or `/isolate` to re-research."
- **Broken:** "This file references code that no longer exists. It should be refreshed with `/write` or deleted."

### User decides

`/select` never silently loads a stale file, and never refuses to load one. It reports and recommends, then the user chooses how to proceed.

---

## 4. Updated File Output Format

Both `/write` and `/compress` outputs gain a `## References` section as the final section of every file.

### `/write` output template

```markdown
# <Title inferred from arguments>

> Last updated by /write on YYYY-MM-DD HH:MM
> Source: <what session context this was extracted from>

## Summary
<2-3 sentence overview>

## <Section 1>
<Structured content>

## <Section N>
...

## Key Details
- **Decisions**: <decisions with rationale>
- **Open questions**: <anything unresolved>

## References
- `src/auth/middleware.ts` — auth middleware, token validation logic
- `src/auth/session.ts:42` — session expiry configuration
- `src/models/user.ts` — User model, referenced for role fields
```

### Changes from current PRD format

- `> Written by` becomes `> Last updated by` — reflects that files are living documents
- File paths move from `## Key Details` into a dedicated `## References` section at the bottom
- Each reference includes a brief annotation of why it's referenced
- `## References` is always the last section in the file

### `/compress` output template

The existing handoff template from the PRD gains:

- A `## References` section at the bottom
- Header says `> Last updated by /compress on ...`
- Same rebuild-from-scratch behavior on every update

---

## 5. `/select` Dual-Mode Behavior (Unchanged + Enhanced)

### Bare `/select` (codebase primer)

Behavior unchanged from the current PRD. The only addition: the "Available Context" listing now includes freshness indicators from the staleness check.

```markdown
## Project Overview

### Structure
<Directory tree with annotations>

### Tech Stack
<Languages, frameworks, key dependencies>

### Conventions
<Coding patterns, naming conventions, architecture style>

### Recent Activity
<What's been worked on recently, based on git>

### Available Context
- auth-research.md          fresh
- payment-integration.md    stale (src/payments/webhook.ts changed 2 days ago)
- handoff.md                fresh
```

### Targeted `/select topic`

Behavior unchanged from current PRD — targeted deep exploration. The only addition: staleness validation runs before loading any matching context files, with the report and recommendation described in Section 3.

---

## Summary of PRD Changes Required

| PRD Section | Change |
|-------------|--------|
| Section 2 (Storage) | Remove date-prefix naming convention. Replace with topic-based kebab-case naming. Remove "Date prefix in YYYY-MM-DD format" rule. |
| Section 3 (/write) | Add merge behavior when topic file exists. Update output format with `## References` section. Change `> Written by` to `> Last updated by`. Move file paths from Key Details to References. |
| Section 5 (/select) | Add staleness detection and reporting to both modes. Add freshness indicators to "Available Context" listing. |
| Section 6 (/compress) | Change file naming to `handoff.md` / `handoff-<scope>.md`. Add merge behavior for existing handoffs. Add `## References` section to output format. |
