---
description: Check whether the local Muse Code CLI (muse) is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-companion.mts" setup --json $ARGUMENTS
```

If the result says muse is not installed and this is macOS or Linux:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Muse Code now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Muse Code (Recommended)`
  - `Skip for now`
- If the user chooses install, run Meta's official installer. It is not pre-approved, so the user also confirms the command itself:

```bash
curl -fsSL https://dev.meta.ai/install.sh | sh
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-companion.mts" setup --json $ARGUMENTS
```

- If muse is still not found, the installer put it in `~/.local/bin`, which is not on `PATH`: tell the user to add it.

If muse is already installed, or this is Windows:
- Do not ask about installation. Show the install command from the setup output instead.

Output rules:
- Present the final setup result to the user as a short readable report (status, muse version, auth, quota, contributor mode, review gate, warnings).
- If muse is installed but not signed in, tell the user to run `!muse login` once to complete the browser sign-in. For an API key instead, they export `META_API_KEY` or store one with `muse auth set --api-key-stdin`.
- If contributor mode is on, say that Meta may use the content of muse sessions, including the code and transcripts this plugin sends, for product improvement, and that `/settings` in muse turns it off.
- If the output lists a conflicting plugin that also uses the `/muse:` namespace, show that warning prominently.
