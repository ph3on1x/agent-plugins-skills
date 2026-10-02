---
description: Check whether the local Antigravity CLI (agy) is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(brew:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" setup --json $ARGUMENTS
```

If the result says agy is not installed and `brew` is available (macOS):
- Use `AskUserQuestion` exactly once to ask whether Claude should install agy now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install agy (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
brew install --cask antigravity-cli
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mts" setup --json $ARGUMENTS
```

If agy is already installed or `brew` is unavailable:
- Do not ask about installation. Show the install command from the setup output instead.

Output rules:
- Present the final setup result to the user as a short readable report (status, agy version, auth, review gate, warnings).
- If agy is installed but not signed in, tell the user to run `!agy` once to complete the browser sign-in, or to export `GEMINI_API_KEY`.
- If the output lists a conflicting plugin that also uses the `/agy:` namespace, show that warning prominently.
