# Prompt-engineering framework reference

Two orthogonal axes. **Structural frameworks** decide *which slots of
information* the prompt must carry. **Reasoning add-ons** decide *how the model
should think* — applied on top, only when the task needs them. Pick exactly one
structural framework; layer add-ons sparingly.

## Structural framework catalog

### RTF — Role · Task · Format
- **Slots:** who the model acts as; what to do; output shape.
- **Use when:** quick, single-step asks where little context is needed.

### RACE — Role · Action · Context · Execute (Expectation)
- **Slots:** persona; the action to perform; background it needs; what the
  finished output should look like.
- **Use when:** the everyday professional workhorse — covers most routine tasks.

### RISEN — Role · Instructions · Steps · End goal · Narrowing
- **Slots:** persona; the instruction; the ordered steps to follow; the
  concrete end state that defines done; narrowing constraints (scope limits,
  what must not change, what to avoid).
- **Use when:** a multi-step task where the order of steps, a defined end
  state, and explicit constraints all matter: a zero-downtime migration, an
  upgrade that must leave one subsystem untouched.
- **Not for:** a task merely because it is technical or about code. Ordered
  steps with nothing to narrow route to TAG; most other code work to CIDI or
  RACE.

### CO-STAR — Context · Objective · Style · Tone · Audience · Response
- **Slots:** situation/background; the goal; writing style; emotional tone;
  intended audience; output format and length.
- **Use when:** content where voice, tone, and audience calibration matter as
  much as the message (marketing, brand copy, comms, system-prompt design).

### CRISPE — Capacity/Role · Insight · Statement · Personality · Experiment
- **Slots:** capability/role; background and context (Insight); the request
  (Statement); tone/personality; a request for several variations (Experiment).
- **Use when:** creative, exploratory, or brainstorming work that benefits from
  several candidate directions.

### BAB — Before · After · Bridge  *(minor)*
- **Slots:** the current problem state; the desired future state; the bridge
  that gets from one to the other.
- **Use when:** persuasive copy, pitches, value propositions.

### AIDA — Attention · Interest · Desire · Action  *(minor)*
- **Slots:** a hook; build interest; create desire; a call to action.
- **Use when:** marketing and sales copy with a conversion goal.

### TAG — Task · Action · Goal  *(minor)*
- **Slots:** the task definition; the concrete actions to take; the end goal/
  success state.
- **Use when:** a goal that decomposes into explicit, ordered action steps,
  with no persona or constraints worth spelling out; the lightweight RISEN.

### CIDI — Context · Instruction · Detail · Input  *(minor)*
- **Slots:** background; the instruction; supporting detail/constraints; the
  specific input data to operate on.
- **Use when:** context-heavy information tasks where the model must work over
  supplied input.

### 5W3H — Who · What · When · Where · Why · How · How much · How many  *(minor)*
- **Slots:** a checklist of interrogatives.
- **Use when:** requirements gathering or specs where completeness matters more
  than a fixed shape; useful as a gap-finding checklist even when another
  framework is chosen.

## Selection scoring

Route on the task's **shape** (how much context, what input, what kind of
output), never on its **domain**: in a coding agent nearly every request is
about code, so "it is technical" scores nothing.

**Prompt chain first.** A genuinely large/complex task with multiple dependent
stages is not scored: decompose it into a **prompt chain** (sequence of smaller
refined prompts) and score each smaller prompt on its own.
*Build a whole app; a rewrite spanning several subsystems.*

**Then score every framework below** against the request: **0** when its
signal is absent, **1** when it is present, **2** when it defines the task.
The highest score wins. On a tie, choose the framework with fewer slots. When
every score is 0, use **RACE**. List order carries no priority.

- **RTF** — quick, single-step ask, almost no context needed.
  *Rename a symbol, explain a regex, a one-line command.*
- **AIDA** (conversion) or **BAB** (problem→solution) — persuasive / marketing copy.
  *Landing-page copy; pitching a tool or change to a team.*
- **CO-STAR** — output where style, tone, and audience are central.
  *Release notes, a blog post, docs or an announcement for a named audience.*
- **CRISPE** — creative / open-ended / want multiple options.
  *Name ideas, alternative designs with trade-offs, brainstorming.*
- **RISEN** — ordered steps AND a defined end state AND explicit constraints
  that narrow scope (what must not change, limits to respect).
  *A zero-downtime database migration; an upgrade that must not touch one module.*
- **TAG** — goal that breaks into explicit ordered steps, nothing to narrow.
  *CI or environment setup, a release checklist.*
- **CIDI** — work over supplied input (logs, stack trace, diff, file, data, notes).
  *Fix this failing test, review this diff, summarize these notes.*
- **RACE** — default when every other score is 0; not scored itself.
  *Implement a feature, refactor a module, investigate a problem.*

*Example:* "brainstorm three fixes for this crash" with a 200-line stack trace
pasted in → CIDI 2 (the trace is most of the request), CRISPE 1 (several
options wanted), the rest 0 → **CIDI**.

An exact output format is not a scoring signal: pick the framework by shape,
then add few-shot examples (see the add-on layer below). Use **5W3H** as a
checklist to find missing information regardless of the framework chosen.

## Reasoning add-on layer (orthogonal — apply only on demand)

Modern reasoning models favor clarity and structure over heavy reasoning
scaffolding. Reach for these only when the task genuinely calls for it:

- **Few-shot examples** — when the output must match a strict format; include
  one to three input→output pairs in an `<examples>` tag.
- **Step-by-step (chain-of-thought)** — only for genuinely hard multi-step
  reasoning. If the model has a native reasoning/thinking mode, prefer enabling
  that over prompt tricks. Skip for simple tasks; it adds noise.
- **Retrieval / sources (RAG)** — for fact-heavy or current-events tasks: supply
  or request sources and instruct the model to say when it does not know rather
  than fabricate.
- **Self-consistency / Tree-of-Thoughts** — rarely needed in an interactive
  session; reserve for high-stakes reasoning where sampling multiple paths or
  branching-and-backtracking is worth the cost.

## Worked example

**Rough prompt:** `write me something about dogs`

**Step 2 — score:** a content piece where audience and tone matter → CO-STAR 2,
CRISPE 1 (open-ended), the rest 0 → **CO-STAR**.
Announce: "CO-STAR 2 · CRISPE 1 — audience and tone matter most."

**Step 3 — diagnose gaps:** Context, Objective, Style, Tone, Audience, Response
are all unspecified. Topic ("dogs") is the only fixed input.

**Step 4 — interview (one AskUserQuestion batch of 4):**
- Objective → "Educate new owners" / "Persuade adoption" / "Entertain".
- Audience → "First-time dog owners" / "Kids" / "Vets".
- Tone & style → "Warm and friendly" / "Authoritative" / "Playful".
- Response format & length → "~300-word blog post" / "Bulleted tips" / "Tweet thread".

**Step 5 — assemble:**

```xml
<role>You are an experienced pet-care writer.</role>
<context>The reader is a first-time dog owner who just brought home a puppy and feels overwhelmed.</context>
<objective>Educate them on the three things that matter most in the first week.</objective>
<instructions>
- Cover feeding, vet/first-checkup, and a settling-in routine.
- Lead with reassurance; keep advice concrete and actionable.
</instructions>
<constraints>Avoid jargon. No medical dosing advice — defer to a vet.</constraints>
<output_format>A warm, friendly ~300-word blog post with a short intro and three labeled tips.</output_format>
<success_criteria>A new owner could act on every tip immediately without further research.</success_criteria>
```

**Step 6 — confirm**, then **step 7 — execute** the prompt in this session.
