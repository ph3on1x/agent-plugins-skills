---
description: Adversarial dev loop — Planner + Generator + Evaluator in cmux panes
argument-hint: [short product description, or empty to resume]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Skill
model: inherit
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

If `.adveloop/deliverables.md` already exists, read it and scan `.adveloop/tasks/<N>/` for every deliverable in the file. For each `<N>`, classify its state as:

- **passed** — `eval-result.json` exists, parses, has `passed: true` and a non-empty `evidence` field.
- **failed-retrying** — `eval-result.json` exists with `passed: false`, or one or more `feedback-<R>.json` files exist without a later clean pass.
- **partial** — `gen-result.md` exists but `eval-result.json` does not (Generator finished, Evaluator didn't run or was interrupted).
- **pending** — none of the above.

Show the user a one-line summary per deliverable (`N. <name> — <state>`) and AskUserQuestion: **Resume** / **Rewrite from scratch** / **Abort**.

On **Resume**: proceed to Phase 3. For each `<N>` whose state is **passed**, record the pass and advance without spawning. For **partial**, skip Generator steps 2a–d and jump to step 2e (write `eval-task.md` from the existing `gen-result.md`) with `retry = (count of feedback-<R>.json files)`. For **failed-retrying** and **pending**, run the full loop from step 2a with `retry = (count of feedback-<R>.json files)`.

On **Rewrite**: archive the old `.adveloop/` into `.adveloop/runs/<old-run_id>-<timestamp>/` (read `run_id` from the old deliverables header comment if present; otherwise use the current time) and continue below.

Otherwise:

1. If `$ARGUMENTS` is empty, AskUserQuestion for the product description (freeform via Other).
2. Draft a flat list of **3–8 deliverables**. Each deliverable has:
   - A short name.
   - One paragraph describing what "done" looks like — concrete, testable outcomes (features working, specific endpoints/files present, error cases handled).

   A deliverable is a self-contained unit of work the Generator can build and the Evaluator can verify. It is NOT a sprint or phase. Avoid hierarchy.
3. Show the list. AskUserQuestion: **Approve** / **Revise** (freeform — user describes changes, you redraft and re-show) / **Rewrite from scratch**. Iterate until approved.
4. Create `.adveloop/` if it doesn't exist. Write the approved list to `.adveloop/deliverables.md` with a leading HTML comment `<!-- run_id: <run_id> -->`.
5. On first-ever run in this project (no prior `.adveloop/` history), check whether `.adveloop/` is in `.gitignore`. If not, AskUserQuestion whether to append it (Yes / No / Skip).

---

## 3. Build–evaluate loop

For each deliverable in `deliverables.md` in order, with `N = 1..K`:

1. Create `.adveloop/tasks/<N>/` for this deliverable's artifacts.

2. Initialize `retry = 0`. Loop:

   **a. Generator task file** — write `.adveloop/tasks/<N>/gen-task.md` containing:
   - `## Deliverable` — this deliverable's name + description (verbatim from `deliverables.md`).
   - `## Project context` — optional: paths, tech-stack notes the user supplied, or leave empty.
   - `## Prior evaluator feedback` — only when `retry > 0`: contents of `.adveloop/tasks/<N>/feedback-<retry-1>.json`.
   - `## Completion signal` — the literal signal name: `adveloop-<run_id>-gen-done-<N>-<retry>`.

   **b. Spawn the Generator pane** via the `/cmux` skill. The command run inside the pane:

   ```
   DISABLE_AUTOUPDATER=1 DISABLE_COST_WARNINGS=1 claude \
     --dangerously-skip-permissions \
     --append-system-prompt-file "${CLAUDE_PLUGIN_ROOT}/prompts/generator.md" \
     --name "adveloop-gen-<run_id>-<N>-<retry>" \
     "Read .adveloop/tasks/<N>/gen-task.md and execute it. Your completion signal is adveloop-<run_id>-gen-done-<N>-<retry>."
   ```

   Only the short bootstrap prompt crosses the shell; the role file is read by `claude` itself; dynamic content is loaded via Read. Substitute `<run_id>`, `<N>`, `<retry>` with actual values.

   **c. Wait on `adveloop-<run_id>-gen-done-<N>-<retry>`** via the `/cmux` skill. No fixed timeout. Sample the pane's output every ~60s for observation. If you judge the pane stuck (repeating errors, no new output for several minutes, fatal exit without the signal), pause and AskUserQuestion: **Keep waiting** / **Intervene** (user describes the issue; it becomes feedback for the next round) / **Abort run**.

   **d. On signal** — read `.adveloop/tasks/<N>/gen-result.md` for the Generator's summary. Close the pane.

   **e. Evaluator task file** — write `.adveloop/tasks/<N>/eval-task.md` containing:
   - `## Deliverable` — same description as in step a.
   - `## Generator summary` — contents of `.adveloop/tasks/<N>/gen-result.md`.
   - `## Prior rounds` — only when `retry > 0`: for each `R` in `0..retry-1`, include that round's evaluator verdict (`feedback-<R>.json`). This lets the Evaluator notice when a new concern contradicts an earlier verdict or would revert a fix it previously demanded.
   - `## Completion signal` — `adveloop-<run_id>-eval-done-<N>-<retry>`.

   **f. Spawn the Evaluator pane** via `/cmux`:

   ```
   DISABLE_AUTOUPDATER=1 DISABLE_COST_WARNINGS=1 claude \
     --dangerously-skip-permissions \
     --append-system-prompt-file "${CLAUDE_PLUGIN_ROOT}/prompts/evaluator.md" \
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
   - **Edit deliverable** (freeform rewrite; update `deliverables.md` for this entry; reset `retry = 0`; loop).
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
