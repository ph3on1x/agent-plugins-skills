/**
 * Minimal Muse Session Protocol probe (`muse serve`: newline-delimited JSON-RPC 2.0 over stdio).
 * Every request is written up front and stdin is closed; the host answers in any order and exits
 * at EOF, so one spawnSync is the whole exchange. `--provider echo` keeps the probe free of model
 * calls, and a signed-out host still answers `account/read` instead of refusing to start.
 */
import { spawnSync } from "node:child_process";

export const CLIENT_NAME = "muse_companion";

type RpcResponse = { readonly id?: unknown; readonly result?: unknown; readonly error?: { readonly message?: string } };

export function mspRequests(methods: readonly string[]): string {
  const lines = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name: CLIENT_NAME, version: "0.1.0" }, capabilities: { experimentalApi: true } } },
    { jsonrpc: "2.0", method: "initialized", params: {} },
    ...methods.map((method, i) => ({ jsonrpc: "2.0", id: i + 1, method, params: {} }))
  ];
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

/** Results keyed by method; throws when the host answered a request with an error or not at all. */
export function parseMspOutput(stdout: string, methods: readonly string[]): Readonly<Record<string, unknown>> {
  const byId = new Map<unknown, RpcResponse>();
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as RpcResponse;
      if (value.id !== undefined) byId.set(value.id, value);
    } catch {
      // Not a JSON-RPC line; ignore.
    }
  }
  const init = byId.get(0);
  if (init?.error) throw new Error(`muse serve refused initialize: ${init.error.message ?? "unknown error"}`);
  return Object.fromEntries(
    methods.map((method, i) => {
      const response = byId.get(i + 1);
      if (!response) throw new Error(`muse serve did not answer ${method}.`);
      if (response.error) throw new Error(`muse serve ${method} failed: ${response.error.message ?? "unknown error"}`);
      return [method, response.result];
    })
  );
}

export function queryMuse(bin: string, methods: readonly string[], env: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  const run = spawnSync(bin, ["serve", "--provider", "echo", "--no-session-log"], { input: mspRequests(methods), encoding: "utf8", timeout: 30_000, env });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    const reason = (run.stderr ?? "").trim().split("\n").filter(Boolean).at(-1) ?? `exit ${run.status ?? run.signal}`;
    throw new Error(`muse serve exited ${run.status ?? run.signal}: ${reason}`);
  }
  return parseMspOutput(run.stdout, methods);
}
