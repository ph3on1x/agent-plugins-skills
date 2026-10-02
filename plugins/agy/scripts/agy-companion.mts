#!/usr/bin/env node
/**
 * agy-companion: runs Google Antigravity (`agy`) for Claude Code slash commands and hooks.
 *
 *   setup [--enable-review-gate|--disable-review-gate] [--json]
 *   review | adversarial-review  "[--base <ref>] [--scope auto|working-tree|branch] [--model m] [focus ...]"
 *   task [--write] [--model m] [--effort e] [--resume-last|--fresh] [--background] [--json] [prompt | stdin]
 *   status [job] [--wait] [--timeout-ms n] [--all] [--json]
 *   result [job] [--json]      cancel [job] [--json]      task-resume-candidate [--json]
 *   hook SessionStart|SessionEnd|Stop   (hook JSON on stdin)
 *
 * Requires Node.js 22.18+ (type stripping). Zero dependencies.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agyBin, checkAvailability, listModels, needsModelLookup, readOnlyBreach, resolveModelAlias, runAgyTurn, staleError, turnFailure,
  type Profile, type Progress, type TurnOutcome
} from "./lib/agy.mts";
import { expandRawArguments, flag, parseArgs, stringOption, type Parsed } from "./lib/args.mts";
import { collectReviewContext, findRepoRoot, isEmptyReview, resolveReviewTarget, type ReviewContext } from "./lib/git.mts";
import {
  appendLog, appendLogBlock, createJob, currentSessionId, forSession, generateJobId, isActive, listJobs, matchJob,
  DATA_DIR_ENV, forceUpdateJob, listAllJobs, nowIso, progressPreview, readConfig, readJob, SESSION_ID_ENV, terminateProcessTree, updateJob, withSessionLock, writeConfig,
  type Job, type ReviewRequest, type TaskRequest
} from "./lib/jobs.mts";
import { asReviewOutput, renderInvalidReview, renderJobDetail, renderJobTable, renderReview, renderTask } from "./lib/render.mts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ID = "agy@ph3on1x-skills";
// The Stop hook itself is killed at 900s (hooks.json); agy's deadline must land first.
const STOP_GATE_PRINT_TIMEOUT = "780s";
const DEFAULT_CONTINUE_PROMPT =
  "Continue the previous task from where you stopped. Pick the next highest-value step, do it, and report what changed and what remains.";

// ---------- helpers ----------

const workspaceRootOf = (cwd: string): string => findRepoRoot(cwd) ?? cwd;

function loadPrompt(name: string, vars: Readonly<Record<string, string>>): string {
  const template = readFileSync(join(ROOT, "prompts", `${name}.md`), "utf8");
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

/**
 * Untrusted text must not be able to close the XML block it is embedded in. XML allows whitespace
 * (including newlines) before the `>` of a closing tag, so every such spelling is neutralized.
 */
export const fence = (text: string): string => text.replace(/<\/(\s*)(repository_context|previous_claude_turn)(\s*)>/gi, "<\\/$1$2$3>");

function print(payload: unknown, rendered: string, json: boolean): void {
  process.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : rendered);
}

function resolveModel(requested: string | undefined, effort?: string): string | undefined {
  if (!requested) return undefined;
  return needsModelLookup(requested) ? resolveModelAlias(requested, listModels(), effort) : requested;
}

function readStdin(): string {
  return process.stdin.isTTY ? "" : readFileSync(0, "utf8");
}

const firstLine = (text: string, fallback: string): string =>
  text.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 120) ?? fallback;

type Execution = {
  readonly ok: boolean;
  readonly rendered: string;
  readonly summary: string;
  readonly result?: unknown;
  readonly conversationId?: string;
};

function progressReporter(job: Job): (p: Progress) => void {
  let phase = job.phase;
  return (p) => {
    appendLog(job.logFile, p.message);
    const newPhase = p.phase && p.phase !== phase ? p.phase : undefined;
    if (newPhase) phase = newPhase;
    if (newPhase || p.conversationId) {
      updateJob(job.workspaceRoot, job.id, { ...(newPhase ? { phase: newPhase } : {}), ...(p.conversationId ? { conversationId: p.conversationId } : {}) });
    }
  };
}

type RunHooks = { readonly onProgress: (p: Progress) => void; readonly onSpawn: (pid: number) => void };

/**
 * Claims the job for this process, runs it, and records the outcome. A job cancelled before the
 * claim never starts; one cancelled while running stays cancelled.
 */
async function runJob(job: Job, work: (hooks: RunHooks) => Promise<Execution>): Promise<Execution> {
  const claimed = updateJob(job.workspaceRoot, job.id, { status: "running", phase: "starting", pid: process.pid, startedAt: nowIso() });
  if (claimed.status !== "running") throw new Error(`agy job ${job.id} was ${claimed.status} before it started.`);
  const hooks: RunHooks = {
    onProgress: progressReporter(job),
    onSpawn: (agyPid) => {
      // Refused when the job was cancelled in the meantime: throwing makes runAgyTurn stop agy at once.
      if (updateJob(job.workspaceRoot, job.id, { agyPid }).status !== "running") throw new Error(`agy job ${job.id} was cancelled.`);
    }
  };
  try {
    const execution = await work(hooks);
    appendLogBlock(job.logFile, "Final output", execution.rendered);
    updateJob(job.workspaceRoot, job.id, {
      status: execution.ok ? "completed" : "failed",
      phase: execution.ok ? "done" : "failed",
      pid: null,
      agyPid: null,
      completedAt: nowIso(),
      summary: execution.summary,
      rendered: execution.rendered,
      result: execution.result,
      ...(execution.conversationId ? { conversationId: execution.conversationId } : {}),
      ...(execution.ok ? {} : { errorMessage: execution.summary })
    });
    return execution;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(job.logFile, `Failed: ${message}`);
    updateJob(job.workspaceRoot, job.id, { status: "failed", phase: "failed", pid: null, agyPid: null, completedAt: nowIso(), errorMessage: message });
    throw error;
  }
}

const staleNote = (outcome: TurnOutcome): string => {
  const stale = staleError(outcome);
  return stale ? `\nNote: agy flagged an earlier error in this conversation that it already recovered from (${stale}); this turn completed.\n` : "";
};

/**
 * A failed turn can still have changed files (agy may fail on its last model call after doing the
 * work), so edits and the resumable conversation are always reported.
 */
function failedTurn(outcome: TurnOutcome, failure: string, label: string): Execution {
  const partial = outcome.result.response.trim();
  const conversationId = outcome.result.conversation_id;
  const rendered = [
    `# agy ${label} failed`,
    "",
    failure,
    ...(partial ? ["", "Partial response:", "", partial] : []),
    ...(outcome.touchedFiles.length > 0 ? ["", "Files edited by agy before it stopped:", ...outcome.touchedFiles.map((f) => `- ${f}`)] : []),
    ...(label === "task" && conversationId ? ["", `The agy conversation is kept (${conversationId}): continue it with /agy:rescue --resume.`] : []),
    ""
  ].join("\n");
  return { ok: false, rendered, summary: failure, conversationId };
}

// ---------- review ----------

type ReviewKind = "review" | "adversarial-review";

async function executeReview(kind: ReviewKind, context: ReviewContext, focus: string, model: string | undefined, hooks: RunHooks): Promise<Execution> {
  const label = kind === "review" ? "Review" : "Adversarial Review";
  const prompt = loadPrompt(kind, {
    REVIEW_INPUT: fence(`${context.summary}\n\n${context.content}`),
    TARGET_LABEL: context.target.label,
    REPO_ROOT: context.repoRoot,
    USER_FOCUS: focus || "No extra focus provided."
  });
  const outcome = await runAgyTurn({
    cwd: context.repoRoot,
    prompt,
    profile: "read-only",
    model,
    schemaPath: join(ROOT, "schemas", "review-output.schema.json"),
    ...hooks
  });
  const failure = turnFailure(outcome) ?? readOnlyBreach(outcome);
  if (failure) return failedTurn(outcome, failure, label);
  const output = asReviewOutput(outcome.result.structured_output);
  const meta = { label, target: context.target.label, omitted: context.omittedDiffs.length };
  return output
    ? { ok: true, rendered: renderReview(output, meta) + staleNote(outcome), summary: output.summary, result: output, conversationId: outcome.result.conversation_id }
    : { ok: false, rendered: renderInvalidReview(meta, outcome.result.response), summary: "agy returned an invalid review shape." };
}

function reviewWork(kind: ReviewKind, request: ReviewRequest): (hooks: RunHooks) => Promise<Execution> {
  return (hooks) => {
    const target = resolveReviewTarget(request.cwd, { scope: request.scope, base: request.base });
    return executeReview(kind, collectReviewContext(request.cwd, target), request.focus, request.model, hooks);
  };
}

async function handleReview(kind: ReviewKind, argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(expandRawArguments(argv), {
    values: ["base", "scope", "model", "cwd"],
    booleans: ["json", "wait", "background"],
    aliases: { m: "model" }
  });
  const cwd = resolve(stringOption(parsed, "cwd") ?? process.cwd());
  const focus = parsed.positionals.join(" ").trim();
  if (kind === "review" && focus) {
    throw new Error("/agy:review does not take focus text. Use /agy:adversarial-review for a steerable review.");
  }
  const target = resolveReviewTarget(cwd, { scope: stringOption(parsed, "scope"), base: stringOption(parsed, "base") });
  const context = collectReviewContext(cwd, target);
  if (isEmptyReview(context)) {
    print({ status: "empty", target }, `Nothing to review: the ${target.label} is empty.\n`, flag(parsed, "json"));
    return;
  }
  const model = resolveModel(stringOption(parsed, "model"));
  const reviewRequest: ReviewRequest = { cwd, scope: stringOption(parsed, "scope"), base: stringOption(parsed, "base"), focus, model };
  const job = createJob({
    id: generateJobId(kind),
    kind,
    title: `agy ${kind === "review" ? "review" : "adversarial review"}`,
    summary: `${target.label}${focus ? `: ${focus}` : ""}`,
    status: "queued",
    phase: "queued",
    workspaceRoot: context.repoRoot,
    reviewRequest
  });
  await startJob(job, flag(parsed, "background"), flag(parsed, "json"));
}

// ---------- task ----------

function resumableTask(jobs: readonly Job[]): Job | undefined {
  return jobs.find((job) => job.kind === "task" && !isActive(job) && Boolean(job.conversationId));
}

function latestSessionJobs(workspaceRoot: string): Job[] {
  const sessionId = currentSessionId();
  return sessionId ? forSession(listJobs(workspaceRoot), sessionId) : [];
}

async function executeTask(request: TaskRequest, hooks: RunHooks): Promise<Execution> {
  const { profile } = request;
  const outcome = await runAgyTurn({
    cwd: request.cwd,
    // Read-only runs see the agent's own directory as a second workspace root; anchor paths.
    prompt: profile === "read-only" ? `Repository root: ${request.cwd}\n\n${request.prompt}` : request.prompt,
    profile,
    model: request.model,
    effort: request.effort,
    conversationId: request.conversationId,
    ...hooks
  });
  const failure = turnFailure(outcome) ?? (profile === "read-only" ? readOnlyBreach(outcome) : null);
  if (failure) {
    const hint = profile === "write" && /operation not permitted/i.test(outcome.result.response)
      ? " Shell commands run in a write-blocking sandbox; re-run with --full-access if agy must build or install."
      : "";
    return failedTurn(outcome, `${failure}${hint}`, "task");
  }
  const { result } = outcome;
  return {
    ok: true,
    rendered: renderTask(result.response, { touchedFiles: outcome.touchedFiles, conversationId: result.conversation_id, repoRoot: workspaceRootOf(request.cwd) }) + staleNote(outcome),
    summary: firstLine(result.response, "agy task finished."),
    result: { response: result.response, touchedFiles: outcome.touchedFiles, conversationId: result.conversation_id },
    conversationId: result.conversation_id
  };
}

function spawnWorker(job: Job): number {
  const child = spawn(process.execPath, [SELF, "job-worker", "--cwd", job.workspaceRoot, "--job-id", job.id], {
    cwd: job.workspaceRoot,
    env: process.env,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  if (!child.pid) throw new Error("Failed to start the background agy worker.");
  return child.pid;
}

async function handleTask(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    values: ["model", "effort", "cwd"],
    // read-only is the default; accepted so a forwarded --read-only never leaks into the prompt.
    booleans: ["json", "write", "read-only", "full-access", "resume-last", "resume", "fresh", "background"],
    aliases: { m: "model" }
  });
  const cwd = resolve(stringOption(parsed, "cwd") ?? process.cwd());
  const workspaceRoot = workspaceRootOf(cwd);
  const resume = flag(parsed, "resume-last") || flag(parsed, "resume");
  if (resume && flag(parsed, "fresh")) throw new Error("Choose either --resume-last or --fresh, not both.");
  const prompt = (parsed.positionals.join(" ") || readStdin()).trim();

  if (flag(parsed, "read-only") && (flag(parsed, "write") || flag(parsed, "full-access"))) throw new Error("Choose either --read-only or --write/--full-access.");
  const profile: Profile = flag(parsed, "full-access") ? "full-access" : flag(parsed, "write") ? "write" : "read-only";
  const effort = stringOption(parsed, "effort")?.toLowerCase();
  const model = resolveModel(stringOption(parsed, "model"), effort);

  const createTaskJob = (conversationId: string | undefined): { readonly job: Job; readonly request: TaskRequest } => {
    const request: TaskRequest = {
      cwd,
      prompt: prompt || DEFAULT_CONTINUE_PROMPT,
      profile,
      model,
      effort,
      ...(conversationId ? { conversationId } : {})
    };
    const job = createJob({
      id: generateJobId("task"),
      kind: "task",
      title: `agy ${profile} task${conversationId ? " (continued)" : ""}`,
      summary: firstLine(request.prompt, "agy task"),
      status: "queued",
      phase: "queued",
      workspaceRoot,
      profile,
      request,
      ...(conversationId ? { conversationId } : {})
    });
    return { job, request };
  };

  let created: { readonly job: Job; readonly request: TaskRequest };
  if (resume) {
    const sessionId = currentSessionId();
    if (!sessionId) throw new Error(`Cannot resume: ${SESSION_ID_ENV} is not set, so the current Claude session's agy thread is unknown.`);
    // Selection and job creation are one critical section: two resumes cannot both take the thread.
    created = withSessionLock(workspaceRoot, sessionId, () => {
      const sessionJobs = latestSessionJobs(workspaceRoot);
      if (sessionJobs.some((job) => job.kind === "task" && isActive(job))) {
        throw new Error("An agy task from this session is still running. Wait for it (/agy:status) or cancel it (/agy:cancel) before continuing its thread.");
      }
      const previous = resumableTask(sessionJobs);
      const conversationId = previous?.conversationId ?? undefined;
      if (!previous || !conversationId) throw new Error("No previous agy task thread was found for this Claude session. Start a fresh task instead.");
      // agy fixes a conversation's agent (and so its tool set) when it is created and ignores
      // --agent on resume, so a resume must stay on the same side of the read-only boundary.
      // (--sandbox is applied per run, so write <-> full-access is fine.)
      if ((previous.profile === "read-only") !== (profile === "read-only")) {
        throw new Error(
          previous.profile === "read-only"
            ? "The previous agy thread is read-only and agy cannot add edit tools to it: resume it without --write, or start a fresh task (--fresh) to edit."
            : `The previous agy thread ran with ${previous.profile ?? "write"} access and agy cannot remove its edit tools: resume it with --write, or start a fresh read-only task (--fresh).`
        );
      }
      return createTaskJob(conversationId);
    });
  } else {
    if (!prompt) throw new Error("Provide the task text as arguments or on stdin, or use --resume-last.");
    created = createTaskJob(undefined);
  }
  const { job, request } = created;

  await startJob(job, flag(parsed, "background"), flag(parsed, "json"));
}

/**
 * Every review and task runs in a detached worker (own process group, no terminal), never in this
 * process: Claude Code caps a foreground Bash call (120s by default) and kills background Bash when
 * the session ends, and neither may take a running agy down. Foreground callers then wait on the
 * job in bounded slices (`awaitJob`), so no single Bash call outlives the cap.
 */
async function startJob(job: Job, background: boolean, json: boolean): Promise<void> {
  appendLog(job.logFile, "Started in a detached worker.");
  updateJob(job.workspaceRoot, job.id, { pid: spawnWorker(job) });
  if (!background) {
    await awaitJob(job, json);
    return;
  }
  const rendered = `agy ${job.kind} ${job.id} started in the background${job.profile ? ` (${job.profile})` : ""}.\nCheck progress with /agy:status ${job.id}; fetch output with /agy:result ${job.id}.\n`;
  print({ jobId: job.id, status: "queued", logFile: job.logFile }, rendered, json);
}

/** Below Claude Code's default 120s foreground Bash cap; raise it if yours is higher. */
const waitSliceMs = (): number => Number(process.env.AGY_COMPANION_WAIT_MS ?? 100_000);

/**
 * Waits up to one slice for a job, echoing its progress to stderr, then prints its result, or a
 * "still running" notice naming the command that keeps waiting. The job never depends on this
 * process: killing the waiter leaves it running.
 */
async function awaitJob(job: Job, json: boolean): Promise<void> {
  const deadline = Date.now() + waitSliceMs();
  let shown = progressPreview(job.logFile, Number.MAX_SAFE_INTEGER).length;
  let current = job;
  while (isActive(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    current = listJobs(job.workspaceRoot).find((j) => j.id === job.id) ?? current;
    if (!json) {
      const lines = progressPreview(job.logFile, Number.MAX_SAFE_INTEGER);
      lines.slice(shown).forEach((line) => process.stderr.write(`[agy] ${line}\n`));
      shown = lines.length;
    }
  }
  if (isActive(current)) {
    const rendered = `agy ${current.kind} ${current.id} is still running (${current.phase}); it continues in the background.\nKeep waiting with: node "${SELF}" result ${current.id} --wait\nOr check later: /agy:status ${current.id}, /agy:result ${current.id}.\n`;
    print({ jobId: current.id, status: current.status, phase: current.phase }, rendered, json);
    return;
  }
  print(current, current.rendered ?? `# agy ${current.kind} ${current.id} - ${current.status}\n\n${current.errorMessage ?? "No output was recorded."}\n\nLog: ${current.logFile}\n`, json);
  if (current.status !== "completed") process.exitCode = 1;
}

async function handleJobWorker(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv, { values: ["cwd", "job-id"] });
  const workspaceRoot = workspaceRootOf(resolve(stringOption(parsed, "cwd") ?? process.cwd()));
  const id = stringOption(parsed, "job-id");
  const job = id ? readJob(workspaceRoot, id) : null;
  if (!job) throw new Error(`No queued job found for ${id ?? "(missing --job-id)"}.`);
  if (!isActive(job)) return;
  if (job.kind === "task" && job.request) {
    const request = job.request;
    await runJob(job, (hooks) => executeTask(request, hooks));
  } else if (job.kind !== "task" && job.reviewRequest) {
    await runJob(job, reviewWork(job.kind, job.reviewRequest));
  } else {
    throw new Error(`Job ${job.id} has no stored request.`);
  }
}

function handleTaskResumeCandidate(argv: readonly string[]): void {
  const parsed = parseArgs(expandRawArguments(argv), { values: ["cwd"], booleans: ["json"] });
  const workspaceRoot = workspaceRootOf(resolve(stringOption(parsed, "cwd") ?? process.cwd()));
  const sessionJobs = latestSessionJobs(workspaceRoot);
  const running = sessionJobs.find((job) => job.kind === "task" && isActive(job));
  const candidate = running ? undefined : resumableTask(sessionJobs);
  const payload = {
    available: Boolean(candidate),
    sessionId: currentSessionId() ?? null,
    candidate: candidate ? { id: candidate.id, status: candidate.status, summary: candidate.summary, conversationId: candidate.conversationId, profile: candidate.profile ?? null } : null
  };
  const rendered = candidate
    ? `Resumable agy task: ${candidate.id} (${candidate.status}) - ${candidate.summary}\n`
    : running ? `agy task ${running.id} is still running.\n` : "No resumable agy task for this session.\n";
  print(payload, rendered, flag(parsed, "json"));
}

// ---------- status / result / cancel ----------

async function handleStatus(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(expandRawArguments(argv), { values: ["cwd", "timeout-ms"], booleans: ["json", "all", "wait"] });
  const workspaceRoot = workspaceRootOf(resolve(stringOption(parsed, "cwd") ?? process.cwd()));
  const reference = parsed.positionals[0];
  if (reference) {
    const deadline = Date.now() + Number(stringOption(parsed, "timeout-ms") ?? waitSliceMs());
    let job = matchJob(listJobs(workspaceRoot), reference);
    while (flag(parsed, "wait") && isActive(job) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      job = matchJob(listJobs(workspaceRoot), job.id);
    }
    print(job, renderJobDetail(job, progressPreview(job.logFile)), flag(parsed, "json"));
    return;
  }
  if (flag(parsed, "wait")) throw new Error("`status --wait` requires a job id.");
  const jobs = flag(parsed, "all") ? listJobs(workspaceRoot) : forSession(listJobs(workspaceRoot), currentSessionId()).slice(0, 10);
  const config = readConfig(workspaceRoot);
  const active = jobs.filter(isActive);
  const rendered = [
    renderJobTable(jobs),
    ...active.map((job) => `${job.id} progress: ${progressPreview(job.logFile, 2).join(" / ") || "starting"}`),
    `Stop-time review gate: ${config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ].join("\n");
  print({ workspaceRoot, config, jobs }, rendered, flag(parsed, "json"));
}

async function handleResult(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(expandRawArguments(argv), { values: ["cwd"], booleans: ["json", "wait"] });
  const workspaceRoot = workspaceRootOf(resolve(stringOption(parsed, "cwd") ?? process.cwd()));
  const reference = parsed.positionals[0];
  const candidates = reference ? listJobs(workspaceRoot) : forSession(listJobs(workspaceRoot), currentSessionId());
  // Without an id, --wait means "the job I am waiting for": the running one, if any.
  const job = reference
    ? matchJob(candidates, reference)
    : ((flag(parsed, "wait") ? candidates.find(isActive) : undefined) ?? candidates.find((j) => !isActive(j)));
  if (!job) throw new Error("No agy jobs for this session yet. Run /agy:status.");
  if (isActive(job) && flag(parsed, "wait")) {
    await awaitJob(job, flag(parsed, "json"));
    return;
  }
  if (isActive(job)) throw new Error(`Job ${job.id} is still ${job.status}. Check /agy:status ${job.id}, or wait with /agy:result ${job.id} --wait.`);
  const header = `# agy ${job.kind} ${job.id} - ${job.status}\n\n`;
  const body = job.rendered ?? `${job.errorMessage ?? "No output was recorded."}\n\nLog: ${job.logFile}\n`;
  print(job, header + body, flag(parsed, "json"));
}

async function cancelJob(job: Job, reason: string): Promise<Job> {
  const terminal = { status: "cancelled", phase: "cancelled", completedAt: nowIso(), errorMessage: reason } as const;
  // Mark first so the runner's completion write and any later agy-pid write are refused. Pids stay
  // in the record until both groups are stopped: agy's own group and the runner (detached worker,
  // or a foreground companion whose signal handler also stops agy). Then re-assert, race-free.
  const marked = updateJob(job.workspaceRoot, job.id, terminal);
  if (marked.status !== "cancelled") return marked; // It finished first; keep its real outcome.
  await Promise.all([terminateProcessTree(marked.agyPid), terminateProcessTree(marked.pid)]);
  appendLog(job.logFile, reason);
  return forceUpdateJob(job.workspaceRoot, job.id, { ...terminal, pid: null, agyPid: null });
}

async function handleCancel(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(expandRawArguments(argv), { values: ["cwd"], booleans: ["json"] });
  const workspaceRoot = workspaceRootOf(resolve(stringOption(parsed, "cwd") ?? process.cwd()));
  const reference = parsed.positionals[0];
  const active = listJobs(workspaceRoot).filter(isActive);
  let job: Job;
  if (reference) {
    job = matchJob(active, reference);
  } else {
    if (!currentSessionId()) throw new Error("Pass a job id: the current Claude session is unknown.");
    const mine = forSession(active, currentSessionId());
    if (mine.length !== 1 || !mine[0]) {
      throw new Error(mine.length === 0 ? "No active agy jobs in this session." : "Several agy jobs are active. Pass a job id to /agy:cancel.");
    }
    job = mine[0];
  }
  const cancelled = await cancelJob(job, "Cancelled by user.");
  print(cancelled, `Cancelled agy ${job.kind} ${job.id}.\n`, flag(parsed, "json"));
}

// ---------- setup ----------

function conflictingPlugins(): string[] {
  const path = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(path)) return [];
  const installed = JSON.parse(readFileSync(path, "utf8")) as { plugins?: Record<string, unknown> };
  return Object.keys(installed.plugins ?? {}).filter((key) => key.startsWith("agy@") && key !== PLUGIN_ID);
}

function handleSetup(argv: readonly string[]): void {
  const parsed = parseArgs(expandRawArguments(argv), { values: ["cwd"], booleans: ["json", "enable-review-gate", "disable-review-gate"] });
  const workspaceRoot = workspaceRootOf(resolve(stringOption(parsed, "cwd") ?? process.cwd()));
  if (flag(parsed, "enable-review-gate") && flag(parsed, "disable-review-gate")) throw new Error("Choose one of --enable-review-gate or --disable-review-gate.");
  if (flag(parsed, "enable-review-gate")) writeConfig(workspaceRoot, { stopReviewGate: true });
  if (flag(parsed, "disable-review-gate")) writeConfig(workspaceRoot, { stopReviewGate: false });

  const availability = checkAvailability();
  const conflicts = conflictingPlugins();
  const config = readConfig(workspaceRoot);
  const ready = availability.installed && availability.authenticated;
  const lines = [
    "# agy setup",
    "",
    `Status: ${ready ? "ready" : "not ready"}`,
    `Node.js: ${process.versions.node}`,
    `agy: ${availability.installed ? `${availability.version} (${agyBin()})` : "not installed"}`,
    `Auth: ${availability.authenticated ? "signed in" : availability.installed ? `not ready - ${availability.detail}` : "-"}`,
    ...(availability.authenticated && availability.detail ? ["Quota:", ...availability.detail.split("\n").map((l) => `  ${l}`)] : []),
    `Stop-time review gate (${workspaceRoot}): ${config.stopReviewGate ? "enabled" : "disabled"}`
  ];
  if (!availability.installed) {
    lines.push("", "Install agy: `brew install --cask antigravity-cli` (macOS) or `curl -fsSL https://antigravity.google/cli/install.sh | bash`.");
  } else if (!availability.authenticated) {
    lines.push("", "Sign in: run `!agy` once and complete the browser sign-in. For an API key instead, set `\"modelProvider\": \"gemini\"` in ~/.gemini/antigravity-cli/settings.json and export GEMINI_API_KEY.");
  }
  if (conflicts.length > 0) {
    lines.push("", `Warning: ${conflicts.join(", ")} also uses the /agy: namespace. Uninstall it (/plugin uninstall ${conflicts[0]}) so /agy:* commands resolve to this plugin.`);
  }
  print({ ready, node: process.versions.node, availability, conflicts, config, workspaceRoot }, `${lines.join("\n")}\n`, flag(parsed, "json"));
}

// ---------- hooks ----------

type HookInput = {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly stop_hook_active?: boolean;
  readonly last_assistant_message?: string;
};

function hookSessionStart(input: HookInput): void {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) return;
  const quote = (v: string): string => `'${v.replace(/'/g, `'"'"'`)}'`;
  const exports = [
    input.session_id ? `export ${SESSION_ID_ENV}=${quote(input.session_id)}\n` : "",
    process.env.CLAUDE_PLUGIN_DATA ? `export ${DATA_DIR_ENV}=${quote(process.env.CLAUDE_PLUGIN_DATA)}\n` : ""
  ].join("");
  if (exports) appendFileSync(envFile, exports, "utf8");
}

/** Session over: stop its running jobs but keep their records and results. */
async function hookSessionEnd(input: HookInput): Promise<void> {
  if (!input.session_id) return;
  // Every repository this session touched, not just the hook's cwd (jobs may use --cwd elsewhere).
  const active = forSession(listAllJobs(), input.session_id).filter(isActive);
  await Promise.all(active.map((job) => cancelJob(job, "Cancelled because the Claude session ended.")));
}

type StopVerdict = { readonly decision: "allow" | "block"; readonly reason: string };

const asStopVerdict = (value: unknown): StopVerdict | null => {
  const v = value as Partial<StopVerdict> | null;
  return v && (v.decision === "allow" || v.decision === "block") && typeof v.reason === "string" ? (v as StopVerdict) : null;
};

/** The gate's decision for this stop: block with a reason, or allow with an optional note. */
async function stopGateDecision(input: HookInput, workspaceRoot: string): Promise<{ readonly block?: string; readonly note?: string }> {
  const cwd = input.cwd ?? process.cwd();
  if (!readConfig(workspaceRoot).stopReviewGate || input.stop_hook_active || !findRepoRoot(cwd)) return {};
  const context = collectReviewContext(cwd, { mode: "working-tree", label: "working tree diff" });
  if (isEmptyReview(context)) return {};
  const outcome = await runAgyTurn({
    cwd: context.repoRoot,
    prompt: loadPrompt("stop-review-gate", {
      REVIEW_INPUT: fence(`${context.summary}\n\n${context.content}`),
      REPO_ROOT: context.repoRoot,
      CLAUDE_RESPONSE: fence(input.last_assistant_message?.trim() || "(no final message)")
    }),
    profile: "read-only",
    schemaPath: join(ROOT, "schemas", "stop-gate.schema.json"),
    printTimeout: STOP_GATE_PRINT_TIMEOUT
  });
  const failure = turnFailure(outcome) ?? readOnlyBreach(outcome);
  if (failure) return { note: `agy stop-time review skipped: ${failure}` };
  const verdict = asStopVerdict(outcome.result.structured_output);
  if (!verdict) return { note: "agy stop-time review skipped: agy returned no valid allow/block verdict." };
  return verdict.decision === "block" ? { block: `agy stop-time review: ${verdict.reason}` } : {};
}

/**
 * Opt-in stop gate. Blocks only on a concrete finding from agy. Anything else (gate off, re-entry,
 * clean tree, agy missing, auth, quota, timeout, bad output, local errors) allows the stop and
 * says why, so the gate can never trap the user.
 */
async function hookStop(input: HookInput): Promise<void> {
  let output: Record<string, string> | null;
  try {
    const workspaceRoot = workspaceRootOf(input.cwd ?? process.cwd());
    const decision = await stopGateDecision(input, workspaceRoot);
    if (decision.block) {
      output = { decision: "block", reason: decision.block };
    } else {
      const running = forSession(listJobs(workspaceRoot), input.session_id).filter(isActive);
      const runningNote = running[0] ? `agy job ${running[0].id} is still running (/agy:status, /agy:cancel).` : "";
      const message = [decision.note, runningNote].filter(Boolean).join(" ");
      output = message ? { systemMessage: message } : null;
    }
  } catch (error) {
    output = { systemMessage: `agy stop-time review skipped: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function handleHook(argv: readonly string[]): Promise<void> {
  // Hooks run with this plugin's own CLAUDE_PLUGIN_DATA (unlike Bash commands; see DATA_DIR_ENV).
  if (process.env.CLAUDE_PLUGIN_DATA) process.env[DATA_DIR_ENV] = process.env.CLAUDE_PLUGIN_DATA;
  const raw = readStdin().trim();
  const input = (raw ? JSON.parse(raw) : {}) as HookInput;
  const event = argv[0];
  if (event === "SessionStart") return hookSessionStart(input);
  if (event === "SessionEnd") return hookSessionEnd(input);
  if (event === "Stop") return hookStop(input);
  throw new Error(`Unknown hook event: ${event ?? "(none)"}`);
}

// ---------- main ----------

const COMMANDS: Readonly<Record<string, (argv: readonly string[]) => void | Promise<void>>> = {
  setup: handleSetup,
  review: (argv) => handleReview("review", argv),
  "adversarial-review": (argv) => handleReview("adversarial-review", argv),
  task: handleTask,
  "job-worker": handleJobWorker,
  "task-resume-candidate": handleTaskResumeCandidate,
  status: handleStatus,
  result: handleResult,
  cancel: handleCancel,
  hook: handleHook
};

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const handler = command ? COMMANDS[command] : undefined;
  if (!handler) {
    process.stdout.write(`Usage: agy-companion <${Object.keys(COMMANDS).join("|")}> [...]\n`);
    if (command && command !== "help" && command !== "--help") process.exitCode = 1;
    return;
  }
  await handler(rest);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
