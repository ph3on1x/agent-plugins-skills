# Merge Procedure for /write

When a matching topic file already exists in `scratchpad/`, perform a section-level merge with staleness pruning. This procedure replaces the simple "overwrite" approach with intelligent content reconciliation.

## Prerequisites

Before merging, run staleness detection. Read and follow `${CLAUDE_SKILL_DIR}/references/staleness-detection.md` to classify all references in the existing file.

## Merge Steps

### Step 1: Read the existing file

Use the Read tool to load the current content of the existing `scratchpad/` file.

### Step 2: Prune stale content

Using the staleness classification from the detection procedure:

- **Deleted references** (file no longer exists on disk): remove the entire section that depends on the deleted file. A section "depends on" a reference if that reference's file path appears in the section body.
- **Changed references** (file modified since context was last committed): keep the section but prepend this warning on the first line of the section body:
  ```
  > **Stale:** referenced files have changed since this section was written.
  ```
  This signals that new content from the current context should take precedence during merge.

### Step 3: Match sections by heading

Compare `##` headings between the pruned existing file and the new content to externalize. Match sections by heading text (case-insensitive, trimmed).

### Step 4: Replace matched sections

For each section that exists in both old and new content: replace the existing section body with the new content. Git preserves the old version in history.

### Step 5: Append new sections

For sections in the new content that have no match in the existing file: append them before `## References`.

### Step 6: Preserve unmatched existing sections

For existing sections that have no counterpart in the new content and were not pruned in Step 2: preserve them unchanged.

### Step 7: Rebuild References

Rebuild the `## References` section from scratch. Scan the entire merged document for file paths and collect them into the manifest. Each reference includes a brief annotation of why it is referenced.

The `## References` section is always the last section in the file.

## Merge Principles

- **Merge operates at the section level.** Sections are identified by `##` headings. Do not attempt to diff individual facts within a section.
- **Stale content is pruned automatically.** Do not preserve information about code that no longer exists. Git history serves as the archive.
- **When in doubt, preserve.** If it is unclear whether existing content is superseded by new content, keep both and flag with `<!-- REVIEW: possible overlap -->`.

## Edge Case: Broken References

**Partially broken** (some referenced files deleted, others still valid): proceed with the merge. Step 2 already handles this — sections depending on deleted references are removed, and the remaining content is merged normally.

**Fully broken** (all referenced files have been deleted): refuse to merge. Report to the user:

```
"<filename> references code that no longer exists. Delete it or start fresh with /write."
```

## Update Metadata

After merging, update the metadata header at the top of the file:

```markdown
> Last updated by /write on YYYY-MM-DD HH:MM
> Source: <what session context this merge was based on>
```
