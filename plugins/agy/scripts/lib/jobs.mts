/**
 * Per-workspace job store. Each job lives in its own JSON file written atomically (tmp + rename),
 * so the foreground CLI, background workers, and hooks never race on a shared index file.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Profile } from "./agy.mts";

export const SESSION_ID_ENV = "AGY_COMPANION_SESSION_ID";
/**
 * This plugin's data dir. Not CLAUDE_PLUGIN_DATA: other plugins (the Codex plugin, for one) export
 * their own CLAUDE_PLUGIN_DATA into the session env, so Bash commands cannot trust it. Hooks get the
 * right CLAUDE_PLUGIN_DATA and SessionStart re-exports it under this name.
 */
export const DATA_DIR_ENV = "AGY_COMPANION_DATA";
const MAX_JOBS = 50;

export type JobKind = "review" | "adversarial-review" | "task";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ReviewRequest = {
  readonly cwd: string;
  readonly scope?: string;
  readonly base?: string;
  readonly focus: string;
  readonly model?: string;
};

export type TaskRequest = {
  readonly cwd: string;
  readonly prompt: string;
  readonly profile: Profile;
  readonly model?: string;
  readonly effort?: string;
  readonly conversationId?: string;
};

export type Job = {
  readonly id: string;
  readonly kind: JobKind;
  readonly title: string;
  readonly summary: string;
  readonly status: JobStatus;
  readonly phase: string;
  readonly workspaceRoot: string;
  readonly logFile: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sessionId?: string;
  readonly profile?: Profile;
  /** Companion or worker process running the job. */
  readonly pid?: number | null;
  /** agy's own process group leader (agy is spawned detached so cancel can kill its whole tree). */
  readonly agyPid?: number | null;
  readonly conversationId?: string | null;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly request?: TaskRequest;
  readonly reviewRequest?: ReviewRequest;
  readonly rendered?: string;
  readonly result?: unknown;
  readonly errorMessage?: string;
};

export type Config = { readonly stopReviewGate: boolean };

export const nowIso = (): string => new Date().toISOString();
export const isActive = (job: Job): boolean => job.status === "queued" || job.status === "running";

const stateRoot = (): string => {
  const dataDir = process.env[DATA_DIR_ENV];
  return dataDir ? join(dataDir, "state") : join(tmpdir(), "agy-companion");
};

export function stateDir(workspaceRoot: string): string {
  let canonical = workspaceRoot;
  try {
    canonical = realpathSync.native(workspaceRoot);
  } catch {
    // Keep the given path when it cannot be resolved; the hash just needs to be stable.
  }
  const slug = basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return join(stateRoot(), `${slug}-${hash}`);
}

const jobsDir = (workspaceRoot: string): string => join(stateDir(workspaceRoot), "jobs");
const jobFile = (workspaceRoot: string, id: string): string => join(jobsDir(workspaceRoot), `${id}.json`);
export const logFilePath = (workspaceRoot: string, id: string): string => join(jobsDir(workspaceRoot), `${id}.log`);

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function readConfig(workspaceRoot: string): Config {
  const path = join(stateDir(workspaceRoot), "config.json");
  if (!existsSync(path)) return { stopReviewGate: false };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  return { stopReviewGate: parsed.stopReviewGate === true };
}

export function writeConfig(workspaceRoot: string, config: Config): void {
  mkdirSync(stateDir(workspaceRoot), { recursive: true });
  writeJsonAtomic(join(stateDir(workspaceRoot), "config.json"), config);
}

export function generateJobId(kind: JobKind): string {
  const prefix = kind === "task" ? "task" : "review";
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createJob(fields: Omit<Job, "createdAt" | "updatedAt" | "logFile" | "sessionId">): Job {
  mkdirSync(jobsDir(fields.workspaceRoot), { recursive: true });
  const sessionId = process.env[SESSION_ID_ENV];
  const job: Job = {
    ...fields,
    logFile: logFilePath(fields.workspaceRoot, fields.id),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
  writeFileSync(job.logFile, "", "utf8");
  saveJob(job);
  pruneJobs(fields.workspaceRoot);
  return job;
}

export function saveJob(job: Job): Job {
  const next = { ...job, updatedAt: nowIso() };
  writeJsonAtomic(jobFile(job.workspaceRoot, job.id), next);
  return next;
}

export function readJob(workspaceRoot: string, id: string): Job | null {
  const path = jobFile(workspaceRoot, id);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Job) : null;
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Cross-process mutex on `path` (mkdir is atomic). The lock dir holds an owner token
 * `<pid>:<nonce>`; it is broken only when that pid is dead, and released only by its owner, so a
 * slow holder is never robbed and a successor's lock is never removed.
 */
export function withLock<T>(path: string, fn: () => T): T {
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  const ownerFile = join(path, "owner");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(ownerFile, token, "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      breakIfOrphaned(path, ownerFile);
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${path}.`);
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(ownerFile, "utf8") === token) rmSync(path, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
  }
}

/**
 * Orphan recovery is itself serialized (a `.recover` mutex) and re-reads ownership inside it, so a
 * recoverer can never delete a lock that another contender just broke and re-acquired.
 */
function breakIfOrphaned(path: string, ownerFile: string): void {
  const recover = `${path}.recover`;
  try {
    mkdirSync(recover);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Recovery takes microseconds; a recover dir this old was left by a crashed recoverer.
    if (ageMs(recover) > 30_000) rmSync(recover, { recursive: true, force: true });
    return;
  }
  try {
    const owner = Number(readFileSync(ownerFile, "utf8").split(":")[0]);
    if (Number.isInteger(owner) && owner > 0 && !isAlive(owner)) rmSync(path, { recursive: true, force: true });
  } catch {
    // No owner file: the holder is between mkdir and writing it (wait), or crashed right there; break
    // that case only once the directory is clearly stale.
    if (ageMs(path) > 30_000) rmSync(path, { recursive: true, force: true });
  } finally {
    rmSync(recover, { recursive: true, force: true });
  }
}

const ageMs = (path: string): number => {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

const withJobLock = <T,>(workspaceRoot: string, id: string, fn: () => T): T => withLock(`${jobFile(workspaceRoot, id)}.lock`, fn);

/** Serializes resume selection + job creation for one Claude session, so two resumes cannot share a thread. */
export const withSessionLock = <T,>(workspaceRoot: string, sessionId: string, fn: () => T): T => {
  mkdirSync(jobsDir(workspaceRoot), { recursive: true });
  return withLock(join(jobsDir(workspaceRoot), `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`), fn);
};

function transformJob(workspaceRoot: string, id: string, transform: (current: Job) => Job): Job {
  return withJobLock(workspaceRoot, id, () => {
    const current = readJob(workspaceRoot, id);
    if (!current) throw new Error(`Job ${id} disappeared from the job store.`);
    return transform(current);
  });
}

/** Terminal states are final: a worker finishing after /agy:cancel must not resurrect the job. */
export const updateJob = (workspaceRoot: string, id: string, patch: Partial<Job>): Job =>
  transformJob(workspaceRoot, id, (current) => (isActive(current) ? saveJob({ ...current, ...patch }) : current));

/** Unconditional write, for cancel re-asserting its terminal state once the processes are gone. */
export const forceUpdateJob = (workspaceRoot: string, id: string, patch: Partial<Job>): Job =>
  transformJob(workspaceRoot, id, (current) => saveJob({ ...current, ...patch }));

const isAlive = (pid: number | null | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * An active job whose runner process is gone died without recording an outcome (crash, SIGKILL,
 * reboot). Re-checked under the lock so a job that just finished is never overwritten, and any
 * agy process group it orphaned is stopped.
 */
export function reconcile(job: Job): Job {
  if (!isActive(job) || job.pid === undefined || job.pid === null || isAlive(job.pid)) return job;
  return withJobLock(job.workspaceRoot, job.id, () => {
    const current = readJob(job.workspaceRoot, job.id) ?? job;
    if (!isActive(current) || !current.pid || isAlive(current.pid)) return current;
    if (current.agyPid && treeAlive(current.agyPid)) signalGroup(current.agyPid, "SIGKILL");
    return saveJob({
      ...current,
      status: "failed",
      phase: "failed",
      pid: null,
      agyPid: null,
      completedAt: nowIso(),
      errorMessage: "The job's process exited without recording a result."
    });
  });
}

export const listJobs = (workspaceRoot: string): Job[] => readJobsDir(jobsDir(workspaceRoot));

/** Jobs of every workspace this plugin has state for. */
export function listAllJobs(): Job[] {
  const root = stateRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((store) => readJobsDir(join(root, store, "jobs")));
}

function readJobsDir(dir: string): Job[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(dir, name), "utf8")) as Job];
      } catch {
        return [];
      }
    })
    .map(reconcile)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneJobs(workspaceRoot: string): void {
  for (const job of listJobs(workspaceRoot).filter((j) => !isActive(j)).slice(MAX_JOBS)) {
    rmSync(jobFile(workspaceRoot, job.id), { force: true });
    rmSync(job.logFile, { force: true });
  }
}

export const currentSessionId = (): string | undefined => process.env[SESSION_ID_ENV] || undefined;

export function forSession(jobs: readonly Job[], sessionId: string | undefined): Job[] {
  return sessionId ? jobs.filter((job) => job.sessionId === sessionId) : [...jobs];
}

/** Exact id, else a unique prefix. */
export function matchJob(jobs: readonly Job[], reference: string): Job {
  const exact = jobs.find((job) => job.id === reference);
  if (exact) return exact;
  const prefixed = jobs.filter((job) => job.id.startsWith(reference));
  if (prefixed.length === 1 && prefixed[0]) return prefixed[0];
  if (prefixed.length > 1) throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  throw new Error(`No job found for "${reference}". Run /agy:status to list known jobs.`);
}

export function appendLog(logFile: string, message: string): void {
  const text = message.trim();
  if (text) appendFileSync(logFile, `[${nowIso()}] ${text}\n`, "utf8");
}

export function appendLogBlock(logFile: string, title: string, body: string): void {
  if (body.trim()) appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${body.trimEnd()}\n`, "utf8");
}

/** Last progress lines from a job log, skipping multi-line blocks. */
export function progressPreview(logFile: string, max = 4): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("["))
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter((line) => line && line !== "Final output")
    .slice(-max);
}

/** Signals the group led by `pid`, else the bare pid. ESRCH/EPERM mean "not ours to stop". */
function signalGroup(pid: number, sig: NodeJS.Signals): boolean {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, sig);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw error;
    }
  }
  return false;
}

/**
 * Stops a process group (a detached worker, or agy itself), falling back to the bare pid when it
 * leads no group: SIGTERM, wait up to graceMs, then SIGKILL. Returns false when nothing ran.
 */
/** A process group is alive while any member is, even after its leader exited. */
const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const treeAlive = (pid: number): boolean => groupAlive(pid) || isAlive(pid);

export async function terminateProcessTree(pid: number | null | undefined, graceMs = 3000): Promise<boolean> {
  if (!pid || !signalGroup(pid, "SIGTERM")) return false;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && treeAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (treeAlive(pid)) signalGroup(pid, "SIGKILL");
  return true;
}
