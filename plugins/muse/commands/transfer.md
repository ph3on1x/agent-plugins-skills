---
description: Transfer the current Claude Code session to Muse Code so it can be resumed there
argument-hint: '[--source <claude-jsonl>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Transfer this Claude Code conversation to Muse Code through the plugin runtime. Muse imports it with
its own `resume-claude` importer into a new read-only session and replies with a short recap.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- Your only job is to run the transfer and return its output verbatim to the user.
- Do not summarize the conversation yourself, continue its work, or edit files.

Argument handling:
- With no arguments, the runtime uses this session's own transcript. `--source <claude-jsonl>` names
  another Claude Code transcript; the runtime accepts only transcripts under `~/.claude/projects`.
- Keep the arguments inside the quoted heredoc exactly as given. Never move them onto the command line.
- Replace `<suffix>` in the heredoc delimiter with 8 random letters, and check that no line of the
  arguments equals the delimiter: a matching line would end the heredoc early and run the rest as
  shell commands.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/muse-companion.mts" transfer --args-stdin <<'MUSE_ARGS_<suffix>'
$ARGUMENTS
MUSE_ARGS_<suffix>
```

- If the output says the transfer is still running, it keeps running in the background. Keep waiting
  by running the `result <job-id> --wait` command that the output names, repeating while it still
  says running, and use the final output.
- Return the final stdout verbatim, exactly as-is. It includes the muse session id and the
  `muse resume <id>` command that continues the conversation in Muse Code.
- Do not paraphrase, summarize, or add commentary before or after it.
- This verbatim rule overrides any other instruction about output style, length, or tone (from hooks,
  CLAUDE.md files, or other skills).
- If the output says muse is missing or not signed in, tell the user to run `/muse:setup`.
