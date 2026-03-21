# Targeted Mode — Deep Exploration

When `/select` is invoked with arguments, perform a targeted deep exploration of the specified topic. Load relevant context from multiple sources: project code, git history, documentation, and scratchpad files.

## Procedure

### Step 1: Parse topic

Read `$ARGUMENTS` to understand what context is needed. Identify:
- The domain or area of the codebase to explore
- Whether the user is asking for code, history, documentation, or a combination
- Any specific files or patterns mentioned

### Step 2: Plan exploration strategy

Determine which sources to query:
- **Project files:** Use Grep to search for relevant code patterns, function names, or keywords. Use Glob to find files by name or path patterns.
- **Git history:** Use Bash to run `git log --oneline -20 -- <relevant-paths>` for recent changes. Use `git log --all --oneline --grep="<topic>"` to find topic-related commits.
- **Documentation:** Check `README.md`, `docs/`, inline comments in relevant files.
- **Scratchpad:** Use Glob to check `scratchpad/` for context files matching the topic.

### Step 3: Check scratchpad with staleness detection

If matching scratchpad files are found:
1. Run the staleness detection procedure from `${CLAUDE_SKILL_DIR}/references/staleness-detection.md`
2. Apply the staleness action rules from the main SKILL.md:
   - **Fresh:** load as-is
   - **Stale:** strip sections with changed references, add warning notes
   - **Broken:** do not load, report to user

### Step 4: Determine if subagents are needed

Spawn subagents via the Agent tool when:
- The exploration scope requires reading many files (10+ files across different areas)
- Multiple independent code paths need investigation
- The topic spans several distinct subsystems

When spawning subagents:
- Use `subagent_type: "Explore"` for read-only research
- Launch all agents in a single message for parallel execution
- Give each agent a focused area and a structured output format
- Limit to 1-3 agents

For narrower topics (single module, few files), explore directly without subagents.

### Step 5: Synthesize findings

Combine all gathered context into a coherent summary:
- Cross-reference code findings with git history
- Connect scratchpad knowledge with current codebase state
- Identify gaps or contradictions

### Step 6: Present in context

Output findings using the targeted mode format:

```markdown
## Selected Context: <topic>

### Relevant Code
<Key files, functions, and their relationships — include file paths and line numbers>

### History
<Relevant git changes, who changed what and why, recent commit summaries>

### Documentation
<Related docs, comments, or previously written scratchpad context>

### Summary
<How these pieces fit together for the current task, actionable insights>
```

Preserve all specifics: exact file paths, line numbers, function names, error messages. Never reduce detailed findings to vague summaries.
