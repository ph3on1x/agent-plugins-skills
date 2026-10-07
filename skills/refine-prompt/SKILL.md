---
name: refine-prompt
description: This skill should be used when the user wants to "refine my prompt", "enhance this prompt", "make this a better prompt", "improve my prompt", "rewrite this prompt", or invokes /refine-prompt. Interviews the user with AskUserQuestion to fill gaps, picks the right prompt-engineering framework (RTF, RACE, RISEN, CO-STAR, CRISPE, BAB, TAG, CIDI, …) for the task, assembles a structured XML prompt, confirms it, then executes it in this session.
argument-hint: "[rough prompt or task description] (optional — omit to be asked)"
---

# /refine-prompt — Interview-Style Prompt Refiner

## Purpose

Turn a rough, under-specified request into a clear, well-structured prompt
before any real work begins, then run that refined prompt. The skill diagnoses
what the request is missing, asks only for what is genuinely unclear, picks a
prompt-engineering framework that fits the task, assembles an XML-tagged prompt,
confirms it with the user, and finally executes it in the same session.

The guiding principle: modern models reward **clarity, structure, and context**,
not reasoning gimmicks. Default to a clean structural framework; add reasoning
scaffolding (step-by-step, few-shot, retrieval) only when the task actually
demands it.

## Execution flow

1. **Capture the original prompt.** Use the invocation argument as the rough
   prompt when present. When no argument is given, ask the user what they want
   done in one open question before continuing.

2. **Score the frameworks and select ONE.** A large task with multiple
   dependent stages is decomposed into a prompt chain first, and each smaller
   prompt is scored on its own. Otherwise score every row of the selection
   table below against the request: 0 when its signal is absent, 1 when it is
   present, 2 when it defines the task. The highest score wins; on a tie,
   prefer the framework with fewer slots; when every score is 0, use RACE.
   Route on the task's shape, never its domain: in a coding agent nearly every
   request is about code, so "it is technical" scores nothing. Read
   `references/frameworks.md` for the full catalog, slot definitions, and the
   scoring rules. State the winner, the runner-up, and the signal that decided
   it to the user in one line (`CIDI 2 · CRISPE 1 — the stack trace is most of
   the request`), so the choice is transparent.

3. **Diagnose gaps (adaptive).** Map the original prompt onto the chosen
   framework's slots. Mark each slot as satisfied, missing, or ambiguous. When
   every slot is already satisfied, skip directly to step 5 — do not invent
   questions.

4. **Interview only the gaps.** Ask the missing or ambiguous slots with
   `AskUserQuestion`, batched at most four per call. Give each question two to
   four concrete, sensible default options (the user can always pick "Other" for
   free text). Never re-ask something the original prompt already answers. Run a
   second round only when an answer opens a new gap; otherwise proceed.

5. **Assemble the refined prompt.** Emit an XML-tagged prompt following the
   chosen framework's slots (see Assembly rules). Always include explicit
   success criteria, the desired output format, and an instruction to say so
   when unsure rather than guess. Add a reasoning/technique layer ONLY when the
   task needs it — never by default:
   - strict output shape → add one or two **few-shot** examples;
   - genuinely hard multi-step reasoning → ask the model to work step by step;
   - fact-heavy or current-events task → request **sources / retrieval** and
     instruct against fabrication.

6. **Confirm.** Show the assembled prompt in a fenced code block, then ask via
   `AskUserQuestion`. `AskUserQuestion` allows at most four options plus an
   automatic "Other", so present these four and let "Other" carry *Start over*:
   - **Run it** *(Recommended)* → go to step 7 and execute now.
   - **Run in /plan mode** → enter plan mode (`EnterPlanMode`) first, then carry
     out the refined prompt as a planning task — research and propose a plan for
     approval before making any changes.
   - **Copy** → output the final prompt in a fenced code block for the user to
     copy and stop. Do not execute it.
   - **Edit a section** → collect the change, re-assemble (step 5), re-confirm.

   If the user picks "Other" and asks to *start over*, return to step 2.

7. **Execute.** Once approved, treat the refined prompt as the active
   instruction and carry out the task here in this session.

## Framework selection heuristic

Decompose a large task with multiple dependent stages into a prompt chain
first, and score each smaller prompt on its own. Otherwise score every row:
0 = signal absent, 1 = present, 2 = defines the task. Highest score wins; a
tie goes to the framework with fewer slots; all zeros means RACE. Row order
carries no priority.

| Signal in the request | Framework |
|---|---|
| Quick, single-step ask, almost no context | RTF (Role · Task · Format) |
| Persuasive or marketing copy | BAB (Before-After-Bridge) or AIDA |
| Content where voice, tone, audience matter | CO-STAR (Context · Objective · Style · Tone · Audience · Response) |
| Creative / exploratory / wants several options | CRISPE |
| Ordered steps, a defined end state, and explicit constraints that narrow scope (zero-downtime migration) | RISEN (Role · Instructions · Steps · End goal · Narrowing) |
| Goal with explicit ordered steps, nothing to narrow (CI setup, release checklist) | TAG (Task · Action · Goal) |
| Work over supplied input (logs, trace, diff, file, data) | CIDI (Context · Instruction · Detail · Input) |
| Every other row scores 0, including most feature, refactor, and investigation work | RACE (Role · Action · Context · Execute) — default, not scored |

An exact output format is not a row: pick by shape, then add few-shot examples
in step 5.

Full slot definitions, "use when" notes, and the scoring rules live in
`references/frameworks.md`.

## Assembly rules

- Wrap each section in descriptive XML tags — Claude parses them more reliably
  than prose or markdown headers. Typical tags: `<role>`, `<context>`,
  `<objective>` (or `<task>`), `<instructions>`, `<constraints>`,
  `<output_format>`, `<success_criteria>`, and `<examples>` when used.
- Order matters: put `<role>` and `<context>` first, then the objective, then
  instructions and output format.
- Preserve the user's own wording wherever it is already specific and good;
  refine, do not rewrite for its own sake.
- Map the chosen framework's slots onto these tags rather than inventing a new
  structure per task.

## Constraints

- Be adaptive, never badger. A complete prompt gets zero questions.
- Use exactly one structural framework per prompt.
- Add reasoning scaffolding only on demand, never as a default.
- Always confirm the assembled prompt before executing it.
- Always surface the chosen framework name so the decision is transparent.
