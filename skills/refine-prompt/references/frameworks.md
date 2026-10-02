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

### RISEN — Role · Instruction · Structure · Examples · Nuance
- **Slots:** persona; the instruction; required structure/sections; worked
  examples; edge cases, constraints, and caveats.
- **Use when:** precise, technical, code, or repeatable prompts that must be
  reproducible.

### CO-STAR — Context · Objective · Style · Tone · Audience · Response
- **Slots:** situation/background; the goal; writing style; emotional tone;
  intended audience; output format and length.
- **Use when:** content where voice, tone, and audience calibration matter as
  much as the message (marketing, brand copy, comms, system-prompt design).

### CRISPE — Capacity/Role · Insight · Statement · Personality · Experiment
- **Slots:** capability/role; the core insight to surface; the framed request;
  tone/personality; room to explore multiple variations.
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
- **Use when:** a goal that decomposes into explicit, ordered action steps.

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

## Selection decision tree

1. Quick, single-step ask, almost no context needed → **RTF**.
2. Persuasive / marketing copy → **AIDA** (conversion) or **BAB** (problem→solution).
3. Output where style, tone, and audience are central → **CO-STAR**.
4. Creative / open-ended / want multiple options → **CRISPE**.
5. Precise, technical, code, or must-be-repeatable → **RISEN**.
6. Goal that breaks into explicit ordered steps → **TAG**.
7. Heavy supplied input/context to operate over → **CIDI**.
8. Genuinely large/complex, multiple dependent stages → decompose into a
   **prompt chain** (sequence of smaller refined prompts).
9. Anything else / general professional task → **RACE** (default).

When two frameworks fit, choose the one with fewer slots. Use **5W3H** as a
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

**Step 2 — classify:** content piece where audience and tone matter → **CO-STAR**.
Announce: "Using the CO-STAR framework for this."

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
