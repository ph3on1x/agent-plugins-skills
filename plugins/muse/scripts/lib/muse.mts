/**
 * Runs one headless Muse Code turn: `muse exec --json --prompt-file <f> --session-id <id>`.
 * exec never reads stdin, so the prompt goes through a private temp file (no argv size limit).
 * Records stream back as JSONL envelopes, and the last `run.terminal.*` record is the turn outcome.
 * The record format is undocumented (observed on Muse Code 1.4.11; see scripts/fixtures/).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { queryMuse } from "./msp.mts";

export type Profile = "read-only" | "write" | "full-access";

export type Terminal = { readonly terminal: string; readonly text: string; readonly reason: string | null };

export type Window = { readonly used_percent: number; readonly resets_at_ms?: number };
export type Allowance = { readonly window?: Window | null; readonly weekly?: Window | null; readonly as_of_ms?: number };

export type Progress = { readonly message: string; readonly phase?: string; readonly conversationId?: string };

export type TurnRequest = {
  readonly cwd: string;
  readonly prompt: string;
  readonly profile: Profile;
  /** Passed as --session-id: a new id creates the session, a known one continues it. */
  readonly sessionId: string;
  readonly model?: string;
  readonly effort?: string;
  readonly schemaPath?: string;
  readonly maxModelSteps?: number;
  /** muse has no turn deadline of its own; the runtime stops it once this passes. */
  readonly deadlineMs?: number;
  readonly onProgress?: (progress: Progress) => void;
  /** Receives muse's pid (also its process group id) as soon as it starts. */
  readonly onSpawn?: (pid: number) => void;
};

export type TurnOutcome = {
  readonly terminal: Terminal;
  /** The session muse reported; always the requested one (a mismatch aborts the turn). */
  readonly sessionId: string;
  readonly model?: string;
  readonly touchedFiles: readonly string[];
  /** Any write/edit tool proposal or edit record, allowed or denied, with or without a path. */
  readonly editToolUsed: boolean;
  readonly allowance?: Allowance;
  readonly stderr: string;
  readonly exitCode: number;
};

/** Read per call so tests (and users) can point at another binary via MUSE_COMPANION_MUSE_BIN. */
export const museBin = (): string => process.env.MUSE_COMPANION_MUSE_BIN || "muse";
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_LINE_CHARS = 32 * 1024 * 1024;
const EDIT_TASKS = new Set(["tool.write_file", "tool.edit_file"]);

export const READ_ONLY_PROFILE_ID = "muse_companion_ro";

/**
 * Every run replaces the user's whole `permissions` setting for that run only, so no user default
 * profile or broken user profile can change what a plugin run may do. Muse's built-in read-only
 * profiles ask a human before writes, which hangs a headless run, so read-only is a custom profile
 * on top of `:read-only` that denies instead of asking:
 * - read-only: reads anywhere, writes nowhere (temp included), no network for shell commands;
 *   `--disable-write` also removes the file-writing tools.
 * - write: approval never, Muse's default sandbox: the workspace and temp dirs are writable (its
 *   `.git` is not), network through Muse's proxy.
 * - full-access: Muse's built-in `:unrestricted`, no sandbox at all.
 */
const permissions = (profiles: Readonly<Record<string, unknown>>): string => `permissions=${JSON.stringify({ schema_version: 1, profiles })}`;

const PROFILE_ARGS: Readonly<Record<Profile, readonly string[]>> = {
  "read-only": [
    "-c", permissions({ [READ_ONLY_PROFILE_ID]: { extends: ":read-only", approval: "allow_all", reviewer: "none" } }),
    "--permission-profile", READ_ONLY_PROFILE_ID,
    "--disable-write"
  ],
  write: ["-c", permissions({}), "--approval-mode", "never"],
  "full-access": ["-c", permissions({}), "--permission-profile", ":unrestricted"]
};

/**
 * Passed on every run, resumes included: a session resumed without safety flags keeps the profile
 * of its last run. Headless runs cannot answer questions, `~/.claude` rules are written for Claude
 * Code (not Muse), and the user's Muse hooks would fire outside the sandbox for invisible runs.
 */
const FIXED_ARGS = ["--disable-request-user-input", "--no-foreign-personal-context", "-c", "hooks={}"] as const;

export function buildMuseArgs(request: Omit<TurnRequest, "cwd" | "prompt" | "onProgress" | "onSpawn" | "deadlineMs">, promptFile: string): string[] {
  return [
    "exec", "--json",
    "--prompt-file", promptFile,
    "--session-id", request.sessionId,
    ...FIXED_ARGS,
    ...PROFILE_ARGS[request.profile],
    ...(request.model ? ["--model", request.model] : []),
    ...(request.effort ? ["--reasoning-effort", request.effort] : []),
    // A schema run has one final answer. Muse's reminder agents can reopen a finished turn, which
    // adds a second answer and breaks the JSON result.
    ...(request.schemaPath ? ["--output-schema", request.schemaPath, "--disable-reminders"] : []),
    ...(request.maxModelSteps ? ["--max-model-steps", String(request.maxModelSteps)] : [])
  ];
}

/**
 * The environment muse runs with. Muse treats CLAUDE_PLUGIN_ROOT/DATA as its own plugin variables,
 * and MUSE_PERMISSION_PROFILE_FAIL_OPEN would let an unknown profile run unrestricted.
 */
export function museEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const dropped = new Set(["CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDE_ENV_FILE", "MUSE_PERMISSION_PROFILE_FAIL_OPEN"]);
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !dropped.has(entry[0]) && !entry[0].startsWith("MUSE_COMPANION_"))
  );
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export type MuseRecord = { readonly payload_type: string; readonly payload: Readonly<Record<string, unknown>>; readonly stream?: { readonly kind?: string; readonly id?: string } };

/** Parses one JSONL line into a structurally valid record; anything else is ignored. */
export function parseRecord(line: string): MuseRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.payload_type !== "string" || !isObject(value.payload)) return null;
  return value as MuseRecord;
}

const shorten = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** `tool.result.text` for bash is JSON with the command and its exit code. */
function bashSummary(text: string): string {
  try {
    const value = JSON.parse(text) as { command?: unknown; exit_code?: unknown };
    return `Ran: ${shorten(str(value.command))}${typeof value.exit_code === "number" ? ` (exit ${value.exit_code})` : ""}`;
  } catch {
    return "Ran a shell command";
  }
}

export type TurnState = {
  sessionId: string | null;
  model?: string;
  terminal: Terminal | null;
  allowance?: Allowance;
  readonly touched: string[];
  editToolUsed: boolean;
};

/** Applies one record to the turn state; returns the progress lines worth logging. */
export function foldRecord(state: TurnState, record: MuseRecord, profile: Profile): Progress[] {
  const progress: Progress[] = [];
  if (record.stream?.kind === "session" && record.stream.id && state.sessionId === null) {
    state.sessionId = record.stream.id;
    progress.push({ message: `Muse session ${record.stream.id} started (${profile})`, phase: "starting", conversationId: record.stream.id });
  }
  const own = applyRecord(state, record);
  return own ? [...progress, own] : progress;
}

function applyRecord(state: TurnState, record: MuseRecord): Progress | null {
  const { payload } = record;
  switch (record.payload_type) {
    case "run.model.configured":
      state.model = str(payload.model_id) || undefined;
      return (state.model ? { message: `Model: ${state.model}` } : null);
    case "task.lifecycle.proposed": {
      const kind = isObject(payload.event) ? str(payload.event.task_kind) : "";
      if (EDIT_TASKS.has(kind)) state.editToolUsed = true;
      const quiet = !kind.startsWith("tool.") || kind === "tool.bash" || EDIT_TASKS.has(kind);
      return (quiet ? null : { message: `Tool ${kind.slice("tool.".length)}`, phase: "investigating" });
    }
    case "tool.result": {
      const facts = isObject(payload.correlation_facts) ? payload.correlation_facts : {};
      const success = facts.outcome === "success";
      if (isObject(payload.edit_facts)) {
        state.editToolUsed = true;
        const path = str(payload.edit_facts.path);
        if (success && path && !state.touched.includes(path)) state.touched.push(path);
        return (path ? { message: `${success ? "Edited" : "Edit refused"}: ${path}`, phase: "editing" } : null);
      }
      return (facts.tool_name === "bash" ? { message: bashSummary(str(payload.text)), phase: "running" } : null);
    }
    case "run.usage":
      if (isObject(payload.allowance)) state.allowance = payload.allowance as Allowance;
      return null;
    default:
      if (record.payload_type.startsWith("run.terminal.")) {
        state.terminal = { terminal: str(payload.terminal) || record.payload_type.slice("run.terminal.".length), text: str(payload.text), reason: str(payload.reason) || null };
      }
      return null;
  }
}

/** muse's own notices on stderr carry no failure information. */
const NOTICE = /^(muse: (workspace root|Agent delegation|Including)|usage: muse |tip: )/;

/** The failure lines of muse's stderr (`run ended with Failed: …`, `error: …`), without its notices. */
export function summarizeStderr(stderr: string): string {
  return stderr.split("\n").map((l) => l.trim()).filter((l) => l && !NOTICE.test(l)).slice(-3).join("\n");
}

export const newTurnState = (): TurnState => ({ sessionId: null, terminal: null, touched: [], editToolUsed: false });

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

/** Write runs sandbox shell commands, so a permission error there usually means the task needs full access. */
export const sandboxHint = (profile: Profile, text: string): string =>
  profile === "write" && /operation not permitted/i.test(text)
    ? " Shell commands run in a sandbox that blocks writes outside the workspace and in .git; re-run with --full-access if muse must commit, install, or write elsewhere."
    : "";

const noResult = (stderr: string, code: number | null, signal: NodeJS.Signals | null, profile: Profile): Error => {
  const detail = summarizeStderr(stderr) || (signal ? `terminated by ${signal}` : `exit ${code}`);
  const hint = /missing meta credentials/.test(stderr) ? " Run /muse:setup." : sandboxHint(profile, stderr);
  return new Error(`muse produced no result: ${detail}${hint}`);
};

export function runMuseTurn(request: TurnRequest): Promise<TurnOutcome> {
  return new Promise((resolvePromise, reject) => {
    // exec reads its prompt only from argv or a file; a private file keeps it out of argv and the repo.
    const promptDir = mkdtempSync(join(tmpdir(), "muse-companion-"));
    const promptFile = join(promptDir, "prompt.md");
    // shortcut: a SIGKILLed worker leaves this dir behind for the OS tmp reaper; sweep it if that shows up.
    writeFileSync(promptFile, request.prompt, { encoding: "utf8", mode: 0o600 });
    const removePrompt = (): void => rmSync(promptDir, { recursive: true, force: true });

    const start = () => {
      try {
        // detached: muse leads its own process group, so stopping it also stops what it spawned.
        return spawn(museBin(), buildMuseArgs(request, promptFile), { cwd: request.cwd, env: museEnv(process.env), stdio: ["ignore", "pipe", "pipe"], detached: true });
      } catch (error) {
        removePrompt();
        throw error;
      }
    };
    const child = start();
    const state = newTurnState();
    let stderr = "";
    let buffered = "";
    let failure: Error | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const signalMuse = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };
    /** SIGTERM lets muse flush its session log and stop its tools; SIGKILL follows after 3s. */
    const abort = (error: Error): void => {
      failure ??= error;
      signalMuse("SIGTERM");
      killTimer ??= setTimeout(() => signalMuse("SIGKILL"), 3000);
    };
    const guarded = (fn: () => void): void => {
      try {
        fn();
      } catch (error) {
        abort(asError(error));
      }
    };
    // Installed before anything can fail: cancel (SIGTERM), Ctrl-C, or hangup must take muse down too.
    const onSignal = (): void => abort(new Error("muse run stopped by a signal."));
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    signals.forEach((sig) => process.on(sig, onSignal));
    if (request.deadlineMs) {
      deadlineTimer = setTimeout(() => abort(new Error(`muse did not finish within ${Math.round((request.deadlineMs ?? 0) / 1000)}s; stopped it.`)), request.deadlineMs);
    }
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      signals.forEach((sig) => process.off(sig, onSignal));
      clearTimeout(killTimer);
      clearTimeout(deadlineTimer);
      removePrompt();
      finish();
    };

    const handleLine = (line: string): void => {
      const record = parseRecord(line);
      if (!record) return;
      const before = state.sessionId;
      const progress = foldRecord(state, record, request.profile);
      if (before === null && state.sessionId !== null && state.sessionId !== request.sessionId) {
        throw new Error(`muse reported session ${state.sessionId}, not the requested ${request.sessionId}; stopped it.`);
      }
      for (const p of progress) request.onProgress?.(p);
    };

    const pid = child.pid;
    if (pid) guarded(() => request.onSpawn?.(pid));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      guarded(() => parts.forEach(handleLine));
      if (buffered.length > MAX_LINE_CHARS) {
        buffered = "";
        abort(new Error(`muse emitted a record over ${MAX_LINE_CHARS} characters; stopped it.`));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(() => reject(new Error(error.code === "ENOENT" ? `${museBin()} is not installed or not on PATH. Run /muse:setup.` : error.message)));
    });
    child.on("close", (code, signal) => {
      // After an abort, muse's descendants can outlive it (closing stdio only proves the leader exited).
      if (failure) signalMuse("SIGKILL");
      if (buffered) guarded(() => handleLine(buffered));
      settle(() => {
        const { terminal, sessionId } = state;
        if (failure) reject(failure);
        else if (!terminal || !sessionId) reject(noResult(stderr, code, signal, request.profile));
        else {
          resolvePromise({
            terminal,
            sessionId,
            ...(state.model ? { model: state.model } : {}),
            touchedFiles: [...state.touched],
            editToolUsed: state.editToolUsed,
            ...(state.allowance ? { allowance: state.allowance } : {}),
            stderr,
            exitCode: code ?? 1
          });
        }
      });
    });
  });
}

/** Defense in depth: read-only runs have no file-writing tools, so any edit record means the boundary broke. */
export function readOnlyBreach(outcome: TurnOutcome): string | null {
  if (outcome.touchedFiles.length > 0) {
    return `muse edited files during a read-only run (${outcome.touchedFiles.join(", ")}); treat the read-only boundary as broken.`;
  }
  return outcome.editToolUsed ? "muse used an edit tool during a read-only run; treat the read-only boundary as broken." : null;
}

/**
 * A turn succeeded only if muse completed it, exited 0, and answered. With --output-schema the
 * answer text is the JSON itself, so empty text is a failure either way.
 */
export function turnFailure(outcome: TurnOutcome): string | null {
  const { terminal } = outcome;
  if (terminal.terminal !== "completed") return terminal.reason || summarizeStderr(outcome.stderr) || `muse ended the run as ${terminal.terminal}.`;
  if (outcome.exitCode !== 0) return summarizeStderr(outcome.stderr) || `muse exited with code ${outcome.exitCode}.`;
  if (!terminal.text.trim()) return "muse returned an empty response.";
  return null;
}

/** For read-only runs: a broken boundary is reported even when the turn also failed for another reason. */
export function readOnlyFailure(outcome: TurnOutcome): string | null {
  const failures = [turnFailure(outcome), readOnlyBreach(outcome)].filter((f): f is string => f !== null);
  return failures.length > 0 ? failures.join(" ") : null;
}

/** The structured answer of a --output-schema run, or undefined when the text is not JSON. */
export function parseStructured(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Muse models write paths as markdown links (`[calc.py](/repo/calc.py:1)`) even in schema fields;
 * reviews need the plain path, relative to the repository when it is inside it.
 */
export function plainPath(file: string, repoRoot: string): string {
  const link = /^\[[^\]]*\]\(([^)]+)\)$/.exec(file.trim());
  // Drop a line suffix (`:4`, `:4-9`, `#L4`, `#L4-L9`) on bare paths and link targets alike.
  const target = (link?.[1] ?? file.trim()).replace(/(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/, "");
  if (!isAbsolute(target)) return target;
  const rel = relative(repoRoot, resolve(target));
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : target;
}

export function normalizeReview(value: unknown, repoRoot: string): unknown {
  if (!isObject(value) || !Array.isArray(value.findings)) return value;
  return {
    ...value,
    findings: value.findings.map((f) => (isObject(f) && typeof f.file === "string" ? { ...f, file: plainPath(f.file, repoRoot) } : f))
  };
}

export type ModelEntry = { readonly id: string; readonly releaseDate: string };

export function parseModels(result: unknown): ModelEntry[] {
  const models = isObject(result) && Array.isArray(result.models) ? result.models : [];
  return models.filter(isObject).map((m) => ({ id: str(m.modelId), releaseDate: str(m.releaseDate) })).filter((m) => m.id);
}

const ALIAS = /^(spark|wonder)$/;

const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * `spark`/`wonder` resolve to the newest `muse-spark-X.Y`/`muse-wonder-X.Y` in Muse's model list,
 * so aliases never go stale (Muse itself has none). `-contributor` variants are never picked.
 * Anything else is passed through for Muse to validate.
 */
export function resolveModelAlias(requested: string, models: readonly ModelEntry[]): string {
  const match = ALIAS.exec(requested.toLowerCase());
  if (!match) return requested;
  const family = match[1];
  const pattern = new RegExp(`^muse-${family}-(\\d+(?:\\.\\d+)*)$`);
  const best = models
    .map((m) => ({ ...m, version: pattern.exec(m.id)?.[1] }))
    .filter((m): m is ModelEntry & { version: string } => m.version !== undefined)
    .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || compareVersions(b.version, a.version))[0];
  if (!best) throw new Error(`No Muse ${family} model is available to this account. Run /muse:setup.`);
  return best.id;
}

export const needsModelLookup = (requested: string): boolean => ALIAS.test(requested.toLowerCase());

export const listModels = (): ModelEntry[] => parseModels(queryMuse(museBin(), ["model/list"], museEnv(process.env))["model/list"]);

export type Account = { readonly state: string; readonly credentialRequired?: boolean };

export type Availability = {
  readonly installed: boolean;
  readonly version: string | null;
  readonly authenticated: boolean;
  /** How muse is signed in when ready, otherwise the reason it is not. */
  readonly detail: string;
};

const ACCOUNT_LABELS: Readonly<Record<string, string>> = {
  accountLogin: "signed in (Meta account)",
  envKey: "signed in (META_API_KEY)",
  apiKey: "signed in (stored API key)"
};

/** A signed-out account is the only state that is not ready, unless the provider needs no credential. */
export function describeAccount(account: Account): { readonly authenticated: boolean; readonly detail: string } {
  if (account.credentialRequired === false) return { authenticated: true, detail: "no credential required" };
  if (account.state === "loggedOut") return { authenticated: false, detail: "signed out" };
  return { authenticated: true, detail: ACCOUNT_LABELS[account.state] ?? `signed in (${account.state})` };
}

/** `muse --version`, then the account over MSP: no model call, so it costs no quota. */
export function checkAvailability(): Availability {
  const version = spawnSync(museBin(), ["--version"], { encoding: "utf8", timeout: 15_000, env: museEnv(process.env) });
  if (version.error || version.status !== 0) {
    return { installed: false, version: null, authenticated: false, detail: version.error?.message ?? ((version.stderr ?? "").trim() || "muse --version failed") };
  }
  try {
    const account = queryMuse(museBin(), ["account/read"], museEnv(process.env))["account/read"];
    const { authenticated, detail } = describeAccount(isObject(account) ? (account as Account) : { state: "unknown" });
    return { installed: true, version: version.stdout.trim(), authenticated, detail };
  } catch (error) {
    return { installed: true, version: version.stdout.trim(), authenticated: false, detail: asError(error).message };
  }
}

/** The user's Muse contributor-mode setting (session content may be used for product improvement). */
export function contributorMode(): boolean | null {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  try {
    const settings = JSON.parse(readFileSync(join(config, "muse", "settings.json"), "utf8")) as { contributor_mode_enabled?: unknown };
    return typeof settings.contributor_mode_enabled === "boolean" ? settings.contributor_mode_enabled : null;
  } catch {
    return null;
  }
}
