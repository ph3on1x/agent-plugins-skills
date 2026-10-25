---
description: With the plugin loaded, Claude Code's own subagents still run on Claude and answer (no difference from the no-plugin baseline).
model: haiku
runs: 2
max_turns: 4
allowed_tools: [Agent]
---

Use the Agent tool once, with subagent_type "general-purpose", to ask: what is 17 * 23? Then reply with just the number it gave.
