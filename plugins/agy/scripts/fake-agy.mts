#!/usr/bin/env node
/**
 * Test double for the `agy` CLI. Behaviour is chosen by FAKE_AGY_MODE; every invocation's argv and
 * stdin are appended to FAKE_AGY_LOG as one JSON line so tests can assert on them.
 */
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = process.env.FAKE_AGY_MODE ?? "task";
const stdin = args.includes("--input-format") ? readFileSync(0, "utf8") : "";
if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ args, stdin })}\n`);

const emit = (event: unknown): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

if (args[0] === "--version") {
  process.stdout.write("1.2.15\n");
} else if (args[0] === "-p" && args[1] === "/usage") {
  process.stdout.write(
    mode === "unauthenticated"
      ? `${JSON.stringify({ status: "ERROR", error: "authentication required" })}\n`
      : `${JSON.stringify({ status: "SUCCESS", response: "Gemini Models\tWeekly Limit Remaining\t99%\nClaude and GPT models\tWeekly Limit Remaining\t100%\n" })}\n`
  );
  process.exit(mode === "unauthenticated" ? 1 : 0);
} else if (args[0] === "models") {
  if (mode === "unauthenticated") {
    process.stderr.write("Authentication required.\n");
    process.exit(1);
  }
  process.stdout.write("Fetching available models...\ngemini-3.7-flash-high\tGemini 3.7 Flash (High)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n");
} else {
  const conversationArg = args.indexOf("--conversation");
  const conversation_id = conversationArg === -1 ? `conv-${process.pid}` : args[conversationArg + 1];
  emit({ event: "init", conversation_id, init: { model: "gemini-test", permission_mode: "request-review" } });
  const finish = (result: Record<string, unknown>): void => {
    emit({ event: "result", result: { conversation_id, status: "SUCCESS", response: "", num_turns: 1, ...result } });
  };
  if (mode === "review") {
    finish({
      response: "{}",
      structured_output: {
        verdict: "needs-attention",
        summary: "Do not ship: mul adds.",
        findings: [
          { severity: "low", title: "Minor", body: "Small thing.", file: "calc.py", line_start: 1, line_end: 1, confidence: 0.4, recommendation: "Tidy." },
          { severity: "critical", title: "mul adds", body: "mul returns a + b.", file: "calc.py", line_start: 4, line_end: 5, confidence: 1, recommendation: "Use a * b." }
        ],
        next_steps: ["Fix mul."]
      }
    });
  } else if (mode === "badverdict") {
    finish({ response: "{}", structured_output: { decision: "maybe" } });
  } else if (mode === "block" || mode === "allow") {
    finish({ response: "{}", structured_output: { decision: mode, reason: `fake ${mode}` } });
  } else if (mode === "stale-error") {
    emit({ event: "result", result: { conversation_id, status: "ERROR", response: "Fixed after a retry.\n", error: "API error (attempt 1): UNAVAILABLE (code 503)" } });
  } else if (mode === "denied") {
    finish({ denied_actions: [{ action: "command", display_name: "RunCommand" }] });
  } else if (mode === "error") {
    if (!args.includes("--agent")) {
      emit({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/repo/half-done.js" } } } });
    }
    process.stderr.write('AGY_ERROR: {"short_error":"quota exhausted","retryable":false}\n');
    emit({ event: "result", result: { conversation_id, status: "ERROR", response: "", error: "quota exhausted" } });
    process.exit(3);
  } else if (mode === "slow-error") {
    setTimeout(() => {
      process.stderr.write('AGY_ERROR: {"short_error":"quota exhausted","retryable":false}\n');
      emit({ event: "result", result: { conversation_id, status: "ERROR", response: "", error: "quota exhausted" } });
      process.exit(3);
    }, 1500);
  } else if (mode === "rogue-untargeted") {
    emit({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "tool", tool_name: "replace_file_content", tool_info: {} } });
    finish({ response: "Done.\n" });
  } else if (mode === "slow") {
    setTimeout(() => finish({ response: "too late" }), 30_000);
  } else {
    // Write runs (default agent) or a misbehaving "rogue" agy edit a file; the read-only agent only answers.
    const edits = mode === "rogue" || !args.includes("--agent");
    if (edits) emit({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "replace_file_content", tool_info: { parameters: { TargetFile: "/repo/calc.py" } } } });
    if (edits) emit({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "tool", tool_name: "replace_file_content", tool_info: { parameters: { TargetFile: "/repo/calc.py" } } } });
    finish({ response: "Fixed mul.\n" });
  }
}
