# Safety Configuration

Default guardrails for the relamo REPL. All values are accessible and mutable via the `config` dict in the REPL namespace.

## Defaults

| Parameter | Default | Max | Purpose |
|-----------|---------|-----|---------|
| `recursion_limit` | 1 | 3 | Max depth for `recursive_llm()` calls |
| `max_iterations` | 15 | 30 | REPL loop iterations before forced stop |
| `timeout_seconds` | 120 | 300 | Per `llm_query`/`recursive_llm` call timeout |
| `max_output_chars` | 10,000 | 30,000 | REPL stdout truncation limit |
| `max_file_size` | 1 MB | — | Skip individual files larger than this |
| `max_context_bytes` | 50 MB | 100 MB | Total codebase context size limit |

## Recursion Depth vs Accuracy

MIT research findings on RLM recursion depth:

| Depth | Accuracy | Use Case |
|-------|----------|----------|
| 0 | Baseline | Single `llm_query` call, no REPL benefit |
| 1 | ~95% | Default. Child calls answer sub-questions directly |
| 2 | ~88% | Deep analysis of large subsystems |
| 3 | ~82% | Maximum recommended. Significant hallucination risk beyond this |
| 4+ | Degraded | Not recommended. Coherence breaks down |

## Context Window Budget

Defaults are calibrated for Claude Code's standard 200K token context window (~167K before compaction triggers). Each REPL iteration consumes tokens in the Claude Code session:

| Component | Tokens |
|-----------|--------|
| Assessment + code written | ~500–800 |
| Bash command wrapper | ~100 |
| REPL output (at 10K chars) | ~2,860 |
| **Total per iteration** | **~3,560** |

Session overhead (system prompt, skill instructions, init summary): ~5,000–8,000 tokens.

| Scenario | Token Budget | % of 155K usable |
|----------|-------------|------------------|
| 15 iterations @ 10K output (default) | ~53K | 34% |
| 15 iterations @ 20K output | ~96K | 62% |
| 15 iterations @ 30K output (max) | ~139K | 90% |

The default of 10K output leaves ~66% of the usable context for Claude's thinking, user messages, and headroom. Users on 1M context plans have massive headroom and can safely increase `max_output_chars` to 30K.

## Cost Estimates

Approximate costs per operation at current API pricing (Sonnet 4.6: $3/$15 per MTok, Opus 4.6: $5/$25 per MTok):

| Operation | Sonnet 4.6 | Opus 4.6 |
|-----------|-----------|----------|
| Single `llm_query()` | $0.01–0.03 | $0.02–0.05 |
| Partition + Map (20 chunks) | $0.15–0.60 | $0.25–1.00 |
| `recursive_llm()` depth 1, 10 chunks | $0.30–1.50 | $0.50–2.50 |
| Full session (15 iterations, mixed) | $0.50–3.00 | $1.00–5.00 |

Track spend by counting `llm_query` calls. Each call uses a fresh, independent context window via `claude -p`.

## Loop Detection

The REPL does not automatically detect loops. The SKILL.md instructions tell Claude to:

1. **Track iteration goals** — each iteration must state its purpose
2. **Detect repetition** — if the same code produces the same output twice, change strategy
3. **Hard stop at 3 stalled iterations** — if 3 consecutive iterations make no progress, reassess the entire approach
4. **Never increase `max_iterations`** — if 15 iterations aren't enough, the approach is fundamentally wrong

## Modifying Config at Runtime

```python
# In the REPL:
config["max_output_chars"] = 20000   # see more output
config["recursion_limit"] = 2       # allow deeper recursion
config["timeout_seconds"] = 180     # more time for llm_query
```

Changes take effect immediately for all subsequent operations.
