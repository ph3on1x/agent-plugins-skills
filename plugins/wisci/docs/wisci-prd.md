# WISCI: LLM Context Engineering Framework

## Product Requirements Document

Version: 1.1
Date: 2026-03-21

---

## 1. Overview

WISCI is a context engineering framework for Claude Code, implemented as four slash commands that give developers explicit control over how information flows in and out of the LLM context window.

The name encodes both the strategies and the philosophy:

| Letter | Command | Strategy |
|--------|---------|----------|
| **W** | `/write` | Externalize context to persistent files |
| **I** | `/isolate` | Delegate research to subagents with isolated context windows |
| **S** | `/select` | Retrieve relevant context into the current window |
| **C** | `/compress` | Create compressed handoffs for session transitions |
| **I** | *Iterate* | The philosophy of using W-I-S-C in cycles, not a command |

### Design Principles

1. **Arguments-first** — Every command accepts natural language `$ARGUMENTS` that describe intent. The command interprets and acts autonomously.
2. **Lossless by default** — Specific facts, file paths, numbers, error codes, and decisions are never silently dropped.
3. **Loosely coupled** — Commands share the `context/` directory convention but have no hard dependencies on each other. The user orchestrates the workflow.
4. **Subagents for heavy lifting** — Exploration and research happen in subagent context windows. The main agent context stays clean.

### Why Proactive Context Management

LLM context windows are finite resources with diminishing returns. Research consistently shows that more context does not mean better results — a clean, focused context on a weaker model outperforms a cluttered context on a stronger model (Chroma Research). Performance degrades well before the window is full: context quality drops significantly past 40% utilization (Dex Horthy, HumanLayer), and even a single irrelevant document causes step-function degradation in accuracy (Stanford "Lost in the Middle"). Claude Code's auto-compact triggers at 95% capacity — but by then, the context has been operating in a degraded state for most of the session. WISCI exists to give developers control over this proactively, not reactively.

### Theoretical Foundation

WISCI implements Lance Martin's Write/Select/Compress/Isolate taxonomy (LangChain, June 2025) as practical developer tools. It is inspired by Cole Medin's WISC framework but is an independent reimagining with a different philosophy: argument-driven commands over rigid workflows, and explicit user control over automated triggers.

---

## 2. Storage: The `context/` Directory

All WISCI commands that produce files write to a `context/` directory at the project root. The name is intentionally simple and meaningful to any coding agent or human reader.

```
project-root/
  context/
    auth-research.md                # from /write
    payment-integration.md          # from /write
    handoff.md                      # from /compress
    handoff-api-migration.md        # from /compress
  src/
  ...
```

### File Naming

Files in `context/` are named by topic, not by date. Git history serves as the changelog for when files were created and modified.

**Naming convention:**

- Kebab-case descriptive names: `auth-research.md`, `payment-integration.md`
- Handoffs use a `handoff-` prefix: `handoff.md`, `handoff-auth-module.md`
- No date prefixes — the content and structure make the origin clear

**Slug inference rules:**

The command derives a filename slug from `$ARGUMENTS` using these steps:

1. Extract the core topic noun phrase from the arguments (strip filler phrases like "results on", "notes about", "current state of")
2. Convert to kebab-case, lowercase
3. Truncate to a maximum of 5 words
4. Before creating a new file, check `context/` for existing files whose slug overlaps significantly (e.g., `auth-research.md` exists and the user runs `/write auth research notes`)
5. If a near-match is found, treat it as the same topic and merge into the existing file — do not create a new file
6. If ambiguous (multiple near-matches), list the candidates and ask the user which file to update or whether to create a new one

### .gitignore Consideration

The `context/` directory should generally be git-tracked (it contains project knowledge), but users may choose to gitignore certain files. This is a per-project decision, not enforced by the framework.

---

## 3. Command: `/write`

### Purpose

Externalize information from the current context window into a structured, persistent markdown file. `/write` is the "save to disk" operation — it preserves knowledge that would otherwise be lost to context limits or session endings.

### When to Use

- After `/isolate` returns research results you want to preserve across sessions
- When you've made key decisions or discoveries during a session
- Before context gets heavy, to offload information proactively
- To capture the current state of work for future reference

### Invocation

```
/write <description of what to externalize>
```

**Arguments are required.** The description tells `/write` what to extract from the current context and how to name the output file.

### Behavior

1. Parse `$ARGUMENTS` to understand what information the user wants externalized
2. Derive a topic slug from the arguments using the slug inference rules (Section 2)
3. Check `context/` for an existing file matching the topic
4. **If no existing file:** extract and structure the information into a new markdown document, write to `context/<topic-slug>.md`
5. **If existing file found:** perform an intelligent merge (see Merge Behavior below)
6. Confirm to the user: what was written or updated, where, and a brief summary

### Merge Behavior

When a topic file already exists, `/write` performs a three-step merge:

1. **Read** the existing file from `context/`
2. **Compare** existing content against new information from the current context window, classifying each piece as:
   - **Still valid** — information that hasn't changed or been contradicted
   - **Updated** — information that has a newer, more accurate version
   - **Contradicted** — information now known to be wrong
   - **New** — information not present in the existing file
3. **Produce** a merged document that preserves valid content, replaces updated/contradicted content, and integrates new content in the appropriate sections

**Merge principles:**

- **Merge is not append.** The file should not grow unboundedly. If new research supersedes old research, the old content is replaced. Git preserves history.
- **The `## References` manifest is rebuilt from scratch** on every write — it reflects the current state of the file, not accumulated history.
- **Preservation rules still apply.** Content is only removed when newer information explicitly supersedes it.

### Output Format

```markdown
# <Title inferred from arguments>

> Last updated by /write on YYYY-MM-DD HH:MM
> Source: <what session context this was extracted from>

## Summary
<2-3 sentence overview of what this document contains>

## <Section 1>
<Structured content with all specifics preserved>

## <Section N>
...

## Key Details
- **Decisions**: <every decision made with rationale>
- **Open questions**: <anything unresolved>

## References
- `src/auth/middleware.ts` — auth middleware, token validation logic
- `src/auth/session.ts:42` — session expiry configuration
- `src/models/user.ts` — User model, referenced for role fields
```

The `## References` section is always the last section in the file. Each reference includes a brief annotation of why it's referenced. This manifest enables staleness detection by `/select` (see Section 5).

### Preservation Rules

`/write` must preserve the following without summarization or omission:

- Exact file paths and line numbers
- Error messages and error codes
- Numeric values, measurements, benchmarks
- Command outputs and their results
- Decisions and the reasoning behind them
- Names of functions, classes, variables, and modules
- URLs and references
- Sequences of steps taken and their outcomes

### Examples

```
/write research results on VisionTS architecture
# -> context/visiont-architecture-research.md (new file)

/write decisions from today's API redesign discussion
# -> context/api-redesign-decisions.md (new file)

/write updated auth module findings
# -> context/auth-module-findings.md (merges into existing file if it exists)
```

---

## 4. Command: `/isolate`

### Purpose

Delegate research and exploration tasks to subagents that operate in their own isolated context windows. The main agent's context stays clean while subagents do the heavy lifting — reading files, searching code, exploring documentation, and synthesizing findings.

### When to Use

- Exploring an unfamiliar codebase or library
- Researching a topic that requires reading many files
- Investigating a bug across multiple code paths
- Comparing approaches or gathering information from multiple sources
- Any task where the exploration process would pollute the main context

### Invocation

```
/isolate <task description>
```

**Arguments are required.** The description defines the research scope.

### Behavior

1. Parse `$ARGUMENTS` to understand the research task
2. **Autonomously plan** the subagent decomposition:
   - How many subagents are needed (1-5, based on task scope)
   - What each subagent should investigate
   - What reporting format each subagent should use (tailored to their specific subtask)
3. Spawn subagents in parallel, each with:
   - A focused task description
   - Appropriate tools for their subtask
   - A defined output format
4. Collect subagent results
5. Synthesize into a structured inline summary in the main agent's context
6. Present the synthesized findings to the user

### Subagent Planning

The command decides autonomously. It does not present the plan for approval — it executes directly. The planning considers:

- **Task decomposability**: Can the research be split into independent subtasks?
- **Scope of each subtask**: Each subagent should have a focused, achievable goal
- **Reporting format**: Each subagent gets a tailored output template so results are consistent and meaningful

### Result Handling

Results appear **inline** in the main agent's context as a structured summary. This is not written to a file — it lives in the context window for immediate use.

If the user wants to persist the results, they follow up with `/write`.

### Output Format (Inline)

```markdown
## /isolate Results: <task summary>

### Agent 1: <subtask name>
<Structured findings>

### Agent 2: <subtask name>
<Structured findings>

### Synthesis
<Combined insights, patterns, contradictions, and recommendations>
```

### Examples

```
/isolate research how authentication works in this codebase
# Spawns 2-3 agents: one for auth middleware, one for user models, one for session management

/isolate compare React Query vs SWR for our data fetching needs
# Spawns 2 agents: one per library, each analyzing docs and community patterns

/isolate investigate why the payment webhook fails intermittently
# Spawns agents for: webhook handler code, recent git changes, error logs, external API docs
```

---

## 5. Command: `/select`

### Purpose

Load relevant context into the current window. `/select` is the "load from disk" operation — it retrieves exactly the information needed for the current task, whether that's a broad codebase overview or a targeted deep dive.

### When to Use

- Starting a new session and need to understand the project
- Switching to a different area of the codebase
- Needing specific knowledge before making changes
- Resuming work after a `/compress` handoff

### Invocation

```
/select [topic]
```

**Arguments are optional.** Behavior changes based on whether arguments are provided.

### Mode 1: No Arguments (Codebase Primer)

When invoked as bare `/select`, it produces a comprehensive codebase overview similar to Cole Medin's `/prime` command.

**Behavior:**

1. Analyze the project structure (directories, key files, configs)
2. Identify the tech stack (languages, frameworks, dependencies)
3. Read key configuration files (package.json, tsconfig, etc.)
4. Check for project documentation (README, CLAUDE.md, docs/)
5. Inspect recent git history for active areas of development
6. Check `context/` directory for existing WISCI artifacts
7. **Run staleness detection** on all context files (see Staleness Detection below)
8. Present a structured overview to the main agent

**Output format:**

```markdown
## Project Overview

### Structure
<Directory tree with annotations>

### Tech Stack
<Languages, frameworks, key dependencies>

### Conventions
<Coding patterns, naming conventions, architecture style>

### Recent Activity
<What's been worked on recently, based on git>

### Available Context
- auth-research.md          fresh
- payment-integration.md    stale (src/payments/webhook.ts changed 2 days ago)
- handoff.md                broken (src/old-module.ts no longer exists)
```

### Mode 2: With Arguments (Targeted Exploration)

When invoked with arguments, `/select` performs a targeted deep exploration of the specified topic.

**Behavior:**

1. Parse `$ARGUMENTS` to understand what context is needed
2. Plan an exploration strategy across multiple sources:
   - Project files and code (grep, glob, file reading)
   - Git history (recent changes, blame, relevant commits)
   - Documentation (README, docs/, inline comments)
   - `context/` directory (previously written WISCI artifacts)
3. **Run staleness detection** on any matching context files before loading them (see Staleness Detection below)
4. **May spawn subagents** for exploration to avoid polluting the main context window
5. Synthesize findings into a rich, relevant context block
6. Present in the main agent's context

**Output format:**

```markdown
## Selected Context: <topic>

### Relevant Code
<Key files, functions, and their relationships>

### History
<Relevant git changes and their context>

### Documentation
<Related docs, comments, or previously written context>

### Summary
<How these pieces fit together for the current task>
```

### Examples

```
/select
# -> Full codebase overview (primer mode)

/select authentication flow
# -> Deep dive into auth: middleware, models, routes, recent changes, related docs

/select recent changes to the payment module
# -> Git history, diff summaries, related context/ files about payments

/select research results from VisionTS exploration
# -> Finds and loads context/visiont-architecture-research.md plus related code
```

### Staleness Detection

Every time `/select` loads context files, it validates them against the current state of the codebase. This prevents context poisoning — the failure mode where outdated information in a context file leads to incorrect assumptions and wasted work.

**Step 1 — Build the reference set:**

- Parse the `## References` manifest at the bottom of each context file (explicit tracking)
- Scan the file body for additional file paths (implicit scanning)
- **Implicit scanning filters:** Only match paths that look like project-relative file paths (contain `/` and a file extension, e.g., `src/auth/middleware.ts`). Ignore standard library references, dependency names, and common programming terms. When in doubt, only trust the explicit `## References` manifest.
- Deduplicate into a single set of referenced file paths

**Step 2 — Check git:**

- **Canonical timestamp:** Use `git log -1 --format=%aI -- <context-file>` to get the last commit date of the context file. This is the authoritative "last updated" time. If the context file is not git-tracked, fall back to filesystem mtime with a warning: "This context file is not tracked by git — staleness check may be unreliable."
- For each referenced path, check `git log --since=<timestamp> -- <path>`
- Check whether referenced file paths still exist on disk

**Step 3 — Classify:**

Staleness detection operates at the **file level only** — it checks whether referenced files have changed or been deleted. It does not verify whether specific functions or classes within those files still exist.

| Status | Meaning | Criteria |
|--------|---------|----------|
| **Fresh** | Safe to load | No referenced files have changed since the context file was last committed |
| **Stale** | Load with caution | Referenced files have changed — report lists which files changed and when |
| **Broken** | Do not trust | One or more referenced files no longer exist on disk |

**Step 4 — Report and recommend:**

In bare `/select`, the staleness report is part of the "Available Context" listing (see output format above).

In targeted `/select topic`, the report appears before content is loaded:

- **Stale:** "This file references code that has changed. Consider `/write <topic>` to refresh it, or `/isolate` to re-research."
- **Broken:** "This file references code that no longer exists. It should be refreshed with `/write` or deleted."

**The user decides.** `/select` never silently loads a stale file, and never refuses to load one. It reports and recommends, then the user chooses how to proceed.

---

## 6. Command: `/compress`

### Purpose

Create a compressed handoff document that captures everything needed to continue the current work in a fresh session. `/compress` is the session transition tool — it distills a session's work into a narrative optimized for resuming, not for archival.

### When to Use

- Context window is getting heavy and you want to start fresh
- Ending a work session and planning to continue later
- Handing off work to a different session or colleague
- Before a known auto-compact would trigger, to control what's preserved

### Invocation

```
/compress [scope]
```

**Arguments are optional.** No args = full session. With args = focused compression of a specific work stream.

### Behavior

1. If `$ARGUMENTS` provided, scope the compression to the specified work stream
2. If no arguments, compress the entire current session
3. Derive a topic slug from the arguments (if provided) using the slug inference rules (Section 2), prefixed with `handoff-`
4. Check `context/` for an existing handoff file matching the scope
5. Analyze the session context to extract:
   - What was the goal
   - What was accomplished
   - What decisions were made and why
   - What's currently in progress
   - What needs to happen next
   - What blockers or open questions exist
6. **If no existing handoff:** write a new compressed handoff document to `context/`
7. **If existing handoff found:** perform an intelligent merge — the "Completed" section grows, "In Progress" and "Next Steps" are replaced with current state, stale decisions are updated, and the `## References` section is rebuilt
8. Suggest the user start a fresh session and use `/select` to reload

### Difference from `/write`

| Aspect | `/write` | `/compress` |
|--------|----------|-------------|
| **Purpose** | Preserve knowledge artifacts | Enable session transitions |
| **Format** | Structured reference document | Condensed resumption narrative |
| **Optimization** | Lossless fact preservation | Quick context rebuilding |
| **Typical use** | "Save these research results" | "I need to continue this later" |
| **Reading style** | Reference material (look up specific facts) | Sequential briefing (read top-to-bottom to get up to speed) |

### Preservation Rules

`/compress` is intentionally lossy — it summarizes verbose exploration, dead ends, and tool outputs. However, it must preserve the following specifics that a fresh session would otherwise need to re-discover:

- File paths that were modified or are relevant to resuming work
- Decisions made and their rationale
- Error codes, error messages, and root causes identified
- Exact endpoints, API routes, or configuration values discovered
- Names of functions, classes, or modules that were changed or are next to change
- Blockers, open questions, and unresolved issues
- The current state of any in-progress work (what's done, what's not)

These are the high-value tokens that generic summarization tends to drop (e.g., reducing "the 401 error from `/api/auth/login` was caused by an expired Redis session store" to "configuration problems"). `/compress` must not make this mistake.

### Output Format

```markdown
# Handoff: <session/scope summary>

> Last updated by /compress on YYYY-MM-DD HH:MM

## Goal
<What we were trying to accomplish>

## Completed
<What was done, with specific details>
- <change 1: file path, what changed, why>
- <change 2: ...>

## In Progress
<What's partially done, current state>

## Decisions Made
- <Decision>: <rationale>

## Next Steps
1. <Immediate next action>
2. <Following action>
3. ...

## Blockers / Open Questions
- <Any unresolved issues>

## References
- `src/auth/middleware.ts` — modified, added token refresh logic
- `src/auth/session.ts:42` — session expiry config, relevant to next steps
- `src/models/user.ts` — User model, role fields referenced in auth decisions
```

The `## References` section replaces the previous `## Key Files` section. Each reference includes a brief annotation, enabling staleness detection by `/select` (see Section 5).

### File Naming

- No args: `context/handoff.md`
- With args: `context/handoff-<scope>.md` (e.g., `handoff-api-migration.md`)

Bare `/compress` updates `context/handoff.md` — there is no date-based escape hatch for multiple handoffs per day. This is intentional: the handoff file represents the current state of work, not a historical snapshot. If the user needs parallel handoffs for different work streams, they must scope them: `/compress auth module`, `/compress api migration`. Git history preserves prior handoff states.

### Examples

```
/compress
# -> context/handoff.md (creates or updates full session handoff)

/compress auth module refactoring
# -> context/handoff-auth-module-refactoring.md (creates or updates focused handoff)

/compress API migration work
# -> context/handoff-api-migration.md (creates or updates focused handoff)
```

---

## 7. The Iterate Philosophy

The "I" in WISCI stands for **Iterate** — but it's not a command. It's the principle that these four commands are used in cycles, not in isolation.

### The WISCI Cycle

```
/select  ->  work  ->  /isolate (as needed)  ->  /write (preserve)  ->  /compress (transition)
    ^                                                                           |
    |___________________________________________________________________________|
                            new session: /select to reload
```

A typical workflow:

1. **Start session**: `/select` to load relevant context (or `/select auth module` for targeted work)
2. **Research**: `/isolate "explore how the payment system integrates with Stripe"` when you need deep exploration
3. **Preserve**: `/write research results on Stripe integration` to save findings
4. **Work**: Implement changes using the loaded context
5. **Transition**: `/compress` when the session gets heavy or work is done for now
6. **Resume**: New session, `/select` to reload from the handoff and context files

### Why Iterate

The right optimization target for context management is tokens per task, not tokens per request. Waiting for auto-compact at 95% means the context has been operating in a degraded state for much of the session. Proactive cycling — writing, compressing, and reloading — keeps the context window in its effective range throughout the task, not just at the beginning.

### Iterate Means

- Each session builds on previous sessions through persistent `context/` files
- Knowledge compounds: `/write` artifacts become `/select` sources
- Sessions are disposable but knowledge is not
- The `context/` directory is the project's living knowledge base — topic files are updated in place, not accumulated chronologically

### Iteration Patterns

Iteration shows up in different forms during development. These are not prescriptions — they're vocabulary for recognizing what's happening:

- **Error recovery** — An attempt fails, the error is observed, and the approach is adjusted. Effective iteration preserves the error in context so the agent learns from it rather than repeating it.
- **Recitation** — Restating goals and current state to combat drift during long sessions. The act of reviewing what you're trying to do refocuses the context.
- **Reflection** — After completing a phase of work, stepping back to assess what worked, what didn't, and what to adjust before the next cycle.

---

## 8. Workflow Examples

### Example 1: Exploring a New Codebase

```
Session 1:
  /select                                    # Get codebase overview
  /isolate "research the data model and ORM patterns used in this project"
  /write research results on data model      # Persist findings
  /compress                                  # End session

Session 2:
  /select data model                         # Reload relevant context
  # Start implementing changes...
```

### Example 2: Bug Investigation

```
  /select recent changes to checkout flow
  /isolate "investigate why checkout fails for guest users - check error logs, recent commits, and the checkout handler code"
  # /isolate returns findings inline
  /write checkout bug investigation findings
  # Fix the bug using the context
  /compress checkout bug fix                 # Handoff if needed
```

### Example 3: Feature Development Across Sessions

```
Session 1 (Research):
  /select
  /isolate "research best practices for implementing WebSocket support in our Express app"
  /write WebSocket research and recommendations
  /compress WebSocket feature research

Session 2 (Planning):
  /select WebSocket research and recommendations
  # Plan implementation based on research
  /write WebSocket implementation plan
  /compress

Session 3 (Implementation):
  /select WebSocket implementation plan
  # Implement the feature
  /compress WebSocket implementation progress

Session 4 (Completion):
  /select WebSocket implementation progress
  # Finish implementation, run tests
  /write WebSocket feature documentation
```

---

## 9. Non-Goals

These are explicitly out of scope for WISCI v1:

- **Automatic triggers** — All commands are manually invoked. No hooks, no auto-triggers.
- **Cross-project context** — `context/` is per-project. No global knowledge base.
- **Integration with external tools** — No MCP servers, no database backends. Files only.
- **Command chaining** — Commands don't call each other. User orchestrates the workflow.
- **Custom templates** — Output formats are defined by the framework, not configurable by users.
- **Context window monitoring** — No built-in token counting or threshold alerts.

---

## 10. Future Considerations (Post-v1)

These may be explored after the initial implementation proves useful:

- **`/iterate` command** — Formalize the feedback loop (execute, observe, reflect, refine) as an explicit command
- **Symbol-level staleness detection** — Extend staleness checks beyond file-level to verify whether specific functions, classes, or modules referenced in context files still exist
- **Hooks integration** — Auto-suggest `/compress` when context reaches a threshold
- **Cross-project patterns** — Share context engineering patterns across projects
- **Team workflows** — Shared `context/` conventions for teams
