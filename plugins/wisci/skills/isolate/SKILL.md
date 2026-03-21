---
name: isolate
description: This skill should be used when the user asks to "research", "explore codebase", "investigate", "compare approaches", or needs deep exploration without polluting the main context. Delegates research to subagents with isolated context windows.
argument-hint: task description for subagent research
allowed-tools:
  - Read
  - Glob
  - Grep
  - Agent
  - Bash(git *)
---

# /isolate — Subagent Research Delegator

Delegate research and exploration to subagents operating in isolated context windows. The main context stays clean while subagents do the heavy lifting — reading files, searching code, exploring documentation, and synthesizing findings.

## Execution Flow

1. **Parse task.** Read `$ARGUMENTS` to understand the research task and its scope.

2. **Plan decomposition.** Autonomously decide how to split the work across subagents. Do not present the plan for approval — execute directly. Consider:
   - **Decomposability:** Can the research split into independent subtasks? If the task is tightly coupled, use 1 agent.
   - **Scope:** Each subagent should have a focused, achievable goal. Avoid giving one agent too broad a mandate.
   - **Count:** Use 1-3 subagents based on task scope:
     - **1 agent** — focused, single-area research (e.g., "how does auth work")
     - **2 agents** — natural split into two domains (e.g., "compare library A vs B")
     - **3 agents** — broad investigation across multiple areas (e.g., "understand the full payment flow: handler, models, and external API")

3. **Spawn subagents.** Use the Agent tool to launch subagents. When spawning multiple agents, launch them all in a single message for parallel execution. Each agent gets:
   - A `description` (3-5 words summarizing the subtask)
   - A detailed `prompt` with:
     - The specific investigation task
     - What files, patterns, or areas to explore
     - The output format to follow (structured markdown with headings)
     - Instruction to be thorough but focused
   - `subagent_type: "Explore"` for read-only research tasks, or omit for tasks requiring broader tool access

4. **Collect results.** Wait for all subagents to complete and return their findings.

5. **Synthesize.** Combine the subagent results into a coherent summary:
   - Highlight key findings from each agent
   - Identify patterns, contradictions, or connections across results
   - Form actionable recommendations or conclusions
   - Note any gaps where further investigation may be needed

6. **Present inline.** Output the synthesized results directly in the conversation using the output format below. Do not write results to a file.

## Output Format

Present results inline in the conversation:

```markdown
## /isolate Results: <task summary>

### Agent 1: <subtask name>
<Structured findings with file paths, code references, and specifics>

### Agent 2: <subtask name>
<Structured findings>

### Agent N: <subtask name>
<Structured findings>

### Synthesis
<Combined insights, patterns across agents, contradictions found, and recommendations>
```

## Subagent Prompt Template

When crafting prompts for each subagent, follow this structure:

```
Investigate: <specific subtask description>

Focus areas:
- <area 1 to explore>
- <area 2 to explore>

Report your findings as structured markdown with:
- File paths and line numbers for all referenced code
- Key function/class names and their purposes
- How components connect or interact
- Any issues, edge cases, or concerns discovered
```

## Key Constraints

- **Results are inline only.** Findings appear in the main context window, not written to a file. If the user wants to persist results, they follow up with `/write`.
- **No approval step.** The decomposition plan executes immediately. The user sees results, not the plan.
- **Parallel execution.** When using 2-3 agents, spawn them all in a single tool-use message so they run concurrently.
- **Preserve specifics.** Subagent prompts must request exact file paths, line numbers, function names, and error messages — not vague summaries.
- **This skill runs inline** (not as a forked subagent). It must be able to spawn multiple child agents from within the main context.
