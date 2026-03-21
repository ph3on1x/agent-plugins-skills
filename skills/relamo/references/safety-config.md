# Safety Configuration

Default guardrails for the relamo REPL. All values are accessible and mutable via the `config` dict in the REPL namespace.

## Defaults

| Parameter | Default | Max | Purpose |
|-----------|---------|-----|---------|
| `recursion_limit` | 1 | 3 | Max depth for `recursive_llm()` calls |
| `max_iterations` | 15 | 30 | REPL loop iterations before forced stop |
| `timeout_seconds` | 120 | 300 | Per `llm_query`/`recursive_llm` call timeout |
| `max_output_chars` | 5000 | 20000 | REPL stdout truncation limit |
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

## Cost Estimates

Approximate costs per operation (varies by model and prompt size):

| Operation | Approximate Cost |
|-----------|-----------------|
| Single `llm_query()` | $0.01–0.05 |
| Partition + Map (20 chunks) | $0.20–1.00 |
| `recursive_llm()` depth 1, 10 chunks | $0.50–2.00 |
| `recursive_llm()` depth 2, 10 chunks | $2.00–10.00 |
| Full session (15 iterations, mixed) | $1.00–5.00 |

The `max_budget_usd` parameter is advisory in v0.1.0 — not programmatically enforced. Track spend by counting `llm_query` calls.

## Loop Detection

The REPL does not automatically detect loops. The SKILL.md instructions tell Claude to:

1. **Track iteration goals** — each iteration must state its purpose
2. **Detect repetition** — if the same code produces the same output twice, change strategy
3. **Hard stop at 3 stalled iterations** — if 3 consecutive iterations make no progress, reassess the entire approach
4. **Never increase `max_iterations`** — if 15 iterations aren't enough, the approach is fundamentally wrong

## Modifying Config at Runtime

```python
# In the REPL:
config["max_output_chars"] = 10000   # see more output
config["recursion_limit"] = 2       # allow deeper recursion
config["timeout_seconds"] = 180     # more time for llm_query
```

Changes take effect immediately for all subsequent operations.
