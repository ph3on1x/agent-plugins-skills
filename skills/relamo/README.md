# relamo

Explore codebases too large for Claude's context window — via a persistent Python REPL that treats your entire codebase as a variable.

relamo is a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that implements the **Recursive Language Model (RLM)** pattern. Instead of stuffing files into prompts, it concatenates your codebase into a Python variable and lets Claude write code to search, extract, and analyze it iteratively — with full state persistence across REPL iterations.

## The Problem

Claude Code is great at reading individual files. But when you need to understand how an entire codebase fits together:

- **Context window limits** — large codebases don't fit in a single prompt
- **No state between tool calls** — each Read/Grep starts from scratch
- **No batch processing** — you can't programmatically map an operation across 50 files

## How relamo Solves It

```
          /relamo "find all auth flows"
                    |
                    v
    +-------------------------------+
    |  Init: gather codebase into   |
    |  `context` Python variable    |
    +-------------------------------+
                    |
                    v
    +-------------------------------+
    |  Assess: what do I know?      |<--+
    |  what do I need to find out?  |   |
    +-------------------------------+   |
                    |                   |
                    v                   |
    +-------------------------------+   |
    |  Write Python code targeting  |   |
    |  the context variable         |   |
    +-------------------------------+   |
                    |                   |
                    v                   |
    +-------------------------------+   |
    |  Execute in sandboxed REPL    |   |
    |  (variables persist!)         |   |
    +-------------------------------+   |
                    |                   |
                    v                   |
    +-------------------------------+   |
    |  Read output, decide:         |   |
    |  need more? --> loop back     |---+
    |  done? --> FINAL(answer)      |
    +-------------------------------+
```

The entire codebase lives outside the prompt as a Python string. Claude writes code to interact with it — `search()`, `extract_file()`, `llm_query()` — accumulating findings in variables across iterations. This is the pattern described in the [MIT RLM research](https://arxiv.org/abs/2307.00522), brought to Claude Code as a skill.

## Quick Start

Install the plugin:

```
/plugin install ph3on1x/relamo
```

Run it:

```
/relamo "what design patterns does this project use?"
```

That's it. relamo initializes a REPL with your codebase, explores iteratively, and returns a structured answer with evidence.

## Features

- **Persistent REPL** — variables survive across iterations; accumulate findings, not prompts
- **Full codebase as a variable** — `context` holds your entire codebase as a searchable string
- **Built-in helpers** — `extract_file()`, `search()`, `list_files()` for fast navigation
- **LLM-in-the-loop** — `llm_query()` calls Claude from within the REPL for sub-analysis
- **Recursive deep dives** — `recursive_llm()` spawns child RLM instances for focused sub-questions
- **Sandboxed execution** — module whitelist, blocked `eval`/`exec`, filtered imports
- **Configurable guardrails** — recursion depth, iteration limits, timeouts, output truncation

## Usage

```
/relamo "<query>" [--context <path>] [--depth <1-3>] [--iterations <max>]
```

| Argument | Default | Description |
|----------|---------|-------------|
| `<query>` | required | The question or task to answer |
| `--context <path>` | current directory | Path to codebase directory or single file |
| `--depth <1-3>` | 1 | Max recursion depth for `recursive_llm()` |
| `--iterations <max>` | 15 | Max REPL loop iterations |

### Example Session

```
> /relamo "how does authentication work in this project?"

[relamo] Gathering codebase from: /Users/you/project
[relamo] Context size: 245,891 characters (241,003 bytes)
[relamo] Files included: 87

--- Iteration 1: Orient ---
files = list_files()
auth_files = [f for f in files if 'auth' in f.lower()]
print(auth_files)
# ['src/auth/middleware.ts', 'src/auth/providers.ts', 'src/auth/session.ts', ...]

--- Iteration 2: Extract key files ---
middleware = extract_file('src/auth/middleware.ts')
print(middleware[:2000])

--- Iteration 3: Analyze with LLM ---
analysis = llm_query(f"Explain the auth flow in this middleware:\n{middleware}")
print(analysis)

--- Iteration 4: Search for usage ---
results = search(r'requireAuth|isAuthenticated|withAuth')
print(f"Found {len(results)} usages across codebase")

--- Iteration 5: Synthesize ---
FINAL(f"Authentication uses JWT tokens via {analysis}...")

## RLM Result
### Answer
Authentication uses JWT tokens with a middleware chain...
### Evidence
src/auth/middleware.ts:15 — token validation
src/auth/providers.ts:42 — OAuth provider config
...
```

## How It Works

The REPL engine (`scripts/repl.py`) is a [uv](https://docs.astral.sh/uv/) single-file script with [PEP 723](https://peps.python.org/pep-0723/) inline metadata. No manual dependency installation needed — `uv run` handles everything.

1. **Init** — gathers your codebase via `git ls-files` (or directory walk), skips binaries and large files, concatenates everything with `=== path ===` delimiters
2. **Execute** — runs Python code in a namespace where `context` and helpers are pre-loaded; state persists via [dill](https://github.com/uqfoundation/dill) serialization
3. **Loop** — Claude assesses, writes code, executes, reads output, and decides whether to continue or call `FINAL()`

### Available Functions

| Function | Purpose |
|----------|---------|
| `context` | Full concatenated codebase as string |
| `list_files()` | All file paths in context |
| `extract_file(path)` | Extract single file content by path |
| `search(pattern, context_chars=200)` | Regex search with surrounding context |
| `llm_query(prompt)` | Claude completion via `claude -p` |
| `llm_query_batched(prompts)` | Sequential LLM calls on a list of prompts |
| `recursive_llm(query, sub_context)` | Spawn child RLM instance |
| `FINAL(answer)` | Emit final answer and terminate |
| `FINAL_VAR(var_name)` | Emit a variable as the answer |
| `config` | Mutable safety config dict |

## Safety and Cost

### Guardrails

| Parameter | Default | Description |
|-----------|---------|-------------|
| `recursion_limit` | 1 | Max depth for `recursive_llm()` |
| `max_iterations` | 15 | REPL loop cap |
| `timeout_seconds` | 120 | Per LLM call timeout |
| `max_output_chars` | 10,000 | Stdout truncation limit |
| `max_file_size` | 1 MB | Skip individual files larger than this |
| `max_context_bytes` | 50 MB | Total codebase size limit |

All values are adjustable at runtime via the `config` dict.

### Sandboxing

The REPL runs in a restricted environment:
- **Blocked builtins**: `eval`, `exec`, `compile` are removed
- **Import whitelist**: only `re`, `json`, `math`, `collections`, `itertools`, `functools`, `textwrap`, `difflib`, `hashlib`, `datetime`, `csv`, `io`, `os.path`, `pathlib`, `string`, `unicodedata`

### Cost Estimates

Each `llm_query()` or `recursive_llm()` call uses the Claude API. Approximate costs:

| Operation | Estimated Cost |
|-----------|---------------|
| Single `llm_query()` | $0.01 -- $0.05 |
| Batch of 20 chunks | $0.15 -- $1.00 |
| Full session (15 iterations) | $0.50 -- $5.00 |

## Requirements

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** with `claude` CLI in PATH
- **Python 3.11+** (managed automatically by uv)
- **[uv](https://docs.astral.sh/uv/)** (auto-installs the `dill` dependency)

## License

[MIT](LICENSE)
