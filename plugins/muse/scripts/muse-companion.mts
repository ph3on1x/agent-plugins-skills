#!/usr/bin/env node
/**
 * muse-companion: runs Meta's Muse Code (`muse`) for Claude Code slash commands and hooks.
 *
 *   setup [--enable-review-gate|--disable-review-gate] [--json]
 *   review | adversarial-review  "[--base <ref>] [--scope auto|working-tree|branch] [--model m] [focus ...]"
 *       (or --args-stdin with that raw argument string on stdin)
 *   task [--write] [--full-access] [--model m] [--effort e] [--resume-last|--fresh] [--background] [--json] [prompt | stdin]
 *   transfer "[--source <claude-jsonl>]" (or --args-stdin)
 *   status [job] [--wait] [--timeout-ms n] [--all] [--json]
 *   result [job] [--json]      cancel [job] [--json]      task-resume-candidate [--json]
 *   hook SessionStart|SessionEnd|Stop   (hook JSON on stdin)
 *
 * Requires Node.js 22.18+ (type stripping). Zero dependencies.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkAvailability, contributorMode, listModels, museBin, needsModelLookup, normalizeReview, parseStructured, readOnlyFailure, resolveModelAlias, runMuseTurn, sandboxHint, turnFailure,
  type Allowance, type Profile, type Progress, type TurnOutcome, type TurnRequest
} from "./lib/muse.mts";
import { expandRawArguments, flag, parseArgs, splitRawArgs, stringOption } from "./lib/args.mts";
import { changedPaths, collectReviewContext, findRepoRoot, isEmptyReview, resolveReviewTarget, treeFingerprint, type ReviewContext } from "./lib/git.mts";
import {
  appendLog, appendLogBlock, createJob, currentSessionId, forSession, generateJobId, isActive, listJobs, matchJob,
  DATA_DIR_ENV, forceUpdateJob, listAllJobs, nowIso, progressPreview, readConfig, readJob, SESSION_ID_ENV, terminateProcessTree, updateJob, usagePath, withSessionLock, writeConfig,
  type Job, type ReviewRequest, type TaskRequest
} from "./lib/jobs.mts";
import { asReviewOutput, outsideWarning, renderInvalidReview, renderJobDetail, renderJobTable, renderReview, renderTask } from "./lib/render.mts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ID = "muse@ph3on1x";
const TRANSCRIPT_PATH_ENV = "MUSE_COMPANION_TRANSCRIPT_PATH";
// The Stop hook itself is killed at 900s (hooks.json); muse must be stopped first.
const STOP_GATE_DEADLINE_MS = 780_000;
const STOP_GATE_MAX_MODEL_STEPS = 40;
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

function resolveModel(requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  return needsModelLookup(requested) ? resolveModelAlias(requested, listModels()) : requested;
}

function readStdin(): string {
  return process.stdin.isTTY ? "" : readFileSync(0, "utf8");
}

const firstLine = (text: string, fallback: string): string =>
  text.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 120) ?? fallback;

/** Muse cites files as markdown links to absolute paths; a one-line summary keeps only the link text. */
const linkText = (text: string): string => text.replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1");

/** muse has no side-effect-free quota query, so setup shows what the last run reported. */
function recordUsage(outcome: TurnOutcome): TurnOutcome {
  if (outcome.allowance) {
    mkdirSync(dirname(usagePath()), { recursive: true });
    writeFileSync(usagePath(), `${JSON.stringify(outcome.allowance)}\n`, "utf8");
  }
  return outcome;
}

type CheckedTurn = { readonly outcome: TurnOutcome; readonly failure: string | null; readonly treeWarning: string | null };

async function runWriteTurn(request: TurnRequest): Promise<CheckedTurn> {
  const outcome = recordUsage(await runMuseTurn(request));
  return { outcome, failure: turnFailure(outcome), treeWarning: null };
}

/**
 * Shell writes never appear in muse's event stream, so a read-only run also compares the working
 * tree before and after. A change is only a warning: Claude, the user, or another job may be
 * editing meanwhile, as during any background review.
 */
async function runReadOnlyTurn(request: Omit<TurnRequest, "profile">): Promise<CheckedTurn> {
  const repoRoot = findRepoRoot(request.cwd);
  const before = repoRoot ? treeFingerprint(repoRoot) : null;
  const outcome = recordUsage(await runMuseTurn({ ...request, profile: "read-only" }));
  const changed = repoRoot && before ? changedPaths(before, treeFingerprint(repoRoot)) : [];
  const listed = changed.length > 10 ? `${changed.slice(0, 10).join(", ")} and ${changed.length - 10} more` : changed.join(", ");
  return {
    outcome,
    failure: readOnlyFailure(outcome),
    treeWarning: changed.length > 0
      ? `Warning: the working tree changed while muse ran read-only (${listed}). If nothing else edited these files meanwhile, muse broke the read-only boundary.`
      : null
  };
}

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
  if (claimed.status !== "running") throw new Error(`muse job ${job.id} was ${claimed.status} before it started.`);
  const hooks: RunHooks = {
    onProgress: progressReporter(job),
    onSpawn: (musePid) => {
      // Refused when the job was cancelled in the meantime: throwing makes runMuseTurn stop muse at once.
      if (updateJob(job.workspaceRoot, job.id, { musePid }).status !== "running") throw new Error(`muse job ${job.id} was cancelled.`);
    }
  };
  try {
    const execution = await work(hooks);
    appendLogBlock(job.logFile, "Final output", execution.rendered);
    updateJob(job.workspaceRoot, job.id, {
      status: execution.ok ? "completed" : "failed",
      phase: execution.ok ? "done" : "failed",
      pid: null,
      musePid: null,
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
    updateJob(job.workspaceRoot, job.id, { status: "failed", phase: "failed", pid: null, musePid: null, completedAt: nowIso(), errorMessage: message });
    throw error;
  }
}

/**
 * A failed turn can still have changed files (muse may fail on its last model call after doing
 * the work), so edits and the resumable session are always reported.
 */
function failedTurn(outcome: TurnOutcome, failure: string, label: string, repoRoot: string, resumable: boolean): Execution {
  const partial = outcome.terminal.text.trim();
  const rendered = [
    `# muse ${label} failed`,
    "",
    failure,
    ...(partial ? ["", "Partial response:", "", partial] : []),
    ...(outcome.touchedFiles.length > 0 ? ["", "Files edited by muse before it stopped:", ...outcome.touchedFiles.map((f) => `- ${f}`)] : []),
    ...outsideWarning(outcome.touchedFiles, repoRoot),
    ...(resumable ? ["", `The muse session is kept (${outcome.sessionId}): continue it with /muse:rescue --resume.`] : []),
    ""
  ].join("\n");
  return { ok: false, rendered, summary: failure, conversationId: outcome.sessionId };
}

const withWarning = (execution: Execution, warning: string | null): Execution =>
  warning ? { ...execution, rendered: `${execution.rendered.trimEnd()}\n\n${warning}\n` } : execution;

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
  const { outcome, failure, treeWarning } = await runReadOnlyTurn({
    cwd: context.repoRoot,
    prompt,
    sessionId: randomUUID(),
    model,
    schemaPath: join(ROOT, "schemas", "review-output.schema.json"),
    ...hooks
  });
  if (failure) return withWarning(failedTurn(outcome, failure, label, context.repoRoot, false), treeWarning);
  const output = asReviewOutput(normalizeReview(parseStructured(outcome.terminal.text), context.repoRoot));
  const meta = { label, target: context.target.label, omitted: context.omittedDiffs.length };
  return withWarning(output
    ? { ok: true, rendered: renderReview(output, meta), summary: output.summary, result: output, conversationId: outcome.sessionId }
    : { ok: false, rendered: renderInvalidReview(meta, outcome.terminal.text), summary: "muse returned an invalid review shape." }, treeWarning);
}

function reviewWork(kind: ReviewKind, request: ReviewRequest): (hooks: RunHooks) => Promise<Execution> {
  return (hooks) => executeReview(kind, collectReviewContext(request.cwd, request.target), request.focus, request.model, hooks);
}

/**
 * Slash-command arguments: a raw string on stdin with --args-stdin (the commands pass it through a
 * quoted heredoc, so the shell never expands backticks or `$` in focus text), else one argv string.
 * Flags given in argv come first, so they still apply when the user's text contains `--`.
 */
function slashArguments(argv: readonly string[]): string[] {
  return argv.includes("--args-stdin")
    ? [...argv.filter((arg) => arg !== "--args-stdin"), ...splitRawArgs(readStdin())]
    : expandRawArguments(argv);
}

async function handleReview(kind: ReviewKind, argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(slashArguments(argv), {
    values: ["base", "scope", "model", "cwd"],
    booleans: ["json", "wait", "background"],
    aliases: { m: "model" }
  });
  const cwd = resolve(stringOption(parsed, "cwd") ?? process.cwd());
  const focus = parsed.positionals.join(" ").trim();
  if (kind === "review" && focus) {
    throw new Error("/muse:review does not take focus text. Use /muse:adversarial-review for a steerable review.");
  }
  const target = resolveReviewTarget(cwd, { scope: stringOption(parsed, "scope"), base: stringOption(parsed, "base") });
  const context = collectReviewContext(cwd, target);
  if (isEmptyReview(context)) {
    print({ status: "empty", target }, `Nothing to review: the ${target.label} is empty.\n`, flag(parsed, "json"));
    return;
  }
  const model = resolveModel(stringOption(parsed, "model"));
  const reviewRequest: ReviewRequest = { cwd, target, focus, model };
  const job = createJob({
    id: generateJobId(kind),
    kind,
    title: `muse ${kind === "review" ? "review" : "adversarial review"}`,
    summary: `${target.label}${focus ? `: ${focus}` : ""}`,
    status: "queued",
    phase: "queued",
    workspaceRoot: context.repoRoot,
    reviewRequest
  });
  await startJob(job, flag(parsed, "background"), flag(parsed, "json"));
}

// ---------- task ----------

/** A task or transfer whose Muse session muse actually reported, so it exists to continue. */
function resumableTask(jobs: readonly Job[]): Job | undefined {
  return jobs.find((job) => (job.kind === "task" || job.kind === "transfer") && !isActive(job) && Boolean(job.conversationId));
}

const isThreadJob = (job: Job): boolean => job.kind === "task" || job.kind === "transfer";

function latestSessionJobs(workspaceRoot: string): Job[] {
  const sessionId = currentSessionId();
  return sessionId ? forSession(listJobs(workspaceRoot), sessionId) : [];
}

async function executeTask(kind: "task" | "transfer", request: TaskRequest, hooks: RunHooks): Promise<Execution> {
  const { profile } = request;
  const turn = { cwd: request.cwd, prompt: request.prompt, sessionId: request.conversationId, model: request.model, effort: request.effort, ...hooks };
  const { outcome, failure, treeWarning } = profile === "read-only" ? await runReadOnlyTurn(turn) : await runWriteTurn({ ...turn, profile });
  if (failure) {
    const hint = sandboxHint(profile, `${failure}\n${outcome.terminal.text}\n${outcome.stderr}`);
    return withWarning(failedTurn(outcome, `${failure}${hint}`, kind, workspaceRootOf(request.cwd), true), treeWarning);
  }
  const { terminal } = outcome;
  return withWarning({
    ok: true,
    rendered: renderTask(terminal.text, { touchedFiles: outcome.touchedFiles, conversationId: outcome.sessionId, repoRoot: workspaceRootOf(request.cwd) }),
    summary: firstLine(linkText(terminal.text), `muse ${kind} finished.`),
    result: { response: terminal.text, touchedFiles: outcome.touchedFiles, conversationId: outcome.sessionId },
    conversationId: outcome.sessionId
  }, treeWarning);
}

function spawnWorker(job: Job): number {
  const child = spawn(process.execPath, [SELF, "job-worker", "--cwd", job.workspaceRoot, "--job-id", job.id], {
    cwd: job.workspaceRoot,
    env: process.env,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  if (!child.pid) throw new Error("Failed to start the background muse worker.");
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
  const model = resolveModel(stringOption(parsed, "model"));

  const createTaskJob = (resumed: string | undefined): Job => {
    const request: TaskRequest = {
      cwd,
      prompt: prompt || DEFAULT_CONTINUE_PROMPT,
      profile,
      model,
      effort,
      // A new id creates the Muse session; a reported one continues it.
      conversationId: resumed ?? randomUUID()
    };
    return createJob({
      id: generateJobId("task"),
      kind: "task",
      title: `muse ${profile} task${resumed ? " (continued)" : ""}`,
      summary: firstLine(request.prompt, "muse task"),
      status: "queued",
      phase: "queued",
      workspaceRoot,
      profile,
      request
    });
  };

  let job: Job;
  if (resume) {
    const sessionId = currentSessionId();
    if (!sessionId) throw new Error(`Cannot resume: ${SESSION_ID_ENV} is not set, so the current Claude session's muse thread is unknown.`);
    // Selection and job creation are one critical section: two resumes cannot both take the thread.
    // Every run passes its own access flags, so a resume may change the thread's access level.
    job = withSessionLock(workspaceRoot, sessionId, () => {
      const sessionJobs = latestSessionJobs(workspaceRoot);
      if (sessionJobs.some((j) => isThreadJob(j) && isActive(j))) {
        throw new Error("A muse task from this session is still running. Wait for it (/muse:status) or cancel it (/muse:cancel) before continuing its thread.");
      }
      const conversationId = resumableTask(sessionJobs)?.conversationId ?? undefined;
      if (!conversationId) throw new Error("No previous muse task thread was found for this Claude session. Start a fresh task instead.");
      return createTaskJob(conversationId);
    });
  } else {
    if (!prompt) throw new Error("Provide the task text as arguments or on stdin, or use --resume-last.");
    job = createTaskJob(undefined);
  }

  await startJob(job, flag(parsed, "background"), flag(parsed, "json"));
}

// ---------- transfer ----------

/** `~` and `~/...` as a shell would expand them: the arguments arrive unexpanded through a quoted heredoc. */
const userPath = (cwd: string, value: string): string =>
  value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : resolve(cwd, value);

function realFile(path: string): string {
  try {
    const real = realpathSync(path);
    if (statSync(real).isFile()) return real;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  throw new Error(`--source is not a readable file: ${path}`);
}

/**
 * The Claude transcript to hand to muse: --source, else the one SessionStart recorded. Like codex,
 * only a transcript under ~/.claude/projects, so no other file can be sent to Meta by mistake.
 */
function transferSource(given: string | undefined, cwd: string): string {
  const requested = given ? userPath(cwd, given) : process.env[TRANSCRIPT_PATH_ENV];
  if (!requested) throw new Error("The current Claude session's transcript is unknown. Pass --source <claude-jsonl>.");
  // Checked on the resolved path: a `.jsonl` symlink may point at any other file.
  const source = realFile(requested);
  if (!source.endsWith(".jsonl")) throw new Error(`--source must name a Claude Code transcript (.jsonl): ${source}`);
  const projectsDir = join(homedir(), ".claude", "projects");
  const inside = relative(existsSync(projectsDir) ? realpathSync(projectsDir) : projectsDir, source);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`muse can transfer Claude Code transcripts only from ${projectsDir}: ${source}`);
  }
  // The path is quoted inside the prompt: it must not be able to end the quote or add lines.
  if (/[\r\n\0"]/.test(source)) throw new Error("--source must be a plain path (no quotes or line breaks).");
  return source;
}

/**
 * Hands a Claude Code conversation to Muse Code's own importer (the bundled `resume-claude` skill)
 * in a fresh read-only session, which `muse resume <id>` or /muse:rescue --resume then continues.
 */
async function handleTransfer(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(slashArguments(argv), { values: ["source", "model", "cwd"], booleans: ["json", "wait", "background"], aliases: { m: "model" } });
  const cwd = resolve(stringOption(parsed, "cwd") ?? process.cwd());
  if (parsed.positionals.length > 0) throw new Error(`/muse:transfer takes only --source <claude-jsonl>, not "${parsed.positionals.join(" ")}".`);
  const source = transferSource(stringOption(parsed, "source"), cwd);
  const request: TaskRequest = {
    cwd,
    prompt: loadPrompt("transfer", { SOURCE: source }),
    profile: "read-only",
    model: resolveModel(stringOption(parsed, "model")),
    conversationId: randomUUID()
  };
  const job = createJob({
    id: generateJobId("transfer"),
    kind: "transfer",
    title: "muse transfer",
    summary: `Claude session ${basename(source, ".jsonl")}`,
    status: "queued",
    phase: "queued",
    workspaceRoot: workspaceRootOf(cwd),
    profile: "read-only",
    request
  });
  await startJob(job, flag(parsed, "background"), flag(parsed, "json"));
}

/**
 * Every review and task runs in a detached worker (own process group, no terminal), never in this
 * process: Claude Code caps a foreground Bash call (120s by default) and kills background Bash when
 * the session ends, and neither may take a running muse down. Foreground callers then wait on the
 * job in bounded slices (`awaitJob`), so no single Bash call outlives the cap.
 */
async function startJob(job: Job, background: boolean, json: boolean): Promise<void> {
  appendLog(job.logFile, "Started in a detached worker.");
  try {
    updateJob(job.workspaceRoot, job.id, { pid: spawnWorker(job) });
  } catch (error) {
    // No worker means nothing will ever finish the job: fail it instead of leaving it queued.
    const message = error instanceof Error ? error.message : String(error);
    updateJob(job.workspaceRoot, job.id, { status: "failed", phase: "failed", completedAt: nowIso(), errorMessage: message });
    throw error;
  }
  if (!background) {
    // Only the launcher reports failure through its exit code: `result --wait` runs inside /muse:result's
    // inline command, where any non-zero exit aborts the command instead of showing the failure.
    const final = await awaitJob(job, json);
    if (!isActive(final) && final.status !== "completed") process.exitCode = 1;
    return;
  }
  const rendered = `muse ${job.kind} ${job.id} started in the background${job.profile ? ` (${job.profile})` : ""}.\nCheck progress with /muse:status ${job.id}; fetch output with /muse:result ${job.id}.\n`;
  print({ jobId: job.id, status: "queued", logFile: job.logFile }, rendered, json);
}

/** Below Claude Code's default 120s foreground Bash cap; raise it if yours is higher. */
const waitSliceMs = (): number => Number(process.env.MUSE_COMPANION_WAIT_MS ?? 100_000);

/**
 * Waits up to one slice for a job, echoing its progress to stderr, then prints its result, or a
 * "still running" notice naming the command that keeps waiting, and returns the job as last seen.
 * The job never depends on this process: killing the waiter leaves it running.
 */
async function awaitJob(job: Job, json: boolean): Promise<Job> {
  const deadline = Date.now() + waitSliceMs();
  let shown = progressPreview(job.logFile, Number.MAX_SAFE_INTEGER).length;
  let current = job;
  while (isActive(current) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    current = listJobs(job.workspaceRoot).find((j) => j.id === job.id) ?? current;
    if (!json) {
      const lines = progressPreview(job.logFile, Number.MAX_SAFE_INTEGER);
      lines.slice(shown).forEach((line) => process.stderr.write(`[muse] ${line}\n`));
      shown = lines.length;
    }
  }
  if (isActive(current)) {
    const rendered = `muse ${current.kind} ${current.id} is still running (${current.phase}); it continues in the background.\nKeep waiting with: node "${SELF}" result ${current.id} --wait\nOr check later: /muse:status ${current.id}, /muse:result ${current.id}.\n`;
    print({ jobId: current.id, status: current.status, phase: current.phase }, rendered, json);
    return current;
  }
  print(current, current.rendered ?? `# muse ${current.kind} ${current.id} - ${current.status}\n\n${current.errorMessage ?? "No output was recorded."}\n\nLog: ${current.logFile}\n`, json);
  return current;
}

async function handleJobWorker(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv, { values: ["cwd", "job-id"] });
  const workspaceRoot = workspaceRootOf(resolve(stringOption(parsed, "cwd") ?? process.cwd()));
  const id = stringOption(parsed, "job-id");
  const job = id ? readJob(workspaceRoot, id) : null;
  if (!job) throw new Error(`No queued job found for ${id ?? "(missing --job-id)"}.`);
  if (!isActive(job)) return;
  if ((job.kind === "task" || job.kind === "transfer") && job.request) {
    const { kind, request } = job;
    await runJob(job, (hooks) => executeTask(kind, request, hooks));
  } else if ((job.kind === "review" || job.kind === "adversarial-review") && job.reviewRequest) {
    await runJob(job, reviewWork(job.kind, job.reviewRequest));
  } else {
    throw new Error(`Job ${job.id} has no stored request.`);
  }
}

function handleTaskResumeCandidate(argv: readonly string[]): void {
  const parsed = parseArgs(expandRawArguments(argv), { values: ["cwd"], booleans: ["json"] });
  const workspaceRoot = workspaceRootOf(resolve(stringOption(parsed, "cwd") ?? process.cwd()));
  const sessionJobs = latestSessionJobs(workspaceRoot);
  const running = sessionJobs.find((job) => isThreadJob(job) && isActive(job));
  const candidate = running ? undefined : resumableTask(sessionJobs);
  const payload = {
    available: Boolean(candidate),
    sessionId: currentSessionId() ?? null,
    candidate: candidate ? { id: candidate.id, kind: candidate.kind, status: candidate.status, summary: candidate.summary, conversationId: candidate.conversationId, profile: candidate.profile ?? null } : null
  };
  const rendered = candidate
    ? `Resumable muse ${candidate.kind}: ${candidate.id} (${candidate.status}) - ${candidate.summary}\n`
    : running ? `muse ${running.kind} ${running.id} is still running.\n` : "No resumable muse task for this session.\n";
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
  if (!job) throw new Error("No muse jobs for this session yet. Run /muse:status.");
  if (isActive(job) && flag(parsed, "wait")) {
    await awaitJob(job, flag(parsed, "json"));
    return;
  }
  if (isActive(job)) throw new Error(`Job ${job.id} is still ${job.status}. Check /muse:status ${job.id}, or wait with /muse:result ${job.id} --wait.`);
  const header = `# muse ${job.kind} ${job.id} - ${job.status}\n\n`;
  const body = job.rendered ?? `${job.errorMessage ?? "No output was recorded."}\n\nLog: ${job.logFile}\n`;
  print(job, header + body, flag(parsed, "json"));
}

async function cancelJob(job: Job, reason: string, graceMs?: number): Promise<Job> {
  const terminal = { status: "cancelled", phase: "cancelled", completedAt: nowIso(), errorMessage: reason } as const;
  // Mark first so the runner's completion write and any later muse-pid write are refused. Pids stay
  // in the record until both groups are stopped: muse's own group and the runner (detached worker,
  // or a foreground companion whose signal handler also stops muse). Then re-assert, race-free.
  const marked = updateJob(job.workspaceRoot, job.id, terminal);
  if (marked.status !== "cancelled") return marked; // It finished first; keep its real outcome.
  await Promise.all([terminateProcessTree(marked.musePid, graceMs), terminateProcessTree(marked.pid, graceMs)]);
  appendLog(job.logFile, reason);
  return forceUpdateJob(job.workspaceRoot, job.id, { ...terminal, pid: null, musePid: null });
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
      throw new Error(mine.length === 0 ? "No active muse jobs in this session." : "Several muse jobs are active. Pass a job id to /muse:cancel.");
    }
    job = mine[0];
  }
  const cancelled = await cancelJob(job, "Cancelled by user.");
  print(cancelled, `Cancelled muse ${job.kind} ${job.id}.\n`, flag(parsed, "json"));
}

// ---------- setup ----------

function conflictingPlugins(): string[] {
  const path = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(path)) return [];
  const installed = JSON.parse(readFileSync(path, "utf8")) as { plugins?: Record<string, unknown> };
  return Object.keys(installed.plugins ?? {}).filter((key) => key.startsWith("muse@") && key !== PLUGIN_ID);
}

function readUsage(): Allowance | null {
  try {
    return JSON.parse(readFileSync(usagePath(), "utf8")) as Allowance;
  } catch {
    return null;
  }
}

function quotaLines(usage: Allowance | null): string[] {
  if (!usage || (!usage.window && !usage.weekly)) return ["Quota: shown after the first muse run"];
  const resets = (ms: number | undefined): string => (ms ? `, resets ${new Date(ms).toLocaleString()}` : "");
  return [
    `Quota (as of ${usage.as_of_ms ? new Date(usage.as_of_ms).toLocaleString() : "the last muse run"}, last muse run):`,
    ...(usage.window ? [`  5h window: ${usage.window.used_percent}% used${resets(usage.window.resets_at_ms)}`] : []),
    ...(usage.weekly ? [`  Weekly: ${usage.weekly.used_percent}% used${resets(usage.weekly.resets_at_ms)}`] : [])
  ];
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
  const usage = readUsage();
  const contributor = availability.installed ? contributorMode() : null;
  const ready = availability.installed && availability.authenticated;
  const lines = [
    "# muse setup",
    "",
    `Status: ${ready ? "ready" : "not ready"}`,
    `Node.js: ${process.versions.node}`,
    `muse: ${availability.installed ? `${availability.version} (${museBin()})` : "not installed"}`,
    `Auth: ${availability.authenticated ? availability.detail : availability.installed ? `not ready - ${availability.detail}` : "-"}`,
    ...(availability.authenticated ? quotaLines(usage) : []),
    ...(contributor === null ? [] : [`Contributor mode: ${contributor ? "on (Meta may use session content for product improvement; change it in muse /settings)" : "off"}`]),
    `Stop-time review gate (${workspaceRoot}): ${config.stopReviewGate ? "enabled" : "disabled"}`
  ];
  if (!availability.installed) {
    lines.push("", "Install Muse Code: `curl -fsSL https://dev.meta.ai/install.sh | sh` (macOS, Linux) or `irm https://dev.meta.ai/install.ps1 | iex` (Windows).");
  } else if (!availability.authenticated) {
    lines.push("", "Sign in: run `!muse login` once and complete the browser sign-in. For an API key instead, export META_API_KEY or store one with `muse auth set --api-key-stdin`.");
  }
  if (conflicts.length > 0) {
    lines.push("", `Warning: ${conflicts.join(", ")} also uses the /muse: namespace. Uninstall it (/plugin uninstall ${conflicts[0]}) so /muse:* commands resolve to this plugin.`);
  }
  print({ ready, node: process.versions.node, availability, usage, contributorMode: contributor, conflicts, config, workspaceRoot }, `${lines.join("\n")}\n`, flag(parsed, "json"));
}

// ---------- hooks ----------

type HookInput = {
  readonly session_id?: string;
  readonly transcript_path?: string;
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
    input.transcript_path ? `export ${TRANSCRIPT_PATH_ENV}=${quote(input.transcript_path)}\n` : "",
    process.env.CLAUDE_PLUGIN_DATA ? `export ${DATA_DIR_ENV}=${quote(process.env.CLAUDE_PLUGIN_DATA)}\n` : ""
  ].join("");
  if (exports) appendFileSync(envFile, exports, "utf8");
}

/**
 * Claude Code gives plugin SessionEnd hooks 1.5s in all (their own `timeout` does not extend it), so
 * the SIGKILL fallback for a process that ignores SIGTERM must land well inside that.
 */
const SESSION_END_GRACE_MS = 800;

/** Session over: stop its running jobs but keep their records and results. */
async function hookSessionEnd(input: HookInput): Promise<void> {
  if (!input.session_id) return;
  // Every repository this session touched, not just the hook's cwd (jobs may use --cwd elsewhere).
  const active = forSession(listAllJobs(), input.session_id).filter(isActive);
  await Promise.all(active.map((job) => cancelJob(job, "Cancelled because the Claude session ended.", SESSION_END_GRACE_MS)));
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
  const { outcome, failure, treeWarning } = await runReadOnlyTurn({
    cwd: context.repoRoot,
    prompt: loadPrompt("stop-review-gate", {
      REVIEW_INPUT: fence(`${context.summary}\n\n${context.content}`),
      REPO_ROOT: context.repoRoot,
      CLAUDE_RESPONSE: fence(input.last_assistant_message?.trim() || "(no final message)")
    }),
    sessionId: randomUUID(),
    schemaPath: join(ROOT, "schemas", "stop-gate.schema.json"),
    maxModelSteps: STOP_GATE_MAX_MODEL_STEPS,
    deadlineMs: STOP_GATE_DEADLINE_MS
  });
  const warning = treeWarning ? `muse stop-time review: ${treeWarning}` : undefined;
  const note = (text: string): string => [text, warning].filter(Boolean).join(" ");
  if (failure) return { note: note(`muse stop-time review skipped: ${failure}`) };
  const verdict = asStopVerdict(parseStructured(outcome.terminal.text));
  if (!verdict) return { note: note("muse stop-time review skipped: muse returned no valid allow/block verdict.") };
  return verdict.decision === "block" ? { block: `muse stop-time review: ${verdict.reason}`, note: warning } : { note: warning };
}

/**
 * Opt-in stop gate. Blocks only on a concrete finding from muse. Anything else (gate off, re-entry,
 * clean tree, muse missing, auth, quota, timeout, bad output, local errors) allows the stop and
 * says why, so the gate can never trap the user.
 */
async function hookStop(input: HookInput): Promise<void> {
  let output: Record<string, string> | null;
  try {
    const workspaceRoot = workspaceRootOf(input.cwd ?? process.cwd());
    const decision = await stopGateDecision(input, workspaceRoot);
    if (decision.block) {
      output = { decision: "block", reason: decision.block, ...(decision.note ? { systemMessage: decision.note } : {}) };
    } else {
      const running = forSession(listJobs(workspaceRoot), input.session_id).filter(isActive);
      const runningNote = running[0] ? `muse job ${running[0].id} is still running (/muse:status, /muse:cancel).` : "";
      const message = [decision.note, runningNote].filter(Boolean).join(" ");
      output = message ? { systemMessage: message } : null;
    }
  } catch (error) {
    output = { systemMessage: `muse stop-time review skipped: ${error instanceof Error ? error.message : String(error)}` };
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
  transfer: handleTransfer,
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
    process.stdout.write(`Usage: muse-companion <${Object.keys(COMMANDS).join("|")}> [...]\n`);
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
