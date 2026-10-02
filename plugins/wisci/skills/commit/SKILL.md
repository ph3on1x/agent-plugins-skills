---
name: commit
description: Creates conventional git commits enriched with a Context section that logs AI-layer changes (.wisci/, CLAUDE.md, skills, rules), turning git history into queryable long-term memory. Use to commit changes, optionally pushing afterward.
argument-hint: "[push] [commit message] (both optional)"
allowed-tools: Read Glob Grep Bash(git *)
disable-model-invocation: true
---

# /commit — Context-Enriched Committer

Create git commits that track AI context evolution alongside application changes. When AI-layer files are part of the commit, a `Context:` section is appended to the commit body — making `git log` long-term, queryable memory for future sessions and agents.

## Current state

!`git status`

!`git --no-pager diff --stat HEAD`

Recent commits (style reference):
!`git log --oneline -5`

> If the blocks above show errors or unexpanded variables, run the commands yourself with Bash.

## Execution Flow

1. **Parse arguments.** If `$ARGUMENTS` starts with the standalone word `push` (case-insensitive): enable push-after-commit, use the remainder as the commit message (may be empty).

2. **Check for committable changes** in the state above. Nothing staged, unstaged, or untracked → report "Nothing to commit — working tree clean." and stop. Run `git --no-pager diff HEAD` for the full diff when the stat summary is not enough to write an accurate message.

3. **Classify every changed and untracked file:**
   - **Application code** — stage normally
   - **AI context files** (paths below) — stage normally; flag for the Context section
   - **Sensitive files** (`.env`, `*.key`, `*.pem`, `credentials.*`, `*secret*`) — **do not stage**; warn the user
   - **Unrelated concerns** — if changes span multiple unrelated concerns and `$ARGUMENTS` gives no hint, ask before bundling

4. **Stage files individually** (`git add <file>`). Never `git add -A` or `git add .`.

5. **Detect AI context changes.** Check `git --no-pager diff --cached --name-only` against the AI Context Paths below.

6. **Draft the message.**
   - `$ARGUMENTS` provided: use it; prepend a conventional prefix (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`) if missing, inferred from the changes.
   - Empty: auto-generate from the staged diff — focus on why, not what.

7. **Append the Context section** when AI-layer files are staged (omit entirely otherwise):
   ```
   Context:
   - <create|update|remove|rename> <path> — <what changed>
   ```

8. **Commit** via heredoc:
   ```bash
   git commit -m "$(cat <<'EOF'
   <prefix>: <description>

   <optional body>

   Context:
   - <action> <path> — <annotation>
   EOF
   )"
   ```

9. **Verify and report:** short hash, subject line, whether a Context section was included and how many AI-layer files it tracked.

10. **Push (if requested).** `git push`; no upstream → `git push -u origin <current-branch>`. On failure: report the error, never retry with `--force`.

## AI Context Paths

- `.wisci/**` — WISCI context store (context files, handoffs, primer, index)
- `CLAUDE.md`, `.claude/CLAUDE.md` — project instructions
- `.claude/rules/**`, `.claude/commands/**`, `.claude/skills/**`, `.claude/agents/**`, `.claude/hooks/**` — Claude project config
- `.claude/settings.json`, `.claude/plugins/**` — Claude settings and plugins
- `.mcp.json` — MCP server config
- `skills/**`, `.claude-plugin/**`, `hooks/**` — plugin/skill definitions (when the repo is itself a plugin)
- `.agents/**` — cross-client agent skills
- `.cursorrules`, `.cursor/rules/**` — Cursor rules
- `.github/copilot-instructions.md` — Copilot instructions
- `AGENTS.md`, `codex.md`, `.codex/**` — Codex instructions
- `GEMINI.md`, `.gemini/**` — Gemini CLI instructions and config

A staged file matches if its path starts with a directory prefix above or exactly matches a filename entry.

## Examples

**Application + context changes:**
```
feat: add token refresh to auth middleware

Automatic refresh when access token expires. One retry before 401.

Context:
- update .wisci/context/auth-research.md — added token refresh decision and rationale
```

**Context-only changes:**
```
docs: persist Stripe integration research

Context:
- create .wisci/context/stripe-integration.md — /isolate research results
- update .wisci/handoff/payments.md — Stripe added to in-progress work
```

## Key Constraints

- **Never `--no-verify`.** Pre-commit hook fails → report and stop.
- **Never force-push.**
- **Never `git add -A` / `git add .`.** Stage by name.
- **Never stage sensitive files.**
- **Context section is conditional** — only when AI-layer files are actually staged.
- **One logical commit** — ask before bundling unrelated concerns.
- **Respect user intent** — a provided message is used as-is apart from prefix and Context additions.
- All diffs with `--no-pager`.
