# refine-prompt

An interview-style prompt refiner. It turns a rough, under-specified request
into a clear, well-structured prompt **before** any work begins — then runs it.
It picks a prompt-engineering framework that fits your task, asks only for the
details that are genuinely missing, assembles an XML-tagged prompt with explicit
success criteria, confirms it with you, and executes it in the same session.

## What you get

- **`/refine-prompt [rough prompt]`** — the skill. Works in every agent that
  reads the [Agent Skills](https://agentskills.io) standard.
- **`[ refine prompt ]` button** — a Claude Code mod that sits in the row above
  the prompt box and sends whatever you have typed to `/refine-prompt`. Claude
  Code only.

## Install

### Claude Code (skill + button)

```text
/plugin marketplace add ph3on1x/agent-plugins-skills
/plugin install refine-prompt@ph3on1x
```

The button needs a Claude Code version with mods (function-hook plugins); it is
tested on Claude Code 2.1.292.

### Codex, Cursor, Gemini CLI, Antigravity and other agents (skill only)

```bash
npx skills add ph3on1x/agent-plugins-skills --skill refine-prompt
```

## The refine prompt button

```text
[ refine prompt ]  ctrl+x tab, enter                              [-]
────────────────────────────────────────────────────────────────────
❯ write a migration plan for the auth service
```

Type a rough prompt, then click **`[ refine prompt ]`**. The draft leaves the
prompt box and runs as `/refine-prompt <draft>`. If the run fails, the draft is
put back.

- In the terminal, the keyboard works too, with nothing to configure:
  `ctrl+x tab` is Claude Code's own key for focusing the row above the prompt,
  and the button holds the focus there, so Enter presses it. `Esc` returns to
  the prompt.
- In the Claude desktop app, the button shows in the **Code** tab once a
  session has started; click it there. Chat does not run mods.
- An empty prompt box runs nothing and says so.
- The button steps aside while a Claude Code survey uses that row, and the
  row's own `[-]` collapses it.

## When to use it

- Your request is vague and you want the model to do the right thing the first time.
- You want a reusable, well-structured prompt rather than a one-off.
- You'd rather answer a few targeted questions than hand-write prompt scaffolding.

If your prompt is already complete, it asks nothing and goes straight to the
confirm step.

## How it works

1. **Capture** your rough prompt (argument, or it asks).
2. **Classify** the task and select one framework, telling you which and the
   signal that picked it.
3. **Diagnose** which framework slots are already satisfied vs missing.
4. **Interview** — asks only the gaps via `AskUserQuestion` (batched, with
   sensible default options). Skips entirely if nothing is missing.
5. **Assemble** an XML-tagged prompt with success criteria and output format.
6. **Confirm** — shows the prompt; you choose **Run it**, **Run in /plan mode**,
   **Copy** (hand back the prompt without running), **Edit a section**, or start
   over.
7. **Execute** the approved prompt in this session.

## Supported frameworks

It selects **one** structural framework per prompt. Selection goes by the
task's **shape** (how much context, what input, what kind of output), never by
its topic: in a coding agent nearly every request is about code, so "it is
technical" picks nothing. The rows below are checked top to bottom; the first
match wins.

| Framework | Slots | Picked when |
|---|---|---|
| **RTF** | Role · Task · Format | Quick, single-step ask with almost no context |
| *prompt chain* | — | Large task with several dependent stages: split into smaller refined prompts |
| **BAB** / **AIDA** | Before · After · Bridge / Attention · Interest · Desire · Action | Persuasive or marketing copy |
| **CO-STAR** | Context · Objective · Style · Tone · Audience · Response | Voice, tone and audience matter |
| **CRISPE** | Capacity · Insight · Statement · Personality · Experiment | Creative work that wants several options |
| **RISEN** | Role · Instructions · Steps · End goal · Narrowing | Ordered steps, a defined end state, and constraints that narrow scope |
| **TAG** | Task · Action · Goal | Ordered steps toward a goal, nothing to narrow |
| **CIDI** | Context · Instruction · Detail · Input | Work over supplied input: logs, a diff, files, data |
| **RACE** | Role · Action · Context · Execute | Everything else, including most feature, refactor and investigation work (default) |

**5W3H** (Who · What · When · Where · Why · How · How much · How many) is a
gap-finding checklist used alongside the chosen framework, not a structure of
its own. An exact output format is not a selection signal either: the framework
is picked by shape, then few-shot examples are added.

Reasoning techniques (few-shot examples, step-by-step / chain-of-thought,
retrieval / sources) are an **orthogonal layer** applied only when the task
needs them — modern models reward clarity and structure over reasoning
gimmicks. Full slot definitions, the decision tree, and a worked example live
in [`references/frameworks.md`](references/frameworks.md).

## Development

The button is a function-hooks module, `hooks/register.tsx`, with tests in
`tests/`:

```bash
claude plugin validate skills/refine-prompt
claude plugin test skills/refine-prompt
```
