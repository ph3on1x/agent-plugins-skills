---
name: relamo
description: This skill should be used when the user asks to "process large codebase", "recursive language model", "RLM", "explore entire codebase", "analyze codebase", "REPL loop for code", "context as variable", "chunk and process codebase", or needs to programmatically explore a codebase too large for the context window using iterative Python-based exploration.
argument-hint: "<query> [--context <path>] [--depth <1-3>] [--iterations <max>]"
---

# /relamo — Recursive Language Model

Explore codebases programmatically through a persistent Python REPL. The entire codebase is concatenated into a single `context` variable. Write Python code to search, slice, chunk, and analyze it — with `llm_query()` for LLM-in-the-loop sub-analysis and `recursive_llm()` for deep dives.

This is NOT prompt-stuffing. Context lives outside the prompt as a Python variable. Claude writes code to interact with it iteratively, accumulating findings in variables across REPL invocations.

## The Iron Law

```
NO ANSWER WITHOUT CONTEXT EXPLORATION FIRST
```

Never synthesize an answer from the query alone. Always explore the codebase programmatically first — peek at structure, search for relevant code, extract and analyze files. Even if the answer seems obvious, verify it against the actual code.

## Argument Parsing

Parse `$ARGUMENTS`:

- `<query>` (required) — the task or question to answer
- `--context <path>` (optional) — path to codebase directory or single file. Defaults to `${CLAUDE_WORK_DIR}`.
- `--depth <1-3>` (optional) — recursion depth limit. Default 1.
- `--iterations <max>` (optional) — max REPL loop iterations. Default 15.

If `$ARGUMENTS` is empty, ask the user for a query.

## Initialization

1. Determine context source:
   - Directory (default): use `--codebase-dir`
   - Single file: use `--context-file`

2. Initialize the REPL:
   ```
   Bash: uv run ${CLAUDE_SKILL_DIR}/scripts/repl.py init --codebase-dir ${CLAUDE_WORK_DIR} --state-dir /tmp/relamo-$(date +%s)
   ```

3. Record the **state directory path** from output — pass it to every subsequent `execute` call.

4. Review the init summary: file count, context size, sample files. If context is empty or unexpectedly small, investigate before proceeding.

If `--depth` or `--iterations` were specified, override defaults in the first execute call:
```python
config["recursion_limit"] = <depth>
config["max_iterations"] = <iterations>
```

## The REPL Loop

Iterate until `FINAL()` is called or max iterations reached:

1. **Assess** — State what you know so far and what you need to find out next. Every iteration MUST have a stated goal.

2. **Write code** — Compose Python targeting the `context` variable. Use `extract_file()`, `search()`, `list_files()`, slicing, regex, `llm_query()`.

3. **Execute** — Run via Bash:
   ```
   uv run ${CLAUDE_SKILL_DIR}/scripts/repl.py execute "<code>" --state-dir <dir>
   ```
   For multi-line code, use heredoc with stdin (`-`):
   ```
   uv run ${CLAUDE_SKILL_DIR}/scripts/repl.py execute - --state-dir <dir> <<'PYEOF'
   <multi-line code>
   PYEOF
   ```

4. **Read output** — Parse stdout. If truncated, refine the query to target specific sections.

5. **Decide** — Need more exploration? → back to step 1. Ready to answer? → step 6.

6. **Terminate** — Call `FINAL("your answer")` or `FINAL_VAR("result_variable")`. When `__RELAMO_FINAL__` appears in output, present the answer to the user.

**Rules:**
- After 3 iterations without progress, reassess strategy entirely.
- Use `llm_query()` for reasoning about extracted code — don't try to reason about large text chunks in Python.
- Store intermediate results in variables — they persist across iterations.

## Available REPL Functions

| Function | Purpose |
|----------|---------|
| `context` | Full concatenated codebase as string |
| `list_files()` | All file paths in context |
| `extract_file(path)` | Extract single file content by path |
| `search(pattern, context_chars=200)` | Regex search returning matches with surrounding context |
| `llm_query(prompt)` | LLM completion via `claude -p` |
| `llm_query_batched(prompts)` | Sequential LLM calls on a list of prompts |
| `recursive_llm(query, sub_context)` | Spawn child RLM (respects depth limit) |
| `FINAL(answer)` | Emit final answer — terminates loop |
| `FINAL_VAR(var_name)` | Emit a namespace variable as the answer |
| `config` | Mutable safety config dict |

For full function signatures, read `${CLAUDE_SKILL_DIR}/references/repl-setup.md`.

## Emergent Strategies

Discover and apply these patterns as appropriate:

- **Peek**: `print(context[:3000])` or `list_files()` — orient yourself, understand structure
- **Search**: `search(r'useState|useReducer')` — find relevant code across all files
- **Extract + Analyze**: `code = extract_file('src/store.ts')` then `llm_query(f"Analyze this:\n{code}")`
- **Partition + Map**: chunk a large file, `llm_query_batched([f"Summarize:\n{c}" for c in chunks])`
- **Recursive deep dive**: `recursive_llm("explain the auth flow", extract_file('src/auth.ts'))`
- **Aggregate**: store findings in variables across iterations, synthesize at the end

## Safety Guardrails

| Parameter | Default |
|-----------|---------|
| `recursion_limit` | 1 |
| `max_iterations` | 15 |
| `timeout_seconds` | 120 |
| `max_output_chars` | 10000 |

For full configuration and rationale, read `${CLAUDE_SKILL_DIR}/references/safety-config.md`.

## Common Rationalizations

| Thought | Reality |
|---------|---------|
| "I can answer from the query alone" | The codebase has the ground truth. Explore first. |
| "The codebase is small, just read it all" | Use the REPL — variables persist for verification. |
| "One `llm_query` on everything" | That defeats the purpose. Target specific files. |
| "Skip the REPL, use Read/Grep directly" | REPL enables variable persistence and batch processing. |
| "Recursion is overkill" | Even depth-1 outperforms flat prompting on large context. |
| "15 iterations aren't enough" | Wrong approach. Reassess strategy. |

## Output Format

After `FINAL()` emits the answer, present results to the user:

```markdown
## RLM Result

### Exploration Summary
<Strategies used, iterations taken, llm_query calls made>

### Answer
<The FINAL answer>

### Evidence
<Key code excerpts from the context that support the answer>
```

## Additional Resources

- `${CLAUDE_SKILL_DIR}/references/repl-setup.md` — REPL architecture, context loading, helper function signatures, sandboxing, troubleshooting
- `${CLAUDE_SKILL_DIR}/references/system-prompt.md` — System prompt template for `recursive_llm()` sub-calls
- `${CLAUDE_SKILL_DIR}/references/safety-config.md` — Full safety configuration, cost estimates, recursion tradeoffs
