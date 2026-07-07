# Bare Mode — Codebase Primer + Store Inventory

Produce a codebase overview and an inventory of stored context. The scan output in SKILL.md already classified every store file — do not rescan.

## Step 1: Primer — cached or derived

Check the scan for `.wisci/primer.md`:

- **Fresh:** Read it and present its content as the primer. Done — skip Step 2.
- **Stale, broken, or absent:** derive a new primer (Step 2). The scan's `changed` list tells you what invalidated it (`<repo structure>` means the directory layout shifted).

## Step 2: Derive and cache the primer (only when not fresh)

1. **Structure:** scan the project root (Glob, depth 2-3, skip dependency/build dirs). Produce an annotated directory tree.
2. **Tech stack:** Read manifest files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, tsconfig, etc.). Report language, framework, key dependencies.
3. **Conventions:** Read project docs (`README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/`, `CONTRIBUTING.md`). Extract coding patterns, architecture style, testing setup.
4. **Cache it:** get the current structure hash (`python3 <wisci.py> structure-hash`) and write `.wisci/primer.md`:

```markdown
---
structure_hash: <hash>
updated: <YYYY-MM-DD>
---

# Project Primer

## Structure
<annotated tree>

## Tech Stack
<languages, frameworks, key dependencies>

## Conventions
<patterns, architecture, testing>

## References
- `package.json` — dependency and script source
- `README.md` — project documentation
<every file read while deriving this primer, one line each>
```

The `## References` manifest plus `structure_hash` is what lets future sessions load this primer instantly instead of re-exploring.

## Step 3: Handoff streams

From the scan's `streams` list:

- **0 streams:** skip this section.
- **1 stream:** Read the single leaf (apply staleness rules from SKILL.md) and present it.
- **2+ streams:** Read `.wisci/handoff.md` (the index) only. Present it — the user picks a stream with `/select <stream>` if they want one loaded. Load a leaf now only if exactly one stream is `active` and it is fresh.

## Step 4: Available context listing

From the scan's `files`, list every `.wisci/context/` file with status:

```
- auth-research.md          fresh
- payment-integration.md    stale (src/payments/webhook.ts changed)
- old-notes.md              broken (src/old-module.ts no longer exists) — not loaded
```

Do NOT load context files in bare mode — this is an inventory, not a bulk load. Surface any scan `warnings` (untracked files, gitignored store) to the user.

## Step 5: Present

```markdown
## Project Overview

### Structure / Tech Stack / Conventions
<primer content — cached or freshly derived>

### Handoff
<index, single leaf, or "none">

### Available Context
<listing from Step 4>
```

If `.wisci/` does not exist: derive the primer and write it to `.wisci/primer.md` to seed the store, then note: "No stored context yet. Use /write to create it."

End with the load report from SKILL.md's Output Contract.
