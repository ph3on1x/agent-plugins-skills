# REPL Setup and Architecture

Detailed documentation for the relamo persistent Python REPL engine (`scripts/repl.py`).

## Architecture

The REPL is a uv single-file script (PEP 723) that runs via `uv run`. It uses `dill` for state persistence — handling lambdas, closures, and complex types that `pickle` cannot serialize.

### Two Commands

**`init`** — Gather codebase and create REPL state:
```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/repl.py init --codebase-dir /path/to/project --state-dir /tmp/relamo-XXXX
```

**`execute`** — Run Python code in the persistent namespace:
```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/repl.py execute "print(len(context))" --state-dir /tmp/relamo-XXXX
```

For multi-line code, use stdin:
```bash
uv run ${CLAUDE_SKILL_DIR}/scripts/repl.py execute - --state-dir /tmp/relamo-XXXX <<'PYEOF'
files = list_files()
print(f"Found {len(files)} files")
for f in files[:10]:
    print(f)
PYEOF
```

### State Persistence

Each `execute` call:
1. Loads the namespace from `<state-dir>/state.pkl`
2. Rebuilds helper functions (bound to the loaded context)
3. Executes the provided code in the namespace
4. Saves all serializable variables back to `state.pkl`

Variables persist across calls. Helper functions (`extract_file`, `llm_query`, etc.) are rebuilt fresh each time from the stored context and config.

## Codebase Gathering

### Git Repos
When `.git/` exists, uses `git ls-files --cached --others --exclude-standard` to list files. This respects `.gitignore` automatically.

### Non-Git Directories
Walks the directory tree, skipping common excludes: `.git`, `node_modules`, `__pycache__`, `.venv`, `dist`, `build`, `.next`, `target`, `vendor`, `.idea`, `.vscode`, and others.

### File Filtering
- **Binary detection**: Checks first 8 KB for null bytes. Binary files are skipped.
- **Size limit**: Files > 1 MB are skipped (configurable via `config["max_file_size"]`).
- **Empty files**: Skipped.
- **Total limit**: Stops gathering at 50 MB total (configurable via `config["max_context_bytes"]`).

### Context Format

Files are concatenated with delimiters:
```
=== src/index.ts ===
import { createApp } from 'vue'
...
=== src/store/index.ts ===
import { createStore } from 'vuex'
...
```

Paths are relative to the codebase root.

## Helper Function Reference

### `context` (str)
The full concatenated codebase. Read-only by convention (modifying it won't persist since it's reloaded from disk each execution).

### `list_files() -> list[str]`
Returns all file paths present in the context. Useful for orientation.

### `extract_file(path: str) -> str`
Extracts a single file's content from the concatenated context using the `=== path ===` delimiters. Returns an error string if the file is not found.

### `search(pattern: str, context_chars: int = 200) -> list[str]`
Searches the full context with a regex pattern. Returns a list of matching snippets with `context_chars` characters of surrounding context on each side. Useful for finding relevant code without knowing which file it's in.

### `llm_query(prompt: str, max_tokens: int = 4096) -> str`
Sends a prompt to Claude via `claude -p --no-session-persistence --output-format text`. Returns the response text. On error or timeout, returns an error string (does not raise).

**Timeout**: `config["timeout_seconds"]` (default 120s).

### `llm_query_batched(prompts: list[str]) -> list[str]`
Calls `llm_query` sequentially for each prompt. Returns a list of responses in order. Not truly parallel — sequential execution for simplicity.

### `recursive_llm(query: str, sub_context: str, _depth: int = 0) -> str`
Spawns a child RLM instance via `claude -p` with a system prompt instructing it to read context from a temp file and answer the query. Respects `config["recursion_limit"]` — when depth exceeds the limit, falls back to a flat `llm_query` on truncated context (first 50K chars).

### `FINAL(answer: str) -> None`
Prints the termination marker `__RELAMO_FINAL__: <answer>`. The skill instructions tell Claude to detect this marker and present the answer to the user.

### `FINAL_VAR(var_name: str) -> None`
Resolves a variable from the REPL namespace and prints it with the `__RELAMO_FINAL__` marker.

### `config` (dict)
Mutable safety configuration. See `safety-config.md` for all parameters.

## Sandboxing

The REPL uses a restricted execution environment:

**Blocked builtins**: `eval`, `exec`, `compile` are removed from the namespace.

**Filtered imports**: `__import__` is replaced with a whitelist filter. Allowed modules:
`re`, `json`, `math`, `statistics`, `collections`, `itertools`, `functools`, `textwrap`, `difflib`, `hashlib`, `datetime`, `csv`, `io`, `os.path`, `pathlib`, `string`, `unicodedata`.

Attempting to import other modules raises `ImportError` with the allowed list.

## Troubleshooting

**State corruption**: If the REPL behaves unexpectedly, delete `state.pkl` and re-run `init`:
```bash
rm /tmp/relamo-XXXX/state.pkl
```

**Output truncation**: If output is cut off, increase the limit:
```python
config["max_output_chars"] = 15000
```

**Timeout on `llm_query`**: Network issues or very large prompts. Increase timeout:
```python
config["timeout_seconds"] = 300
```

**Context too large**: If gathering stops early, check `config["max_context_bytes"]`. The default 50 MB covers most codebases. For monorepos, consider using `--context-file` with a pre-filtered file.
