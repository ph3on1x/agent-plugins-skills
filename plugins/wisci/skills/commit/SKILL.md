---
name: commit
description: This skill should be used when the user asks to "commit", "save changes", "commit with context", or needs to create a git commit with AI context tracking. Creates conventional commits enriched with a Context section that logs AI-layer changes, turning git history into long-term memory.
argument-hint: "[commit message] (optional — omit for auto-generated message)"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(git *)
---

# /commit — Context-Enriched Committer

Create git commits that track AI context evolution alongside application changes. When AI-layer files are part of the commit, a `Context:` section is appended to the commit body — turning `git log` into long-term, queryable memory for future sessions and agents.

## Execution Flow

1. **Review changes.** Run these git commands to understand the current state:
   - `git status` — staged, unstaged, and untracked files
   - `git --no-pager diff HEAD` — full diff of all changes relative to HEAD
   - `git --no-pager diff --stat HEAD` — file-level summary with line counts
   - `git log --oneline -5` — recent commits for style reference

2. **Check for committable changes.** If there are no staged, unstaged, or untracked changes, report "Nothing to commit — working tree clean." and stop.

3. **Analyze and classify changes.** Review every changed and untracked file:
   - **Application code** — stage normally
   - **AI context files** — stage normally; flag for the Context section (see AI Context Paths below)
   - **Sensitive files** (`.env`, `*.key`, `*.pem`, `credentials.*`, `*secret*`) — **do not stage**. Warn the user.
   - **Unrelated files** — if changes span multiple unrelated concerns and no `$ARGUMENTS` hint clarifies intent, ask the user whether to include them or create separate commits

4. **Stage files.** Use `git add <file>` for each file individually. Never use `git add -A` or `git add .`.

5. **Detect AI context changes.** Run `git --no-pager diff --cached --name-only` and check each staged path against the AI Context Paths. Record which AI-layer files are staged.

6. **Draft commit message.**
   - If `$ARGUMENTS` is provided: use it as the commit message. Ensure it has a conventional commit prefix (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`). If the prefix is missing, infer the appropriate one from the nature of the changes and prepend it.
   - If `$ARGUMENTS` is empty: auto-generate a conventional commit message from the staged diff. Focus on the "why" — the purpose of the changes — not the "what."

7. **Build the Context section.** If AI context files were detected in Step 5, append a `Context:` section to the commit body. Each line follows the format:
   ```
   - <action> <path> — <what changed>
   ```
   Where action is one of: `create`, `update`, `remove`, `rename`.
   If no AI context files are staged, omit the `Context:` section entirely.

8. **Create the commit.** Use a heredoc to pass the full message:
   ```bash
   git commit -m "$(cat <<'EOF'
   <prefix>: <description>

   <optional body>

   Context:
   - <action> <path> — <annotation>
   EOF
   )"
   ```
   Do not use `--no-verify`.

9. **Verify and report.** Run `git status` to confirm the commit succeeded. Report:
   - The commit hash (short form)
   - The commit message subject line
   - Whether a `Context:` section was included, and how many AI-layer files were tracked

## AI Context Paths

These paths are AI-layer files. Changes to them are logged in the `Context:` section:

- `scratchpad/**` — WISCI context files
- `CLAUDE.md` — project instructions (root)
- `.claude/CLAUDE.md` — project instructions (.claude dir)
- `.claude/rules/**` — Claude rule files
- `.claude/commands/**` — Claude custom commands
- `.claude/settings.json` — Claude settings
- `.claude/plugins/**` — Claude plugin configurations
- `wisci-plugin/**` — WISCI skill definitions and plugin config
- `.cursorrules` — Cursor AI rules
- `.github/copilot-instructions.md` — Copilot instructions
- `AGENTS.md` — Codex agent instructions
- `codex.md` — Codex instructions

A staged file matches if its path starts with any of the directory prefixes above or exactly matches a filename entry.

## Commit Message Format

### Subject line
```
<prefix>: <concise description focused on why, not what>
```

Conventional prefixes: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

### Body (optional)
1-3 sentences expanding on the subject when the change is non-trivial.

### Context section (conditional)
Appended after the body when AI-layer files are staged:

```
Context:
- create scratchpad/auth-research.md — research results from auth exploration
- update .claude/rules/auth.md — added token expiry handling rule
- update CLAUDE.md — added testing conventions
```

### Examples

**Application + context changes:**
```
feat: add token refresh to auth middleware

Automatic refresh when access token expires. One retry before 401.

Context:
- update scratchpad/auth-research.md — added token refresh decision and rationale
```

**Context-only changes:**
```
docs: persist Stripe integration research to scratchpad

Context:
- create scratchpad/stripe-integration.md — /isolate research results
- update scratchpad/handoff.md — added Stripe to in-progress work
```

**No context changes:**
```
fix: prevent race condition in payment webhook handler
```

## Key Constraints

- **Never use `--no-verify`.** If a pre-commit hook fails, report the error and stop.
- **Never use `git add -A` or `git add .`.** Stage files individually by name.
- **Never stage sensitive files.** Warn the user if `.env`, credentials, or keys appear.
- **Context section is conditional.** Only include when AI-layer files are actually staged.
- **One logical commit.** If changes span unrelated concerns, ask the user before bundling.
- **Respect user intent.** If `$ARGUMENTS` provides a message, use it — only add prefix if missing and append `Context:` if applicable.
- **All git diffs use `--no-pager`.** No interactive pager mode.
