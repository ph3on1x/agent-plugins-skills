# refine-prompt

> Invoke as `/refine-prompt` (optionally with your rough prompt as an argument).

An interview-style prompt refiner. It turns a rough, under-specified request
into a clear, well-structured prompt **before** any work begins — then runs it.
On invocation it picks a prompt-engineering framework that fits your task, asks
only for the details that are genuinely missing, assembles an XML-tagged prompt
with explicit success criteria, confirms it with you, and finally executes it in
the same session.

## When to use it

- Your request is vague and you want the model to do the right thing the first time.
- You want a reusable, well-structured prompt rather than a one-off.
- You'd rather answer a few targeted questions than hand-write prompt scaffolding.

If your prompt is already complete, it asks nothing and goes straight to the
confirm step.

## Supported frameworks

It selects **one** structural framework based on the task. Each defines which
slots of information the prompt must carry.

| Framework | Slots | Use when |
|---|---|---|
| **RTF** | Role · Task · Format | Quick, single-step asks |
| **RACE** | Role · Action · Context · Execute | Everyday professional tasks (default) |
| **RISEN** | Role · Instruction · Structure · Examples · Nuance | Precise, technical, code, repeatable |
| **CO-STAR** | Context · Objective · Style · Tone · Audience · Response | Content where voice/tone/audience matter |
| **CRISPE** | Capacity · Insight · Statement · Personality · Experiment | Creative / exploratory work |
| **BAB** | Before · After · Bridge | Persuasive copy, pitches |
| **AIDA** | Attention · Interest · Desire · Action | Marketing / sales copy |
| **TAG** | Task · Action · Goal | A goal with explicit ordered steps |
| **CIDI** | Context · Instruction · Detail · Input | Context-heavy tasks over supplied input |
| **5W3H** | Who/What/When/Where/Why/How/How much/How many | Requirements gathering; gap-finding checklist |

Reasoning techniques (few-shot examples, step-by-step / chain-of-thought,
retrieval / sources) are an **orthogonal layer** applied only when the task
needs them — modern models reward clarity and structure over reasoning
gimmicks. Full slot definitions, the selection decision tree, and a worked
example live in [`references/frameworks.md`](references/frameworks.md).

## How it works

1. **Capture** your rough prompt (argument, or it asks).
2. **Classify** the task and select one framework (and tells you which).
3. **Diagnose** which framework slots are already satisfied vs missing.
4. **Interview** — asks only the gaps via `AskUserQuestion` (batched, with
   sensible default options). Skips entirely if nothing is missing.
5. **Assemble** an XML-tagged prompt with success criteria and output format.
6. **Confirm** — shows the prompt; you choose **Run it**, **Run in /plan mode**,
   **Copy** (hand back the prompt without running), **Edit a section**, or start
   over.
7. **Execute** the approved prompt in this session.

## Install

```bash
npx skills add ph3on1x/agent-plugins-skills --skill refine-prompt
```

Or in Claude Code: `/plugin marketplace add ph3on1x/agent-plugins-skills` then
`/plugin install refine-prompt@ph3on1x`.
