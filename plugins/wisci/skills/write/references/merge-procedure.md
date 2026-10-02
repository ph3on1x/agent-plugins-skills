# Merge Procedure for /write

When a matching topic file already exists in `.wisci/context/`, perform a section-level merge with staleness pruning.

## Prerequisites

Classify the existing file first: run `python3 <path-to-wisci.py> status .wisci/context/<file>.md` (the bundled script — `scripts/wisci.py` relative to the write skill's directory). It returns `status` (fresh/stale/broken), `changed`, and `missing` reference lists. Do not re-derive staleness with your own git commands.

**Fully broken** (every reference in `missing`): refuse to merge. Report: "<filename> references code that no longer exists. Delete it or start fresh with /write."

## Merge Steps

1. **Read the existing file.**

2. **Prune stale content** using the script's classification:
   - References in `missing` (deleted from disk): remove each section that depends on them. A section "depends on" a reference if that path appears in the section body.
   - References in `changed`: keep the dependent section but prepend to its body:
     ```
     > **Stale:** referenced files have changed since this section was written.
     ```
     New content from the current context takes precedence over these sections during merge.

3. **Match sections by `##` heading** (case-insensitive, trimmed) between the pruned existing file and the new content.

4. **Replace matched sections** with the new content. Git preserves the old version.

5. **Append new sections** (no match in existing file) before `## References`.

6. **Preserve unmatched existing sections** that were not pruned in step 2.

7. **Rebuild `## References` from scratch**: scan the merged document for file paths, collect with one-line annotations. Always the last section.

8. **Update the metadata header** (`> Last updated by /write on <timestamp>` / `> Source: ...`).

## Principles

- Merge operates at the section level — do not diff individual facts inside a section.
- Stale content about deleted code is pruned, not preserved. Git history is the archive.
- When in doubt, keep both versions and flag with `<!-- REVIEW: possible overlap -->`.
