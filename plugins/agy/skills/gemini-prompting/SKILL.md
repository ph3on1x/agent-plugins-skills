---
name: gemini-prompting
description: Internal guidance for shaping task prompts sent to Google Antigravity (Gemini models) by the agy rescue subagent
user-invocable: false
---

# Prompting Gemini through agy

Use this skill only when `agy:agy-rescue` tightens a user's request before forwarding it. It shapes
the prompt text; it never authorizes inspecting the repository or solving the task yourself.

Gemini 3 models respond best to direct, compact instructions with a clear output contract. Long
persuasive prose and repeated emphasis make results worse, not better.

Rules:
- One task per run. Split unrelated asks into separate runs.
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
- Write tasks: `<scope>` naming what not to touch, so agy stays narrow and avoids unrelated refactors.
- Diagnosis or research: ask for observed facts, the root cause with evidence, and open questions as separate sections.
- Follow-ups with `--resume-last`: send only the new instruction, not the whole original prompt.

Do not raise `--effort` or switch models to compensate for a vague prompt; tighten the prompt first.
