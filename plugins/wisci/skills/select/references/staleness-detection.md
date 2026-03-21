<!-- This file is duplicated in skills/write/references/ and skills/select/references/. Keep both copies in sync. -->

# Staleness Detection Procedure

Validate a context file's references against the current state of the codebase. This prevents context poisoning — the failure mode where outdated information leads to incorrect assumptions.

## Step 1: Build the Reference Set

Collect all file paths referenced in the context file:

**Explicit references:** Parse the `## References` manifest at the bottom of the file. Extract each file path (the backtick-wrapped path before the `—` annotation).

**Implicit references:** Scan the file body for additional file paths matching these criteria:
- Contains `/` (path separator) AND a file extension (`.ts`, `.js`, `.py`, etc.)
- Looks like a project-relative path (e.g., `src/auth/middleware.ts`, `src/models/user.ts:42`)
- Strip line numbers (`:42`) before deduplication

**Do NOT match:**
- Bare filenames without `/` (e.g., `middleware.ts`)
- Language or technology names (e.g., `TypeScript`, `React.useState`)
- Dependency paths (e.g., `node_modules/express/index.js`)
- URLs or external references

Deduplicate into a single set of referenced file paths. When in doubt, only trust the explicit `## References` manifest.

## Step 2: Check Git

**Get canonical timestamp:** Run this command to find when the context file was last committed:
```bash
git log -1 --format=%aI -- <context-file-path>
```
This is the authoritative "last updated" time. If the file is not git-tracked (command returns empty), fall back to filesystem mtime and prepend a warning: "This context file is not tracked by git — staleness check may be unreliable."

**Check each reference:** For each file path in the reference set:

1. Check if the file still exists on disk
2. If it exists, check for changes since the context file was last committed:
   ```bash
   git log --since=<canonical-timestamp> -- <referenced-path>
   ```
   If this returns any commits, the referenced file has changed.

## Step 3: Classify

| Status | Criteria |
|--------|----------|
| **Fresh** | All referenced files exist and none have changed since the context file was last committed |
| **Stale** | One or more referenced files have been modified since the context file was last committed |
| **Broken** | One or more referenced files no longer exist on disk |

A file can be both stale and broken if some references were modified and others were deleted.

## Step 4: Report

For each reference, record:
- The file path
- Whether it still exists
- Whether it has changed (and if so, when the most recent change was)

Return this classification to the calling procedure (merge procedure or select loading) for action.
