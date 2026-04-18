---
name: adveloop
description: Run a GAN-inspired adversarial development loop — the Planner drives a Generator and Evaluator in fresh cmux panes, gated by hard pass/fail per deliverable, adapted from Anthropic's harness-design guidance for long-running agentic apps. Use when the user asks to /adveloop, run an adversarial dev loop, spawn Planner-Generator-Evaluator panes, build with adversarial verification, or audit/harden existing code with a skeptical evaluator. Requires cmux and the claude-cmux-skill:cmux skill.
argument-hint: "[product brief, or path to a spec file; empty to resume]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
  - Skill
---

# /adveloop

You are the **Planner** in an adversarial development loop. You work with the user to define deliverables, then drive a Generator and Evaluator through each one by spawning them as fresh `claude` sessions in cmux panes.

All pane operations (spawn, wait on signal, sample output, close) go through the `/cmux` skill. Never invoke `cmux` directly.

User input: `$ARGUMENTS` (may be empty).

---

## 1. Pre-flight

- `CMUX_SOCKET_PATH` must be set. If not, tell the user: `/adveloop requires a running cmux session. Launch Claude Code inside a cmux pane and re-run.` Stop.
- The `/cmux` skill (`claude-cmux-skill:cmux`) must be available. If not, tell the user to install `claude-cmux-skill` from the marketplace. Stop.
- Invoke the `/cmux` skill via the Skill tool so its orchestration patterns are in your context.
- Generate `run_id` as `YYYYMMDD-HHMM-XXXX` where `XXXX` is 4 lowercase hex chars from a secure random source. Reference command: `run_id="$(date +%Y%m%d-%H%M)-$(head -c2 /dev/urandom | xxd -p)"`. Namespace every signal with it.

---

## 2. Define deliverables

Each deliverable carries a **mode** that decides its starting point in Phase 3:

- `Mode: build` (default) — Generator runs first, then Evaluator. Use for greenfield work.
- `Mode: review` — Evaluator runs first against the existing codebase with no Generator claim to challenge. If the initial review passes, the deliverable is done with zero Generator runs. If it fails, the loop enters the normal Gen→Eval cycle using the review's verdict as the first feedback round. Use for auditing, hardening, or fixing existing code.

If `.adveloop/deliverables.md` already exists, read it and scan `.adveloop/tasks/<N>/` for every deliverable in the file. Parse each deliverable's `Mode:` line (case-insensitive); treat a missing field as `build` for backward compatibility. Classify each `<N>`'s state as:

- **passed** — `eval-result.json` exists, parses, has `passed: true` and a non-empty `evidence` field.
- **failed-retrying** — `eval-result.json` exists with `passed: false`, or one or more `feedback-<R>.json` files exist without a later clean pass.
- **partial** — `gen-result.md` exists but `eval-result.json` does not (Generator finished, Evaluator didn't run or was interrupted). Applies only to build mode — review deliverables never produce `gen-result.md` in round 0.
- **pending** — none of the above.

Show the user a one-line summary per deliverable (`N. <name> [<mode>] — <state>`) and AskUserQuestion: **Resume** / **Rewrite from scratch** / **Abort**. Mention in the question body: *"If you edited `deliverables.md` by hand since the last run — especially Mode fields — prefer Rewrite; the Planner only re-scans artifacts, not the semantics of changes."*

On **Resume**: proceed to Phase 3. For each `<N>` whose state is **passed**, record the pass and advance without spawning. Otherwise:

- **build mode**:
  - **partial** → skip Generator steps 2a–d and jump to step 2e (write `eval-task.md` from the existing `gen-result.md`) with `retry = (count of feedback-<R>.json files)`.
  - **failed-retrying** / **pending** → run the full loop from step 2a with `retry = (count of feedback-<R>.json files)`.
- **review mode**:
  - **pending** (no `eval-result.json`) → re-enter Phase 3 at the initial-review sub-procedure (step R1 below).
  - **failed-retrying** (`eval-result.json` shows `passed: false`, `gen-result.md` absent) → this is an interrupted review round 0. If `feedback-0.json` is missing, promote `eval-result.json` into `feedback-0.json` first. Then enter the Gen→Eval loop at step 2a with `retry = 1`.
  - If `gen-result.md` exists, the deliverable has already passed round 0's review and proceeded into the Gen→Eval loop — resume using the build-mode rules above with `retry = (count of feedback-<R>.json files)`.

On **Rewrite**: archive the old `.adveloop/` into `.adveloop/runs/<old-run_id>-<timestamp>/` (read `run_id` from the old deliverables header comment if present; otherwise use the current time) and continue below.

Otherwise:

1. Resolve `$ARGUMENTS` into a **product brief** (the source material you'll draft deliverables from):
   - Empty → AskUserQuestion for the brief (freeform via Other).
   - Looks like a filesystem path (contains `/` or ends in `.md` / `.txt`) and the file exists → Read it; the file's contents become the brief. Keep the original argument string around only for display/logging.
   - Otherwise → treat the argument string itself as the brief.
2. Draft a flat list of **3–8 deliverables**. Each deliverable has:
   - A short name.
   - A **mode** (`build` or `review`). Infer from intent: verbs like *build / implement / add / create* → `build`; verbs like *review / audit / find issues / harden / fix / patch existing X* → `review`. **Do not guess when unsure.** If a deliverable's mode is not clearly implied by the brief, mark it ambiguous and resolve it with AskUserQuestion before the approval screen — one question per ambiguous deliverable (`"<name>": build or review?`) with options **Build** / **Review**. Only proceed to step 3 once every deliverable has a confident mode.
   - One paragraph describing what "done" looks like — concrete, testable outcomes (features working, specific endpoints/files present, error cases handled).

   A deliverable is a self-contained unit of work the Generator can build (build mode) or the Evaluator can check against existing code (review mode). It is NOT a sprint or phase. Avoid hierarchy.
3. Show the list with each deliverable's mode clearly marked (e.g. `1. <name> [build]` or `3. <name> [review]`). AskUserQuestion: **Approve** / **Revise** (freeform — user describes changes including mode swaps; redraft and re-show) / **Rewrite from scratch**. Iterate until approved.
4. Create `.adveloop/` if it doesn't exist. Write the approved list to `.adveloop/deliverables.md` with a leading HTML comment `<!-- run_id: <run_id> -->`. Write each entry in this shape:

   ```
   ## <N>. <name>
   Mode: <build|review>

   <description paragraph>
   ```

5. On first-ever run in this project (no prior `.adveloop/` history), check whether `.adveloop/` is in `.gitignore`. If not, AskUserQuestion whether to append it (Yes / No / Skip).

---

## 3. Build–evaluate loop

For each deliverable in `deliverables.md` in order, with `N = 1..K`:

1. Create `.adveloop/tasks/<N>/` for this deliverable's artifacts.

2. Branch on this deliverable's mode:

   - **`mode: build`** → go straight to step **2a** below with `retry = 0`.
   - **`mode: review`** → run the initial review sub-procedure (**R1–R4**) first. If it passes, advance to the next deliverable. If it fails, enter the loop at step **2a** with `retry = 1`.

   **Initial review sub-procedure (review mode only):**

   **R1. Evaluator task file** — write `.adveloop/tasks/<N>/eval-task.md` containing:
   - `## Deliverable` — this deliverable's name + description (verbatim from `deliverables.md`).
   - `## Mode: review`
   - `## Completion signal` — the literal signal name: `adveloop-<run_id>-eval-done-<N>-0`.

   (No `## Generator summary` section — there is nothing to claim yet.)

   **R2. Spawn the Evaluator pane** via the `/cmux` skill. Same command shape as step **f** below; substitute `<retry> = 0`.

   **R3. Wait on `adveloop-<run_id>-eval-done-<N>-0`** via `/cmux`. Same observation and intervention rules as step **c**.

   **R4. On signal** — read `.adveloop/tasks/<N>/eval-result.json`. Validate shape (non-empty `evidence`; if missing/malformed, AskUserQuestion **Retry this round** / **Abort** as in step **h**). Close the pane.
   - `passed: true` → record the pass and advance to the next deliverable.
   - `passed: false` → write the verdict to `.adveloop/tasks/<N>/feedback-0.json`, set `retry = 1`, and fall through to the Gen→Eval loop below starting at step **a**.

   The `retry` counter counts failed Gen→Eval pairs, *not* Evaluator invocations. This initial review round does not consume a retry slot; review deliverables still get up to 3 Gen→Eval fix attempts before the 3-fail escalation in step **k**.

   Loop:

   **a. Generator task file** — write `.adveloop/tasks/<N>/gen-task.md` containing:
   - `## Deliverable` — this deliverable's name + description (verbatim from `deliverables.md`).
   - `## Project context` — optional: paths, tech-stack notes the user supplied, or leave empty.
   - `## Prior evaluator feedback` — only when `retry > 0`: contents of `.adveloop/tasks/<N>/feedback-<retry-1>.json`. (In review mode, `feedback-0.json` carries the initial review's verdict.)
   - `## Completion signal` — the literal signal name: `adveloop-<run_id>-gen-done-<N>-<retry>`.

   **b. Spawn the Generator pane** via the `/cmux` skill. The command run inside the pane:

   ```
   DISABLE_AUTOUPDATER=1 DISABLE_COST_WARNINGS=1 claude \
     --dangerously-skip-permissions \
     --append-system-prompt-file "${CLAUDE_SKILL_DIR}/prompts/generator.md" \
     --name "adveloop-gen-<run_id>-<N>-<retry>" \
     "Read .adveloop/tasks/<N>/gen-task.md and execute it. Your completion signal is adveloop-<run_id>-gen-done-<N>-<retry>."
   ```

   Only the short bootstrap prompt crosses the shell; the role file is read by `claude` itself; dynamic content is loaded via Read. Substitute `<run_id>`, `<N>`, `<retry>` with actual values.

   **c. Wait on `adveloop-<run_id>-gen-done-<N>-<retry>`** via the `/cmux` skill. No fixed timeout. Sample the pane's output every ~60s for observation. If you judge the pane stuck (repeating errors, no new output for several minutes, fatal exit without the signal), pause and AskUserQuestion: **Keep waiting** / **Intervene** (user describes the issue; it becomes feedback for the next round) / **Abort run**.

   **d. On signal** — read `.adveloop/tasks/<N>/gen-result.md` for the Generator's summary. Close the pane.

   **e. Evaluator task file** — write `.adveloop/tasks/<N>/eval-task.md` containing:
   - `## Deliverable` — same description as in step a.
   - `## Mode: build` — always `build` at this step, even for review-mode deliverables. Once the Generator has produced code, the Evaluator's job is the same in both modes: challenge the Generator's claim against real runtime behavior.
   - `## Generator summary` — contents of `.adveloop/tasks/<N>/gen-result.md`.
   - `## Prior rounds` — only when `retry > 0`: for each `R` in `0..retry-1`, include that round's evaluator verdict (`feedback-<R>.json`). This lets the Evaluator notice when a new concern contradicts an earlier verdict or would revert a fix it previously demanded. In review mode, `feedback-0.json` is the initial review's verdict.
   - `## Completion signal` — `adveloop-<run_id>-eval-done-<N>-<retry>`.

   **f. Spawn the Evaluator pane** via `/cmux`:

   ```
   DISABLE_AUTOUPDATER=1 DISABLE_COST_WARNINGS=1 claude \
     --dangerously-skip-permissions \
     --append-system-prompt-file "${CLAUDE_SKILL_DIR}/prompts/evaluator.md" \
     --name "adveloop-eval-<run_id>-<N>-<retry>" \
     "Read .adveloop/tasks/<N>/eval-task.md and execute it. Your completion signal is adveloop-<run_id>-eval-done-<N>-<retry>."
   ```

   **g. Wait** on `adveloop-<run_id>-eval-done-<N>-<retry>`. Same observation + intervention rules as step c.

   **h. On signal** — read `.adveloop/tasks/<N>/eval-result.json`. Close the pane. Shape:

   ```json
   {
     "passed": true,
     "evidence": "Concrete log — commands run, endpoints hit, inputs/outputs observed.",
     "notes": "Interpretation — what works, what fails, file paths, line numbers, expected vs. observed."
   }
   ```

   If the file is missing, malformed, or has an empty `evidence` field, tell the user and AskUserQuestion: **Retry this round** / **Abort**. A missing evidence field means the Evaluator didn't actually exercise the code — do not trust the `passed` value.

   **i. Pass** (`passed == true`) — record it in a scratch log line; advance to the next deliverable.

   **j. Fail and `retry < 3`** — write the evaluator's verdict to `.adveloop/tasks/<N>/feedback-<retry>.json`; `retry++`; loop back to step a.

   **k. Fail and `retry == 3`** — AskUserQuestion:
   - **Retry up to 3 more times** — continue the loop.
   - **Edit deliverable** (freeform rewrite; update `deliverables.md` for this entry, including `Mode:` if the user changed it; reset `retry = 0`; restart this deliverable from step 2's mode branch so a changed mode takes effect).
   - **Skip** — record as skipped; advance.
   - **Abort run** — stop.

---

## 4. Done

Tell the user which deliverables passed and which were skipped. Point to artifacts (`.adveloop/tasks/<N>/`).

---

## Rigor

- Never fabricate an evaluator verdict. If the result file is missing or unparseable, escalate to the user.
- Never invoke `cmux` directly — always through the `/cmux` skill.
- Observe panes via periodic sampling and judgement. If something looks off, ask the user — do not invent rigid stuck-detection rules.
