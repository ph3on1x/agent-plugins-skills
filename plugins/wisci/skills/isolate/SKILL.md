---
name: isolate
description: Delegates research and exploration to subagents with isolated context windows, then synthesizes findings inline and persists durable results to .wisci/context/ via the write skill. Use for investigating a codebase area, researching external docs or best practices, or comparing approaches without polluting the main context.
argument-hint: "task description ('deep' widens the sweep; 'save'/'nosave' force persistence)"
allowed-tools: Read Glob Grep Agent Bash(git *) Bash(python3 *)
compatibility: Requires git and python3 (bundled wisci.py script). Subagent spawning needs an Agent tool; without one, run the research sequentially inline.
---

# /isolate — Subagent Research Delegator

Research happens in subagent context windows; only synthesized findings enter the main context. Durable findings are then persisted to the store so no future session repeats the work.

## Store pre-flight

Existing store state:
!`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/wisci.py" scan`

> If the scan shows an error or unexpanded variable, run the bundled script manually: [scripts/wisci.py](scripts/wisci.py) relative to this skill's directory.

Before spawning anything, check the scan for a `.wisci/context/` file covering the research topic:
- **Fresh match:** load it. Narrow the research to what it does not answer — or skip research entirely and present the stored knowledge.
- **Stale match:** research anyway; in the synthesis, reconcile against the stored file ("what changed since this was written").
- **No match:** research from scratch.

## Execution Flow

1. **Parse task.** Read `$ARGUMENTS`. Note override words: `deep`/`thorough` (wider sweep), `save` (force persist), `nosave` (inline only).

2. **Plan decomposition.** Decide autonomously — no approval step. For each subtask pick the agent type:
   - **Codebase questions** → `subagent_type: "Explore"` (read-only)
   - **External questions** (library docs, best practices, comparisons) → `subagent_type: "general-purpose"` with instructions to use web search/fetch
   - Hybrid tasks mix both.

   Agent count: 1 for focused single-area research, 2-3 for natural splits, up to 5 only when `$ARGUMENTS` says `deep`/`thorough`. When multiple agents cover one topic, give each a **distinct lens** (code structure, git history, docs/web) rather than redundant copies of the same search.

3. **Spawn all agents in a single message** (parallel). Each prompt contains: the specific investigation task, focus areas, and the required output shape — structured markdown with exact file paths, line numbers, function names, and error messages. Vague summaries are not acceptable subagent output.

4. **Collect and handle failures.** An agent that returns nothing or dies: retry it once; still nothing → report the coverage gap explicitly in the synthesis. Never present partial coverage as complete.

5. **Synthesize inline** using the output format below: key findings per agent, patterns and contradictions across them, actionable conclusions, remaining gaps.

6. **Persist durable findings.** Judge what the research produced:
   - **Durable** (architecture maps, integration research, comparisons, external docs findings — anything a future session would otherwise re-discover): invoke the `write` skill with the topic so it lands in `.wisci/context/` with a References manifest. On platforms without skill invocation, follow the write skill's procedure directly. This skill contains no write logic of its own.
   - **Ephemeral** (a quick lookup answered in a paragraph): inline only — a trivial store entry is rot, not memory.
   - `save`/`nosave` in `$ARGUMENTS` overrides this judgment.

## Output Format

```markdown
## /isolate Results: <task summary>

### <Agent/lens 1 name>
<Structured findings with file paths and specifics>

### <Agent/lens N name>
...

### Synthesis
<Combined insights, contradictions, recommendations, gaps>
```

End with: `~N tokens entered context. Persisted: .wisci/context/<topic>.md` (or "not persisted — ephemeral").

## Key Constraints

- **Findings are presented inline first**, persistence second — the user reads results now either way.
- **No approval step** for decomposition; the user sees results, not plans.
- **Parallel execution**: multiple agents always spawn in one message.
- **Runs inline** (not forked) — it must spawn children and load results into the main window.
