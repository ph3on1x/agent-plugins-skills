---
name: isolate
description: Delegates research and exploration to subagents with isolated context windows, returns one synthesized report, and saves durable findings to .wisci/context/. Use whenever the user asks to research, investigate, explore, dig into, deep-dive or compare something — a repo's structure, a codebase area or flow end to end, how something works across the codebase, external docs or best practices, libraries, tools or approaches — without cluttering the main context. Not for fixing a specific bug or running tests in isolation.
argument-hint: "task ['deep'] ['save'|'nosave']"
allowed-tools: Read Glob Grep Agent Skill Bash(git *) Bash(uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py" *)
compatibility: Requires git and uv (uv provides Python 3.11+); uses the bundled scripts/wisci.py. Without a subagent tool, research sequentially.
---

# /isolate — Research in Subagents

Research runs in subagent context windows, so only the synthesis enters this one. Durable findings are saved so no later session repeats the work.

Script: `uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py"` (`<wisci>` below). Run it exactly as written, as a command of its own, with the absolute path and quotes and no shell variables: the permission rule matches only that literal command. Edit store files with Write or Edit, never with shell redirects. Hosts without command injection: run it from the project root with `<this skill's directory>/scripts/wisci.py` as the path.

Store state:
!`uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py" scan`

## Steps

1. **Check the store.** If a `context/…` note covers the topic, load it with `<wisci> load <path>`.
   - Research only what it leaves open, or answer from it directly.
   - Before relying on a section marked `check`, re-read the file its marker names.
2. **Decide the split** without asking for approval; the user sees the results.
   - If a handful of tool calls answer it, answer directly. No subagent.
   - **Codebase questions:** use `Explore` subagents (read-only).
   - **External questions** (docs, best practices, comparisons): use `general-purpose` subagents with web search.
   - **How many agents:**
     - 1 for one focused area
     - 2–3 for natural splits
     - up to 5 only when `$ARGUMENTS` says `deep` or `thorough`

     Give each agent a distinct lens (code structure, git history, docs/web), not copies of one search.
3. **Brief each agent** with the question, the focus areas and the return format. The format is structured markdown of about 1–2k tokens, with exact paths, line numbers, function names and error messages. Launch all the agents in one message.
4. **Collect.** Retry an agent that returned nothing once. If it fails again, name the coverage gap in the synthesis.
5. **Synthesize** using the format below: findings per lens, agreements and contradictions, conclusions, remaining gaps.
6. **Persist.**
   - **Durable findings** (architecture maps, integration research, comparisons, external findings): invoke the Skill tool with the write skill, `wisci:write` when installed as the plugin, and the topic. On hosts without skill invocation, follow the write skill's steps.
   - **Corrections:** if the code contradicts a stored note, flagged or not, the fix is durable even after a quick lookup: invoke write with that note's path so it merges the fix.
   - **Ephemeral findings** (a quick lookup that found no stored note wrong): keep them inline only.
   - `save` or `nosave` in `$ARGUMENTS` overrides this judgment. With `nosave`, report corrections and suggest `/write <note path>`.

## Output

```markdown
## /isolate Results: <task>

### <lens>
<findings with paths and specifics>

### Synthesis
<combined insights, contradictions, recommendations, gaps>
```

End with `Persisted: <path>`, or `Not persisted — ephemeral` when no stored note was wrong.
