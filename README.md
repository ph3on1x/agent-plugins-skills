# Agent Skills & Plugins for AI Coding Agents

[![Agent Skills](https://img.shields.io/badge/Agent_Skills-standard-2ea44f)](https://agentskills.io)
[![Claude Code](https://img.shields.io/badge/Claude_Code-marketplace-d97757)](#claude-code)
[![npx skills](https://img.shields.io/badge/install-npx_skills-2088ff)](#codex-cursor-gemini-cli-antigravity-and-other-agents)

Agent skills and plugins for AI coding agents: Claude Code, Codex, Cursor, Gemini CLI, Antigravity
and every other agent that reads the [Agent Skills](https://agentskills.io) standard. This one
repository is both a Claude Code plugin marketplace and an `npx skills` catalog.

## What's inside

| Name | Type | What it does | Works in |
|---|---|---|---|
| [`wisci`](plugins/wisci) | plugin (5 skills) | Context engineering framework: Write, Isolate, Select, Compress. Staleness-tracked context store, per-stream handoffs, session hooks, context-enriched commits. | All agents (hooks: Claude Code) |
| [`agy`](plugins/agy) | plugin | Google Antigravity (Gemini) inside Claude Code: code reviews, adversarial design reviews, delegated rescue tasks with background jobs. | Claude Code |
| [`cmux`](skills/cmux) | skill | Orchestrate independent Claude Code sessions in the cmux terminal: split panes, agent monitoring, browser automation, notifications. | All agents (hooks: Claude Code) |
| [`adveloop`](skills/adveloop) | skill | GAN-inspired adversarial development loop: a Planner drives a Generator and an Evaluator in fresh cmux panes, with a hard pass/fail gate per deliverable. | All agents (needs cmux) |
| [`relamo`](skills/relamo) | skill | Recursive Language Model: explore a large codebase programmatically through a persistent Python REPL. | All agents |
| [`refine-prompt`](skills/refine-prompt) | skill | Interview-style prompt refiner: picks a prompt-engineering framework, fills the gaps by asking, then runs the structured prompt. | All agents |

Each item has its own README with usage and requirements.

## Install

### Claude Code

```text
/plugin marketplace add ph3on1x/agent-plugins-skills
/plugin install <name>@ph3on1x
```

`<name>` is the plugin name: `wisci`, `agy`, `cmux`, `adveloop`, `relamo` or
`refine-prompt`. Turn on auto-update for the `ph3on1x` marketplace under `/plugin` to get new versions.

### Codex, Cursor, Gemini CLI, Antigravity and other agents

Skills install with the [`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
npx skills add ph3on1x/agent-plugins-skills --list                # see what's available
npx skills add ph3on1x/agent-plugins-skills --skill relamo        # one skill
npx skills add ph3on1x/agent-plugins-skills --skill commit compress isolate select write   # wisci
npx skills add ph3on1x/agent-plugins-skills --skill relamo -a codex   # target one agent
```

Plugin-only features (hooks, slash commands, subagents) need Claude Code; the skills themselves work
everywhere.

## Repository layout

```
skills/<name>/     one skill, SKILL.md at the folder root (+ optional Claude extras: hooks, MCP)
plugins/<name>/    multi-skill or command/agent plugins for Claude Code
.claude-plugin/marketplace.json   the "ph3on1x" marketplace
```

Every item carries its own `.claude-plugin/plugin.json`, which is the only place its version lives.
Releases are tagged `<item>-vX.Y.Z`.

## Adding a skill or plugin

1. A standalone skill goes in `skills/<name>/`: `SKILL.md` with YAML frontmatter (kebab-case `name`
   matching the folder, a third-person `description` with the phrases a user would say), plus
   `.claude-plugin/plugin.json`. Long detail goes in `references/`.
2. A plugin goes in `plugins/<name>/`. Any skill that only makes sense inside the plugin gets
   `metadata: {internal: true}` in its frontmatter, which hides it from `npx skills`.
3. Add an entry (`name`, `source`, `description`) to `.claude-plugin/marketplace.json`; the `name`
   must equal the `plugin.json` name. Do not put `version` in the marketplace entry.
4. CI runs the plugin tests, `claude plugin validate` on every item, and checks the `npx skills`
   catalog against the expected list in `.github/workflows/ci.yml`; update that list.

## Security

Skills and plugins are executable instructions, and plugins can run hooks and scripts. Read an
item's files before installing it, and only install from sources you trust.

## Related

- [vibesight-skill](https://github.com/ph3on1x/vibesight-skill): run synthetic focus-group studies on
  vibesight.ai from your coding agent.

## License

[MIT](LICENSE) © 2026 Dennis Nasarov
