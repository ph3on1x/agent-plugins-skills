---
name: commit
description: Conventional git commit with an AI-Context trailer per changed AI-layer file (.wisci/, CLAUDE.md, AGENTS.md, skills, rules). Optional leading "push".
argument-hint: "[push] [message]"
allowed-tools: Read Glob Grep Bash(git status *) Bash(git --no-pager diff *) Bash(git --no-pager log *) Bash(git log *) Bash(git ls-files *) Bash(git ls-tree *) Bash(git add *) Bash(git commit *) Bash(git push *)
disable-model-invocation: true
compatibility: Requires git 2.32+ (git commit --trailer).
---

# /commit — Commit with AI-Context Trailers

Commit the current changes with a conventional message. Add one `AI-Context:` git trailer per AI-layer file in the commit, so `git log` records how the project's agent context changed:

`git log --format='%h %(trailers:key=AI-Context,valueonly,separator=%x3B )'`

## Current state

!`git status --porcelain=v1`

Staged (name-status):
!`git --no-pager diff --cached --name-status`

!`git --no-pager diff --stat HEAD`

Recent commits:
!`git log --oneline -5`

Plugin manifests:
!`git ls-files -co --exclude-standard -- ':(glob)**/.claude-plugin/plugin.json'`

## Steps

1. **Arguments.** A leading standalone `push` (any case) means push after committing; the rest is the message (may be empty). Run each git command in its own Bash call: chained or piped commands need extra permission.
2. Nothing staged, unstaged or untracked → report "Nothing to commit — working tree clean." and stop.
3. **Sensitive files** (patterns below). Already staged → stop, list them, and tell the user to unstage (`git restore --staged <file>`); leave their index as is. Unstaged or untracked → don't stage them; warn.
4. **Classify** the rest as application code or AI-layer (below). Unrelated concerns with no hint in `$ARGUMENTS` → ask before bundling.
5. **Stage by name** with `git add -- <file>…`; `-A` or `.` would sweep in unreviewed files.
6. **Message.** Given one → use it, prepending a conventional prefix (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`) if missing. Otherwise write it from the staged diff, saying why rather than what. If your instructions add an attribution trailer (e.g. `Co-Authored-By`), end the message with it as its own last paragraph; attribution disabled → add none.
7. **Commit**, one `--trailer` per AI-layer file; action from the name-status letter (A create, M update, D remove, R rename):

   ```bash
   git commit -m "$(cat <<'EOF'
   <type>: <description>

   <optional body>
   EOF
   )" --trailer "AI-Context: update .wisci/context/auth-research.md — token refresh decision"
   ```

   No AI-layer files → no `--trailer`. git merges the `--trailer` lines into the attribution paragraph from step 6, if there is one. Never `--no-verify`: hooks are the project's gate, so on failure report the output and stop.
8. **Verify** with `git log -1 --format='%h %s%n%(trailers:key=AI-Context,valueonly,separator=%x0A)'`; report hash, subject, trailer count.
9. **Push** if requested: `git push` (`git push -u origin <branch>` without upstream). Never force; report failures.

## AI-layer files

- Basenames at any depth: `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `GEMINI.md`.
- Prefixes: `.wisci/`, `.claude/` (not `settings.local.json`), `.mcp.json`, `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, `.github/{instructions,prompts,agents,skills}/`, `.vscode/mcp.json`, `.agents/`, `.codex/`, `.gemini/`, `.devin/rules/`, `.windsurf/rules/`, `.kiro/steering/`, `.clinerules`, `.cline/rules/`, `.junie/`.
- Plugin roots (the dirs holding the manifests listed above): their `.claude-plugin/`, `skills/`, `hooks/`, `agents/`, `commands/` subtrees. Scripts and other code are application code.
- `CLAUDE.local.md` is personal: warn, don't stage.

## Sensitive files

`.env`, `.env.*` (not `.env.example`/`.env.sample`), `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `id_rsa*`, `id_ed25519*`, `credentials.*`, `.netrc`, `.git-credentials`, `.pypirc`, `.npmrc`, `*.tfstate*`, `*.tfvars`, `secrets.*`, `*secret*.{json,yml,yaml,txt}`. Name patterns are a convenience; content scanning (a gitleaks pre-commit hook, push protection) is the real control.

<example>
feat: add token refresh to auth middleware

Refresh once on expiry before returning 401.

AI-Context: update .wisci/context/auth-research.md — token refresh decision and rationale
AI-Context: create .wisci/handoff/payments.md — Stripe work stream
</example>
