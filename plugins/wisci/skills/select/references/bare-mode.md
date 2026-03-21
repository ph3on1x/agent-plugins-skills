# Bare Mode — Codebase Primer

When `/select` is invoked with no arguments, produce a comprehensive codebase overview and list all available scratchpad context files with staleness status.

## Procedure

### Step 1: Analyze project structure

Use Glob to scan the project root and identify the directory layout. Focus on top-level directories and key structural patterns. Produce an annotated directory tree (depth 2-3 levels, omit `node_modules/`, `.git/`, and other dependency/build directories).

### Step 2: Identify tech stack

Use Read to check configuration files for language, framework, and dependency information:
- `package.json` — Node.js dependencies and scripts
- `tsconfig.json` / `jsconfig.json` — TypeScript/JavaScript config
- `pyproject.toml` / `requirements.txt` — Python dependencies
- `Cargo.toml` — Rust dependencies
- `go.mod` — Go dependencies
- Other language-specific config files found in Step 1

Report the primary language, framework, and key dependencies.

### Step 3: Check project documentation

Use Glob to look for documentation files:
- `README.md` or `README.*`
- `CLAUDE.md` or `.claude/CLAUDE.md`
- `AGENTS.md` — Codex CLI / cross-platform instructions
- `GEMINI.md` — Gemini CLI instructions
- `.cursor/rules/` — Cursor project rules
- `docs/` directory contents
- `CONTRIBUTING.md`, `ARCHITECTURE.md`

Read and summarize key project documentation that would help understand the codebase.

### Step 4: Identify conventions

From the files read in Steps 2-3, extract:
- Coding patterns and style (functional vs OOP, naming conventions)
- Architecture style (monolith, microservices, monorepo)
- Testing patterns (framework, file organization)
- Build and deployment setup

### Step 5: Scan scratchpad

Use Glob to list all files in `scratchpad/`. If the directory does not exist, report "No scratchpad/ directory found — no WISCI context files available."

### Step 6: Run staleness detection

For each file in `scratchpad/`, run the staleness detection procedure from `${CLAUDE_SKILL_DIR}/references/staleness-detection.md`. Classify each file as fresh, stale, or broken.

### Step 7: Present overview

Assemble findings into the bare mode output format:

```markdown
## Project Overview

### Structure
<Annotated directory tree from Step 1>

### Tech Stack
<Languages, frameworks, key dependencies from Step 2>

### Conventions
<Patterns and style from Step 4>

### Available Context
<List each scratchpad file with staleness status>
```

For the Available Context listing:
- **Fresh files:** `filename.md          fresh`
- **Stale files:** `filename.md          stale (N sections affected; <path> changed <when>)`
- **Broken files:** `filename.md          broken (<path> no longer exists) — not loaded`

If no scratchpad files exist, report: "No context files in scratchpad/. Use /write to create them."
