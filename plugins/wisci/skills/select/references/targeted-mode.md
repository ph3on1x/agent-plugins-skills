# Targeted Mode — Deep Exploration

When `/select` is invoked with arguments, load focused context on the specified topic from four sources: stored context, project code, git history, and documentation.

## Step 1: Parse topic

Read `$ARGUMENTS`. Identify:
- The domain or area to explore
- Whether the user wants code, history, documentation, stored context, or a combination
- Specific files, patterns, or handoff stream names mentioned

If `$ARGUMENTS` names a handoff stream (matches a slug in the scan's `streams` list): load that leaf (apply SKILL.md staleness rules, including the 7-day age warning) and present it. That may be the entire job — only continue below if the user asked for more than the stream state.

## Step 2: Stored context first

Check the scan's `files` for `.wisci/context/` entries matching the topic. Load matches per the SKILL.md staleness action rules (fresh → as-is, stale → strip sections, broken → skip and report). Stored context loads before exploration — it may answer the question and shrink what Step 3 must cover.

## Step 3: Explore the codebase

Fill gaps the stored context left:

- **Code:** Grep for relevant patterns, function names, keywords; Glob for file patterns.
- **Git history:** `git log --oneline -20 -- <relevant-paths>`; `git log --all --oneline --grep="<topic>"`.
- **Docs:** `README.md`, `docs/`, inline comments in relevant files.

Spawn subagents (Agent tool, `subagent_type: "Explore"`, all in one message, max 3) only when the scope is genuinely wide: 10+ files across areas, several distinct subsystems. Narrow topics: explore directly.

## Step 4: Synthesize and present

Cross-reference code findings with git history; connect stored knowledge with current code state; flag contradictions between stored context and what the code now shows (stale knowledge the staleness check cannot catch).

```markdown
## Selected Context: <topic>

### Relevant Code
<key files, functions, relationships — file paths and line numbers>

### History
<relevant git changes and why they matter>

### Documentation
<docs, comments, loaded stored context>

### Summary
<how the pieces fit together for the current task>
```

Preserve all specifics: exact paths, line numbers, function names, error messages. End with the load report from SKILL.md's Output Contract.
