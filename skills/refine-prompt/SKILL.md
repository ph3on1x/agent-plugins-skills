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

2. **Classify the task type and select ONE framework.** Match the request
   against the selection table below. When two fit, prefer the simpler one. Read
   `references/frameworks.md` for the full catalog, slot definitions, and the
   tie-breaker decision tree. State the chosen framework to the user in one line
   so the choice is transparent.

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

| Task type | Framework |
|---|---|
| Quick, single-step ask | RTF (Role · Task · Format) |
| Everyday professional task | RACE (Role · Action · Context · Execute) |
| Precise / technical / code / repeatable | RISEN (Role · Instruction · Structure · Examples · Nuance) |
| Content where voice, tone, audience matter | CO-STAR (Context · Objective · Style · Tone · Audience · Response) |
| Creative / exploratory / brainstorming | CRISPE |
| Persuasive or marketing copy | BAB (Before-After-Bridge) or AIDA |
| Goal with explicit action steps | TAG (Task · Action · Goal) |
| Context-heavy information task | CIDI (Context · Instruction · Detail · Input) |
| Large multi-step / complex task | Decompose into a prompt chain |

Full slot definitions, "use when" notes, and the decision tree live in
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
