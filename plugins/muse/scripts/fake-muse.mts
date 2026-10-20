#!/usr/bin/env node
/**
 * Test double for the `muse` CLI, emitting the record envelope real Muse Code 1.4.11 emits (see
 * fixtures/). Behaviour is chosen by FAKE_MUSE_MODE; every exec invocation's argv, prompt file, and
 * the env keys the runtime must scrub are appended to FAKE_MUSE_LOG as one JSON line.
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_MUSE_MODE ?? "task";
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

if (args[0] === "--version") {
  process.stdout.write("Muse Code 1.4.11 (1.4.11-R6667.1)\n");
} else if (args[0] === "serve") {
  serve();
} else if (args[0] === "exec") {
  exec();
} else {
  process.stderr.write(`fake muse: unsupported invocation ${args.join(" ")}\n`);
  process.exit(2);
}

/** Variables the runtime must never pass to muse. */
function leakedEnv(): string[] {
  return ["CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "MUSE_COMPANION_DATA", "MUSE_PERMISSION_PROFILE_FAIL_OPEN"].filter((key) => process.env[key] !== undefined);
}

function serve(): void {
  if (leakedEnv().length > 0) {
    process.stderr.write(`fake muse: leaked ${leakedEnv().join(", ")}\n`);
    process.exit(3);
  }
  if (mode === "serve-exit3") {
    process.stderr.write("muse serve: could not load configuration\n");
    process.exit(3);
  }
  const account = mode === "unauthenticated" ? { state: "loggedOut", credentialRequired: true } : mode === "envkey" ? { state: "envKey", credentialRequired: true } : { state: "accountLogin", label: "user@example.com", credentialRequired: true };
  const models = [
    { modelId: "muse-wonder-1.0", releaseDate: "2026-10-12" },
    { modelId: "muse-spark-1.3-contributor", releaseDate: "2026-09-03" },
    { modelId: "muse-spark-1.3", releaseDate: "2026-09-02" },
    { modelId: "muse-spark-1.2", releaseDate: "2026-08-05" }
  ];
  const results: Record<string, unknown> = {
    initialize: { serverInfo: { name: "muse", version: "1.4.11" } },
    "account/read": account,
    "model/list": { providerId: "meta", profileId: "tbh", source: "providerCatalog", models }
  };
  const lines = readFileSync(0, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id?: number; method: string });
  // The host answers out of order, as the real one does.
  for (const request of lines.filter((r) => r.id !== undefined).reverse()) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: results[request.method] ?? {} })}\n`);
  }
}

function exec(): void {
  const promptFile = option("--prompt-file") ?? "";
  const prompt = promptFile ? readFileSync(promptFile, "utf8") : "";
  if (process.env.FAKE_MUSE_LOG) {
    appendFileSync(process.env.FAKE_MUSE_LOG, `${JSON.stringify({ args, prompt, promptFile, promptMode: statSync(promptFile).mode & 0o777, leakedEnv: leakedEnv() })}\n`);
  }
  if (mode === "signed-out") {
    process.stderr.write("muse: workspace root: /repo (cwd default)\nmissing meta credentials: run `muse login` or set META_API_KEY, or save credentials at /home/user/.config/muse/auth.json\n");
    process.exit(1);
  }
  if (mode === "sandboxed-stderr") {
    process.stderr.write("muse: workspace root: /repo (cwd default)\nfailed to start the shell: Operation not permitted\n");
    process.exit(1);
  }
  const sessionId = mode === "wrong-session" ? "00000000-0000-4000-8000-000000000000" : (option("--session-id") ?? "");
  const readOnly = args.includes("--disable-write");
  let sequence = 0;
  const emit = (payload_type: string, payload: Record<string, unknown>, kind = "session"): void => {
    sequence += 1;
    process.stdout.write(`${JSON.stringify({ schema_version: 1, id: `rec-${sequence}`, stream: { kind, id: kind === "session" ? sessionId : "u" }, sequence, record_type: "event", durability: "durable", payload_type, payload_schema_version: 1, payload })}\n`);
  };
  const tool = (kind: string, result: Record<string, unknown>): void => {
    emit("task.lifecycle.proposed", { kind: "task_lifecycle", event: { kind: "proposed", task_kind: kind } });
    if (Object.keys(result).length > 0) emit("tool.result", { kind: "tool_result", ...result });
  };
  const edit = (path: string, outcome = "success"): void =>
    tool("tool.write_file", { text: outcome === "success" ? `wrote 1 bytes to ${path}` : "tool failed: tool policy denied filesystem write", edit_facts: { tool_name: "write_file", path, added: 1 }, correlation_facts: { tool_name: "write_file", outcome } });
  const finish = (terminal: string, text: string, reason: string | null = null): void => {
    emit("run.usage", { kind: "run_usage", models: [], allowance: { tier: null, window: { used_percent: 44, resets_at_ms: 1792522205000 }, weekly: { used_percent: 13, resets_at_ms: 1792972800000 }, as_of_ms: 1792506297628 } }, "exec.usage");
    emit(`run.terminal.${terminal}`, { kind: "run_terminal", terminal, text, reason });
  };
  const fail = (reason: string): never => {
    finish("failed", "", reason);
    process.stderr.write(`muse: workspace root: ${process.cwd()} (cwd default)\nrun ended with Failed: ${reason}\n`);
    process.exit(1);
  };

  process.on("SIGTERM", () => {
    process.stderr.write("received SIGTERM; flushed session logs\n");
    process.exit(143);
  });
  emit("runtime.command.accepted", { kind: "command_accepted", command_kind: "turn.submit" });
  emit("run.model.configured", { kind: "run_model_configured", provider_id: "meta", model_id: option("--model") ?? "muse-wonder-1.0" });
  emit("run.lifecycle.started", { kind: "run_started" });
  tool("tool.bash", { text: JSON.stringify({ command: "git status --short", exit_code: 0, output: "" }), correlation_facts: { tool_name: "bash", outcome: "success" } });

  const review = {
    verdict: "needs-attention",
    summary: "Do not ship: mul adds.",
    findings: [
      { severity: "low", title: "Minor", body: "Small thing.", file: "calc.py", line_start: 1, line_end: 1, confidence: 0.4, recommendation: "Tidy." },
      // Muse models write paths as markdown links, even inside schema fields.
      { severity: "critical", title: "mul adds", body: "mul returns a + b.", file: `[calc.py](${join(process.cwd(), "calc.py")}:4)`, line_start: 4, line_end: 5, confidence: 1, recommendation: "Use a * b." }
    ],
    next_steps: ["Fix mul."]
  };
  if (mode === "review") finish("completed", JSON.stringify(review));
  else if (mode === "badjson") finish("completed", "I reviewed it and it looks fine.");
  else if (mode === "empty") finish("completed", "");
  else if (mode === "badverdict") finish("completed", JSON.stringify({ decision: "maybe" }));
  else if (mode === "block" || mode === "allow") finish("completed", JSON.stringify({ decision: mode, reason: `fake ${mode}` }));
  else if (mode === "error") {
    if (!readOnly) edit("half-done.js");
    fail("quota exhausted");
  } else if (mode === "sandboxed") {
    if (!readOnly) tool("tool.bash", { text: JSON.stringify({ command: "git commit -am x", exit_code: 1 }), correlation_facts: { tool_name: "bash", outcome: "failure" } });
    fail("git commit failed: Operation not permitted");
  } else if (mode === "slow-error") setTimeout(() => fail("quota exhausted"), 1500);
  else if (mode === "slow") setTimeout(() => finish("completed", "too late"), 30_000);
  else if (mode === "rogue") {
    edit("calc.py");
    finish("completed", "Done.\n");
  } else if (mode === "rogue-untargeted") {
    tool("tool.edit_file", {});
    finish("completed", "Done.\n");
  } else if (mode === "denied-edit") {
    edit("/outside/x.txt", "failure");
    finish("completed", "Could not write outside the workspace.\n");
  } else if (mode === "outside") {
    edit("/outside/x.txt");
    finish("completed", "Wrote outside.\n");
  } else if (mode === "shell-write") {
    // A shell command's write: muse streams no edit record for it.
    writeFileSync(join(process.cwd(), "shell-wrote.txt"), "x\n");
    finish("completed", JSON.stringify(review));
  } else {
    // Write runs edit a file; read-only runs (no file-writing tools) only answer.
    if (!readOnly) edit("calc.py");
    finish("completed", prompt.includes("/resume-claude") ? "Recap: goal fix mul; state unstarted; next step edit calc.py.\n" : "Fixed mul in [calc.py](/repo/calc.py:4).\n");
  }
}
