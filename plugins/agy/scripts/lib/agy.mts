/**
 * Runs one headless Antigravity turn: `agy --input-format stream-json --output-format stream-json`.
 * The prompt goes over stdin as one NDJSON user message (no argv size limit), events stream back
 * as NDJSON, and the final `result` event is the turn outcome.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Profile = "read-only" | "write" | "full-access";

export type DeniedAction = { readonly action: string; readonly display_name?: string };

export type AgyResult = {
  readonly conversation_id: string;
  readonly status: "SUCCESS" | "ERROR";
  readonly response: string;
  readonly error?: string;
  readonly duration_seconds?: number;
  readonly num_turns?: number;
  readonly denied_actions?: readonly DeniedAction[];
  readonly structured_output?: unknown;
};

export type StepUpdate = {
  readonly step_index: number;
  readonly state: string;
  readonly step_type: string;
  readonly tool_name?: string;
  readonly tool_info?: { readonly parameters?: Readonly<Record<string, unknown>>; readonly output?: string };
};

export type AgyEvent =
  | { readonly event: "init"; readonly conversation_id: string; readonly init: { readonly model?: string; readonly permission_mode?: string } }
  | { readonly event: "step_update"; readonly step_update: StepUpdate }
  | { readonly event: "result"; readonly result: AgyResult };

export type Progress = { readonly message: string; readonly phase?: string; readonly conversationId?: string };

export type TurnRequest = {
  readonly cwd: string;
  readonly prompt: string;
  readonly profile: Profile;
  readonly model?: string;
  readonly effort?: string;
  readonly conversationId?: string;
  readonly schemaPath?: string;
  /** agy's own turn deadline, e.g. "780s"; agy ends the turn with an error when it passes. */
  readonly printTimeout?: string;
  readonly onProgress?: (progress: Progress) => void;
  /** Receives agy's pid (also its process group id) as soon as it starts. */
  readonly onSpawn?: (pid: number) => void;
};

export type TurnOutcome = {
  readonly result: AgyResult;
  readonly touchedFiles: readonly string[];
  /** Any edit-tool step, finished or not, with or without a target path. */
  readonly editToolUsed: boolean;
  readonly stderr: string;
  readonly exitCode: number;
};

/** Read per call so tests (and users) can point at another binary via AGY_COMPANION_AGY_BIN. */
export const agyBin = (): string => process.env.AGY_COMPANION_AGY_BIN || "agy";
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_LINE_CHARS = 32 * 1024 * 1024;
const WRITE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"]);

/** Holds `.agents/agents/agy-read-only.md`; agy discovers custom agents in every workspace dir. */
export const READ_ONLY_AGENT_HOME = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agent-home");
export const READ_ONLY_AGENT = "agy-read-only";

/**
 * Headless agy auto-denies any permission it would ask for and ends the turn, so every profile
 * skips prompts and bounds the run structurally instead:
 * - read-only: custom agent with no file-editing tools, shell commands in the write-blocking sandbox.
 * - write: default agent (edit tools allowed), shell commands still sandboxed: they can read, test,
 *   and use the network, but cannot write to disk outside temp dirs.
 * - full-access: no sandbox at all. agy has no workspace-only write mode, so this is unrestricted.
 */
const PROFILE_ARGS: Readonly<Record<Profile, readonly string[]>> = {
  "read-only": ["--agent", READ_ONLY_AGENT, "--add-dir", READ_ONLY_AGENT_HOME, "--sandbox", "--dangerously-skip-permissions"],
  write: ["--sandbox", "--dangerously-skip-permissions"],
  "full-access": ["--dangerously-skip-permissions"]
};

export function buildAgyArgs(request: Omit<TurnRequest, "cwd" | "prompt" | "onProgress">): string[] {
  return [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--disable-slash-commands",
    ...PROFILE_ARGS[request.profile],
    ...(request.model ? ["--model", request.model] : []),
    ...(request.effort ? ["--effort", request.effort] : []),
    ...(request.conversationId ? ["--conversation", request.conversationId] : []),
    ...(request.schemaPath ? ["--json-schema", request.schemaPath] : []),
    ...(request.printTimeout ? ["--print-timeout", request.printTimeout] : [])
  ];
}

export const encodeUserMessage = (prompt: string): string =>
  `${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses one NDJSON line into a known, structurally valid event; anything else is ignored. */
export function parseEventLine(line: string): AgyEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  if (value.event === "init" && typeof value.conversation_id === "string" && isObject(value.init)) return value as AgyEvent;
  if (value.event === "step_update" && isObject(value.step_update)) return value as AgyEvent;
  if (value.event === "result" && isObject(value.result) && typeof value.result.status === "string") {
    return { event: "result", result: { ...value.result, response: typeof value.result.response === "string" ? value.result.response : "" } as AgyResult };
  }
  return null;
}

const shorten = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function toolTarget(step: StepUpdate): string {
  const params = step.tool_info?.parameters ?? {};
  const value = params.CommandLine ?? params.TargetFile ?? params.AbsolutePath ?? params.Url ?? params.Query ?? "";
  return typeof value === "string" ? shorten(value) : "";
}

/** Progress line for a step, or null when the step is not worth logging. */
export function describeStep(step: StepUpdate): Progress | null {
  if (step.step_type !== "tool" || step.state !== "ACTIVE" || !step.tool_name) return null;
  const target = toolTarget(step);
  if (step.tool_name === "run_command") return { message: `Running command: ${target}`, phase: "running" };
  if (WRITE_TOOLS.has(step.tool_name)) return { message: `Editing: ${target}`, phase: "editing" };
  return { message: `Tool ${step.tool_name}${target ? `: ${target}` : ""}`, phase: "investigating" };
}

const isEditStep = (step: StepUpdate): boolean => step.tool_name !== undefined && WRITE_TOOLS.has(step.tool_name);

export function collectTouchedFiles(steps: readonly StepUpdate[]): string[] {
  const files = steps
    .filter((s) => s.state === "DONE" && isEditStep(s))
    .map((s) => s.tool_info?.parameters?.TargetFile)
    .filter((f): f is string => typeof f === "string" && f.length > 0);
  return [...new Set(files)];
}

/** Last `AGY_ERROR: {...}` line agy prints on model/agent failures, else the stderr tail. */
export function summarizeStderr(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const agyError = lines.filter((l) => l.startsWith("AGY_ERROR:")).at(-1);
  return agyError ?? lines.slice(-5).join("\n");
}

export function deniedSummary(result: AgyResult): string | null {
  const denied = result.denied_actions ?? [];
  if (denied.length === 0) return null;
  const names = denied.map((d) => d.display_name ? `${d.display_name} (${d.action})` : d.action).join(", ");
  return `agy stopped because headless mode auto-denied: ${names}.`;
}

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

export function runAgyTurn(request: TurnRequest): Promise<TurnOutcome> {
  return new Promise((resolve, reject) => {
    // detached: agy leads its own process group, so stopping it also stops every command it spawned.
    const child = spawn(agyBin(), buildAgyArgs(request), { cwd: request.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const steps: StepUpdate[] = [];
    let result: AgyResult | null = null;
    let stderr = "";
    let buffered = "";
    let failure: Error | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const signalAgy = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };
    /** Stops agy's whole group (TERM, KILL after 3s); the turn settles with `error` once agy exits. */
    const abort = (error: Error): void => {
      failure ??= error;
      signalAgy("SIGTERM");
      killTimer ??= setTimeout(() => signalAgy("SIGKILL"), 3000);
    };
    const guarded = (fn: () => void): void => {
      try {
        fn();
      } catch (error) {
        abort(asError(error));
      }
    };
    // Installed before anything can fail: cancel (SIGTERM), Ctrl-C, or hangup must take agy down too.
    const onSignal = (): void => abort(new Error("agy run stopped by a signal."));
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    signals.forEach((sig) => process.on(sig, onSignal));
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      signals.forEach((sig) => process.off(sig, onSignal));
      clearTimeout(killTimer);
      finish();
    };

    const handleLine = (line: string): void => {
      const event = parseEventLine(line);
      if (!event) return;
      if (event.event === "init") {
        request.onProgress?.({
          message: `agy conversation ${event.conversation_id} started (model ${event.init.model ?? "default"}, ${request.profile})`,
          phase: "starting",
          conversationId: event.conversation_id
        });
      } else if (event.event === "step_update") {
        steps.push(event.step_update);
        const progress = describeStep(event.step_update);
        if (progress) request.onProgress?.(progress);
      } else {
        result = event.result;
      }
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
        abort(new Error(`agy emitted an event line over ${MAX_LINE_CHARS} characters; stopped it.`));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(() => reject(new Error(error.code === "ENOENT" ? `${agyBin()} is not installed or not on PATH. Run /agy:setup.` : error.message)));
    });
    child.on("close", (code, signal) => {
      // After an abort, agy's descendants can outlive it (closing stdio only proves the leader exited).
      if (failure) signalAgy("SIGKILL");
      if (buffered) guarded(() => handleLine(buffered));
      settle(() => {
        const final = result as AgyResult | null;
        if (failure) reject(failure);
        else if (!final) reject(new Error(`agy produced no result event: ${summarizeStderr(stderr) || (signal ? `terminated by ${signal}` : `exit ${code}`)}`));
        else resolve({ result: final, touchedFiles: collectTouchedFiles(steps), editToolUsed: steps.some(isEditStep), stderr, exitCode: code ?? 1 });
      });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(encodeUserMessage(request.prompt));
  });
}

/** Defense in depth: the read-only agent has no edit tools, so any edit step means the boundary broke. */
export function readOnlyBreach(outcome: TurnOutcome): string | null {
  if (outcome.touchedFiles.length > 0) {
    return `agy edited files during a read-only run (${outcome.touchedFiles.join(", ")}); treat the read-only boundary as broken.`;
  }
  return outcome.editToolUsed ? "agy used an edit tool during a read-only run; treat the read-only boundary as broken." : null;
}

const hasAnswer = (result: AgyResult): boolean => result.response.trim() !== "" || result.structured_output !== undefined;

/**
 * agy 1.2.15 bug: once any model call in a conversation failed and agy's retry recovered, every
 * later result of that conversation still says status ERROR with that old message. agy's exit code
 * and `AGY_ERROR:` stderr line are its documented failure signals, so an ERROR status with exit 0,
 * no AGY_ERROR line, and a real answer is that stale report. Returns its message for display.
 */
export function staleError(outcome: TurnOutcome): string | null {
  const { result } = outcome;
  const stale = result.status === "ERROR" && outcome.exitCode === 0 && !outcome.stderr.includes("AGY_ERROR:") && hasAnswer(result);
  return stale ? result.error || "unspecified error" : null;
}

/**
 * A turn succeeded only if agy says so, exited 0, produced output, and was not cut short by a
 * denial (a denied turn is incomplete even when agy wrote a partial answer first).
 */
export function turnFailure(outcome: TurnOutcome): string | null {
  const { result } = outcome;
  if (result.status !== "SUCCESS" && !staleError(outcome)) return result.error || summarizeStderr(outcome.stderr) || `agy ended with status ${result.status}.`;
  if (outcome.exitCode !== 0) return summarizeStderr(outcome.stderr) || `agy exited with code ${outcome.exitCode}.`;
  const denied = deniedSummary(result);
  if (denied) return denied;
  if (!result.response.trim() && result.structured_output === undefined) return "agy returned an empty response.";
  return null;
}

/** For read-only runs: a broken boundary is reported even when the turn also failed for another reason. */
export function readOnlyFailure(outcome: TurnOutcome): string | null {
  const failures = [turnFailure(outcome), readOnlyBreach(outcome)].filter((f): f is string => f !== null);
  return failures.length > 0 ? failures.join(" ") : null;
}

export type ModelEntry = { readonly id: string; readonly label: string };

export function parseModels(stdout: string): ModelEntry[] {
  return stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length >= 2 && /^[a-z0-9][a-z0-9.-]*$/.test(cols[0]?.trim() ?? ""))
    .map((cols) => ({ id: (cols[0] ?? "").trim(), label: (cols[1] ?? "").trim() }));
}

const ALIAS = /^(flash|pro)(?:-(high|medium|med|low))?$/;

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
 * `flash`/`pro` (+ `-high|-medium|-low`) resolve to the newest matching Gemini id in `agy models`,
 * so aliases never go stale. Gemini ids encode the effort level and agy rejects a conflicting
 * `--effort`, so a level-less alias takes its level from `effort` when that names one.
 * Anything else is passed through for agy to validate.
 */
export function resolveModelAlias(requested: string, models: readonly ModelEntry[], effort?: string): string {
  const match = ALIAS.exec(requested.toLowerCase());
  if (!match) return requested;
  const family = match[1];
  const effortLevel = effort === "low" || effort === "medium" || effort === "high" ? effort : undefined;
  const level = match[2] === "med" ? "medium" : (match[2] ?? effortLevel ?? "high");
  const pattern = new RegExp(`^gemini-(\\d+(?:\\.\\d+)*)-${family}-${level}$`);
  const candidates = models
    .map((m) => ({ id: m.id, version: pattern.exec(m.id)?.[1] }))
    .filter((c): c is { id: string; version: string } => c.version !== undefined)
    .sort((a, b) => compareVersions(b.version, a.version));
  const best = candidates[0];
  if (!best) {
    throw new Error(`No Gemini ${family} model with ${level} level is available. Run \`agy models\` to list models.`);
  }
  return best.id;
}

export function listModels(): ModelEntry[] {
  const result = spawnSync(agyBin(), ["models"], { encoding: "utf8", timeout: 60_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`\`agy models\` failed: ${result.error?.message ?? summarizeStderr(result.stderr ?? "") ?? `exit ${result.status}`}`);
  }
  return parseModels(result.stdout);
}

export const needsModelLookup = (requested: string): boolean => ALIAS.test(requested.toLowerCase());

export type Availability = {
  readonly installed: boolean;
  readonly version: string | null;
  readonly authenticated: boolean;
  /** Gemini quota lines from `/usage` when signed in, otherwise the reason it is not ready. */
  readonly detail: string;
};

/**
 * `agy -p /usage` needs a signed-in account but no agent turn, so it costs no quota.
 * Only Gemini quota is kept: the plugin targets Gemini, and agy's separate Claude/GPT pool reads
 * as the user's Claude Code limits.
 */
export function checkAvailability(): Availability {
  const version = spawnSync(agyBin(), ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (version.error || version.status !== 0) {
    return { installed: false, version: null, authenticated: false, detail: version.error?.message ?? (version.stderr.trim() || "agy --version failed") };
  }
  const usage = spawnSync(agyBin(), ["-p", "/usage", "--output-format", "json"], { encoding: "utf8", timeout: 60_000 });
  let parsed: { status?: string; response?: string; error?: string } = {};
  try {
    parsed = JSON.parse(usage.stdout) as typeof parsed;
  } catch {
    // Not JSON: agy failed before producing a result; stderr says why.
  }
  const authenticated = parsed.status === "SUCCESS";
  return {
    installed: true,
    version: version.stdout.trim(),
    authenticated,
    detail: authenticated
      ? (parsed.response ?? "").trim().split("\n").filter((line) => line.startsWith("Gemini")).map((line) => line.split("\t").join(" | ")).join("\n")
      : parsed.error || summarizeStderr(`${usage.stderr ?? ""}`) || "agy /usage failed"
  };
}
