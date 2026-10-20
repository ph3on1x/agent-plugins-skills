---
name: muse-prompting
description: Internal guidance for shaping task prompts sent to Meta's Muse Code (Muse Wonder and Muse Spark models) by the muse rescue subagent
user-invocable: false
metadata:
  internal: true
---

# Prompting Muse Code

Use this skill only when `muse:muse-rescue` tightens a user's request before forwarding it. It shapes
the prompt text; it never authorizes inspecting the repository or solving the task yourself.

Muse Wonder and Muse Spark are reasoning models: they plan before they act. Give them the goal, the
constraints, and what done looks like, not step-by-step instructions. Long persuasive prose and
repeated emphasis make results worse, not better.

Muse reads the repository's own instruction files (`AGENTS.md`, `CLAUDE.md`) only when the user has
trusted the workspace in muse, so a constraint that matters for this task belongs in the prompt.

Rules:
- The whole request goes into one run. Do not split it, drop parts of it, or answer any of it.
- Put any long context (pasted logs, error output, file excerpts the user supplied) first, and the
  instructions last, starting with a line such as "Based on the context above, ...".
- Say what done looks like: the end state, how to verify it, and the shape of the final answer.
- Keep the user's own words for the goal; add structure, do not change intent.
- Use stable XML-style tags when the request has several parts.

Default shape:

```
<context>
(only what the user supplied: error output, failing test name, constraints)
</context>

<task>
The concrete job, in the user's terms.
</task>

<done_when>
The observable end state and the check that proves it (a passing test, a reproduced bug, a root cause with evidence).
</done_when>

<output>
Final answer: what changed or what was found, files touched, how it was verified, and anything left open.
Keep claims tied to evidence; label guesses as guesses.
</output>
```

Add when relevant:
- Write tasks: `<scope>` naming what not to touch, so muse stays narrow and avoids unrelated refactors.
- Diagnosis or research: ask for observed facts, the root cause with evidence, and open questions as separate sections.
- Follow-ups with `--resume-last`: send only the new instruction, not the whole original prompt.

Do not raise `--effort` or switch models to compensate for a vague prompt; tighten the prompt first.
