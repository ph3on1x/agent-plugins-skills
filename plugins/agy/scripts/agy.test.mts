import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgyArgs, collectTouchedFiles, parseEventLine, parseModels, resolveModelAlias, runAgyTurn, turnFailure, type TurnOutcome } from "./lib/agy.mts";
import { expandRawArguments, parseArgs, splitRawArgs } from "./lib/args.mts";
import { collectReviewContext, packChunks, resolveReviewTarget, splitDiff } from "./lib/git.mts";
import { createJob, matchJob, readJob, updateJob, withLock, type Job } from "./lib/jobs.mts";
import { asReviewOutput } from "./lib/render.mts";
import { fence } from "./agy-companion.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const COMPANION = join(HERE, "agy-companion.mts");
const FAKE_AGY = join(HERE, "fake-agy.mts");
// In-process runAgyTurn calls must never reach a real agy.
process.env.AGY_COMPANION_AGY_BIN = FAKE_AGY;
// The fake must be executable; only fix the mode when needed so read-only checkouts still run.
if ((statSync(FAKE_AGY).mode & 0o111) === 0) chmodSync(FAKE_AGY, 0o755);

// ---------- helpers ----------

const tempDir = (): string => mkdtempSync(join(tmpdir(), "agy-test-"));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** A repo with one commit and a dirty working tree (mul adds instead of multiplying). */
function makeRepo(): string {
  const dir = tempDir();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "calc.py"), "def add(a, b):\n    return a - b\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  writeFileSync(join(dir, "calc.py"), "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a + b\n");
  return dir;
}

type Run = { status: number; stdout: string; stderr: string };

function companion(cwd: string, args: readonly string[], env: Record<string, string> = {}, input?: string): Run {
  const r = spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGY_COMPANION_AGY_BIN: FAKE_AGY, ...env }
  });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function fakeEnv(mode: string, extra: Record<string, string> = {}): Record<string, string> {
  const data = tempDir();
  return { AGY_COMPANION_DATA: data, FAKE_AGY_MODE: mode, FAKE_AGY_LOG: join(data, "agy.log"), AGY_COMPANION_SESSION_ID: "s1", ...extra };
}

const agyCalls = (env: Record<string, string>): { args: string[]; stdin: string }[] =>
  readFileSync(env.FAKE_AGY_LOG ?? "", "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; stdin: string });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- args ----------

test("splitRawArgs quotes only at token start or after =, so focus text keeps apostrophes", () => {
  assert.deepEqual(splitRawArgs(`--base main "don't ship" 'a b' c\\ d ""`), ["--base", "main", "don't ship", "a b", "c d", ""]);
  assert.deepEqual(splitRawArgs("check what users' data don't cover"), ["check", "what", "users'", "data", "don't", "cover"]);
  assert.deepEqual(splitRawArgs("--base='main' --scope=\"branch\""), ["--base=main", "--scope=branch"]);
  assert.throws(() => splitRawArgs("'unterminated focus"), /Unmatched/);
});

test("expandRawArguments splits a lone raw string and leaves real argv alone", () => {
  assert.deepEqual(expandRawArguments(["--wait --base main"]), ["--wait", "--base", "main"]);
  assert.deepEqual(expandRawArguments(["--base='main'"]), ["--base=main"]);
  assert.deepEqual(expandRawArguments(["--write", "fix the bug"]), ["--write", "fix the bug"]);
  assert.deepEqual(expandRawArguments([""]), []);
});

test("parseArgs separates known options from task text and rejects missing values", () => {
  const parsed = parseArgs(["--model", "pro", "--wait", "--unknown", "focus", "--scope=branch"], { values: ["model", "scope"], booleans: ["wait"] });
  assert.deepEqual(parsed.options, { model: "pro", wait: true, scope: "branch" });
  assert.deepEqual(parsed.positionals, ["--unknown", "focus"]);
  assert.throws(() => parseArgs(["--model"], { values: ["model"] }), /Missing value/);
});

// ---------- agy ----------

test("read-only profile uses the restricted agent inside the sandbox; write profile does not", () => {
  const ro = buildAgyArgs({ profile: "read-only", model: "m", schemaPath: "/s.json" });
  assert.ok(ro.includes("--sandbox"));
  assert.equal(ro[ro.indexOf("--agent") + 1], "agy-read-only");
  assert.ok(readFileSync(join(ro[ro.indexOf("--add-dir") + 1] ?? "", ".agents", "agents", "agy-read-only.md"), "utf8").includes("finish"));
  assert.deepEqual(ro.slice(-4), ["--model", "m", "--json-schema", "/s.json"]);
  const rw = buildAgyArgs({ profile: "write", conversationId: "c1" });
  assert.ok(rw.includes("--sandbox") && !rw.includes("--agent"), "write: edit tools, sandboxed shell");
  assert.deepEqual(rw.slice(-2), ["--conversation", "c1"]);
  const full = buildAgyArgs({ profile: "full-access" });
  assert.ok(!full.includes("--sandbox") && !full.includes("--agent") && full.includes("--dangerously-skip-permissions"));
});

test("read-only agent never lists a file-editing tool", () => {
  const agent = readFileSync(join(PLUGIN, "agent-home", ".agents", "agents", "agy-read-only.md"), "utf8");
  for (const tool of ["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"]) {
    assert.ok(!agent.includes(tool), tool);
  }
});

test("model aliases resolve to the newest Gemini of the family and level", () => {
  const models = parseModels("Fetching...\ngemini-3.7-flash-high\tA\ngemini-3.10-flash-high\tB\ngemini-3.8-flash-low\tC\ngemini-3.1-pro-high\tD\n");
  assert.equal(resolveModelAlias("flash", models), "gemini-3.10-flash-high");
  assert.equal(resolveModelAlias("flash-low", models), "gemini-3.8-flash-low");
  assert.equal(resolveModelAlias("PRO", models), "gemini-3.1-pro-high");
  assert.equal(resolveModelAlias("claude-opus-4-6-thinking", models), "claude-opus-4-6-thinking");
  assert.throws(() => resolveModelAlias("pro-low", models), /No Gemini pro model/);
  assert.equal(resolveModelAlias("flash", models, "low"), "gemini-3.8-flash-low", "level-less alias follows --effort");
  assert.equal(resolveModelAlias("flash", models, "max"), "gemini-3.10-flash-high", "non-level effort keeps the default level");
  assert.equal(resolveModelAlias("flash-high", models, "low"), "gemini-3.10-flash-high", "explicit level wins; agy reports the conflict");
});

test("parseEventLine accepts only structurally valid events", () => {
  assert.equal(parseEventLine("Fetching..."), null);
  assert.equal(parseEventLine('{"event":"other"}'), null);
  assert.equal(parseEventLine('{"event":"init"}'), null);
  assert.equal(parseEventLine('{"event":"result","result":{}}'), null);
  const result = parseEventLine('{"event":"result","result":{"status":"SUCCESS","conversation_id":"c"}}');
  assert.equal(result?.event === "result" && result.result.response, "");
});

test("fence neutralizes every closing-tag spelling of the untrusted blocks", () => {
  for (const tag of ["</repository_context>", "</repository_context >", "</repository_context\n>", "</ REPOSITORY_CONTEXT>", "</previous_claude_turn\t>"]) {
    assert.ok(!/<\/\s*(repository_context|previous_claude_turn)\s*>/i.test(fence(`x ${tag} y`)), tag);
  }
});

test("asReviewOutput rejects incomplete findings and prototype-name severities", () => {
  const finding = { severity: "high", title: "t", body: "b", file: "f", line_start: 1, line_end: 2, confidence: 0.5, recommendation: "r" };
  const review = (f: object) => ({ verdict: "approve", summary: "s", findings: [f], next_steps: [] });
  assert.ok(asReviewOutput(review(finding)));
  assert.equal(asReviewOutput(review({ ...finding, severity: "toString" })), null);
  assert.equal(asReviewOutput(review({ ...finding, line_start: "1" })), null);
  assert.equal(asReviewOutput(review({ title: "t", file: "f", severity: "low" })), null);
});

test("collectTouchedFiles reports finished edit-tool targets once", () => {
  const step = (state: string, tool: string, file: string) => ({ step_index: 0, state, step_type: "tool", tool_name: tool, tool_info: { parameters: { TargetFile: file } } });
  assert.deepEqual(collectTouchedFiles([step("ACTIVE", "write_to_file", "/a"), step("DONE", "write_to_file", "/a"), step("DONE", "replace_file_content", "/a"), step("DONE", "view_file", "/b")]), ["/a"]);
});

test("turnFailure distinguishes errors, denials, and empty answers", () => {
  const outcome = (result: Partial<TurnOutcome["result"]>, exitCode = 0): TurnOutcome => ({
    result: { conversation_id: "c", status: "SUCCESS", response: "", ...result },
    touchedFiles: [],
    stderr: "noise\nAGY_ERROR: {\"short_error\":\"boom\"}\n",
    exitCode
  });
  assert.equal(turnFailure(outcome({ response: "ok" })), null);
  assert.equal(turnFailure(outcome({ structured_output: {} })), null);
  assert.equal(turnFailure(outcome({ status: "ERROR", error: "bad model" })), "bad model");
  assert.match(turnFailure(outcome({ response: "partial" }, 3)) ?? "", /AGY_ERROR/);
  assert.match(turnFailure(outcome({ denied_actions: [{ action: "command", display_name: "RunCommand" }] })) ?? "", /RunCommand \(command\)/);
  assert.match(turnFailure(outcome({ response: "I will fix that next", denied_actions: [{ action: "write_file" }] })) ?? "", /auto-denied: write_file/);
  assert.match(turnFailure(outcome({})) ?? "", /empty response/);
  // agy's stale-ERROR bug: exit 0, no AGY_ERROR line, real answer => success (reported as a note).
  const stale = { ...outcome({ status: "ERROR", error: "attempt 1: 503", response: "OK" }), stderr: "" };
  assert.equal(turnFailure(stale), null);
  assert.match(turnFailure({ ...stale, result: { ...stale.result, response: "" } }) ?? "", /503/);
  assert.match(turnFailure({ ...stale, exitCode: 3 }) ?? "", /503/);
});

// ---------- git ----------

test("packChunks inlines whole file diffs until the budget, listing the rest", () => {
  const chunks = splitDiff("diff --git a/x b/x\n+1\ndiff --git a/y b/y\n+22222222\ndiff --git a/z b/z\n+3\n");
  assert.equal(chunks.length, 3);
  const packed = packChunks(chunks, 50);
  assert.equal(packed.inlined.length, 2);
  assert.deepEqual(packed.omitted, ["diff --git a/y b/y"]);
});

test("review context covers staged, unstaged, and untracked files but never follows symlinks", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "new.txt"), "hello\n");
  symlinkSync("/etc/hosts", join(repo, "link"));
  const target = resolveReviewTarget(repo, {});
  assert.equal(target.mode, "working-tree");
  const context = collectReviewContext(repo, target);
  assert.deepEqual(context.changedFiles, ["calc.py", "link", "new.txt"]);
  assert.match(context.content, /\+    return a \+ b/);
  assert.match(context.content, /### new\.txt\n```\nhello/);
  assert.match(context.content, /### link\n\(skipped: symlink\)/);
});

test("review context keeps exotic file names and shares one budget with untracked files", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "café.txt"), "bonjour\n");
  writeFileSync(join(repo, "big.txt"), "x".repeat(20_000));
  const context = collectReviewContext(repo, { mode: "working-tree", label: "working tree diff" }, 2_000);
  assert.ok(context.changedFiles.includes("café.txt"));
  assert.match(context.content, /### café\.txt\n```\nbonjour/);
  assert.ok(context.omittedDiffs.includes("### big.txt"));
  assert.match(context.content, /Not Inlined[\s\S]*git diff --cached -- <path>/);
});

test("clean tree falls back to branch review against the default branch", () => {
  const repo = makeRepo();
  git(repo, "checkout", "-q", "-b", "feature");
  git(repo, "commit", "-qam", "change");
  const target = resolveReviewTarget(repo, {});
  assert.deepEqual(target, { mode: "branch", label: "branch diff against main", baseRef: "main" });
  assert.match(collectReviewContext(repo, target).content, /## Commit Log\n\n\w+ .*change/);
});

// ---------- jobs ----------

test("terminal job states are final and job references match by unique prefix", () => {
  const prev = process.env.AGY_COMPANION_DATA;
  process.env.AGY_COMPANION_DATA = tempDir();
  try {
    const root = tempDir();
    const job = createJob({ id: "task-abc", kind: "task", title: "t", summary: "s", status: "running", phase: "running", workspaceRoot: root });
    updateJob(root, job.id, { status: "cancelled", phase: "cancelled" });
    updateJob(root, job.id, { status: "completed", phase: "done" });
    assert.equal(readJob(root, job.id)?.status, "cancelled");
    const jobs = [{ id: "task-abc" }, { id: "task-abd" }] as Job[];
    assert.equal(matchJob(jobs, "task-abc").id, "task-abc");
    assert.throws(() => matchJob(jobs, "task-ab"), /ambiguous/);
    assert.throws(() => matchJob(jobs, "zzz"), /No job found/);
  } finally {
    process.env.AGY_COMPANION_DATA = prev;
  }
});

test("withLock breaks a lock whose owner died and never removes a lock it does not own", () => {
  const dir = tempDir();
  const lock = join(dir, "x.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), "999999:dead");
  assert.equal(withLock(lock, () => "acquired"), "acquired");
  assert.throws(() => readFileSync(join(lock, "owner"), "utf8"), /ENOENT/);
  const inner = withLock(lock, () => {
    writeFileSync(join(lock, "owner"), `${process.pid}:someone-else`);
    return "ok";
  });
  assert.equal(inner, "ok");
  assert.equal(readFileSync(join(lock, "owner"), "utf8"), `${process.pid}:someone-else`);
});

const pidGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test("runAgyTurn stops agy when the spawn hook refuses (cancelled before start)", async () => {
  let agyPid = 0;
  process.env.FAKE_AGY_MODE = "slow";
  await assert.rejects(
    runAgyTurn({ cwd: tempDir(), prompt: "x", profile: "read-only", onSpawn: (pid) => { agyPid = pid; throw new Error("job cancelled"); } }),
    /job cancelled/
  );
  assert.ok(agyPid > 0 && pidGone(agyPid));
});

test("runAgyTurn stops agy when a progress callback throws", async () => {
  process.env.FAKE_AGY_MODE = "slow";
  let agyPid = 0;
  await assert.rejects(
    runAgyTurn({ cwd: tempDir(), prompt: "x", profile: "write", onSpawn: (pid) => { agyPid = pid; }, onProgress: () => { throw new Error("log disk full"); } }),
    /log disk full/
  );
  assert.ok(pidGone(agyPid));
});

// ---------- runtime against a fake agy ----------

test("review renders structured findings by severity and sends the diff on stdin", () => {
  const repo = makeRepo();
  const env = fakeEnv("review");
  const run = companion(repo, ["review", "--model flash"], env);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Verdict: needs-attention/);
  assert.ok(run.stdout.indexOf("[critical] mul adds") < run.stdout.indexOf("[low] Minor"));
  const call = agyCalls(env).find((c) => c.args.includes("--input-format"));
  assert.ok(call);
  assert.equal(call.args[call.args.indexOf("--model") + 1], "gemini-3.8-flash-high");
  assert.ok(call.args.includes("--sandbox"));
  const message = JSON.parse(call.stdin) as { event: string; message: { content: string } };
  assert.equal(message.event, "user");
  assert.match(message.message.content, /def mul\(a, b\)/);
});

test("commands ignore a foreign CLAUDE_PLUGIN_DATA (another plugin's export) and use AGY_COMPANION_DATA", () => {
  const repo = makeRepo();
  const env = fakeEnv("review");
  const foreign = tempDir();
  assert.equal(companion(repo, ["review", "--wait"], { ...env, CLAUDE_PLUGIN_DATA: foreign }).status, 0);
  assert.deepEqual(readdirSync(foreign), []);
  assert.match(companion(repo, ["status"], env).stdout, /\| review \| completed/);
});

test("background review runs in a detached worker that outlives its launcher", async () => {
  const repo = makeRepo();
  const env = fakeEnv("review");
  const launch = companion(repo, ["adversarial-review", "--background challenge the coupon design"], env);
  assert.match(launch.stdout, /started in the background/);
  const jobId = /(review-\S+) started/.exec(launch.stdout)?.[1] ?? "";
  let job: Job | undefined;
  for (let i = 0; i < 50 && job?.status !== "completed"; i += 1) {
    await sleep(100);
    job = JSON.parse(companion(repo, ["status", jobId, "--json"], env).stdout) as Job;
  }
  assert.equal(job?.status, "completed");
  assert.match(companion(repo, ["result", jobId], env).stdout, /\[critical\] mul adds/);
  assert.match(agyCalls(env)[0]?.stdin ?? "", /User focus: challenge the coupon design/);
});

test("review refuses focus text and adversarial review forwards it", () => {
  const repo = makeRepo();
  assert.match(companion(repo, ["review", "look at auth"], fakeEnv("review")).stderr, /does not take focus text/);
  const env = fakeEnv("review");
  assert.equal(companion(repo, ["adversarial-review", "--wait question the retry design"], env).status, 0);
  assert.match(agyCalls(env)[0]?.stdin ?? "", /User focus: question the retry design/);
});

test("review of a clean tree reports nothing to review without calling agy", () => {
  const repo = makeRepo();
  git(repo, "commit", "-qam", "all in");
  const env = fakeEnv("review");
  const run = companion(repo, ["review", "--scope working-tree"], env);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Nothing to review/);
});

test("write task reports edited files and the conversation; --resume-last reuses it", () => {
  const repo = makeRepo();
  const env = fakeEnv("task");
  const first = companion(repo, ["task", "--write"], env, "Fix mul. Don't touch add's \"tests\".");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Files edited by agy:\n- \/repo\/calc\.py/);
  assert.match(first.stdout, /WARNING: agy edited files outside the repository/);
  const firstCall = agyCalls(env)[0];
  assert.ok(firstCall?.args.includes("--sandbox") && !firstCall.args.includes("--agent"), "write = edit tools + sandboxed shell");
  assert.match(firstCall?.stdin ?? "", /Don't touch add's \\"tests\\"/);
  const conversation = /agy conversation: (\S+)/.exec(first.stdout)?.[1] ?? "";

  const candidate = JSON.parse(companion(repo, ["task-resume-candidate", "--json"], env).stdout) as { available: boolean; candidate: { conversationId: string } };
  assert.equal(candidate.available, true);
  assert.equal(candidate.candidate.conversationId, conversation);

  const second = companion(repo, ["task", "--resume-last", "--write"], env, "");
  assert.equal(second.status, 0, second.stderr);
  const secondCall = agyCalls(env)[1];
  assert.equal(secondCall?.args[(secondCall?.args.indexOf("--conversation") ?? 0) + 1], conversation);
  assert.match(secondCall?.stdin ?? "", /Continue the previous task/);
});

test("resume cannot cross the read-only boundary (agy ignores --agent on resume)", () => {
  const repo = makeRepo();
  const env = fakeEnv("task");
  companion(repo, ["task", "--write"], env, "edit things");
  const candidate = JSON.parse(companion(repo, ["task-resume-candidate", "--json"], env).stdout) as { candidate: { profile: string } };
  assert.equal(candidate.candidate.profile, "write");
  assert.match(companion(repo, ["task", "--resume-last"], env, "go on").stderr, /resume it with --write/);
  assert.equal(companion(repo, ["task", "--resume-last", "--full-access"], env, "build").status, 0, "write <-> full-access is fine");
  const ro = fakeEnv("task");
  companion(repo, ["task", "--read-only"], ro, "look only");
  assert.match(companion(repo, ["task", "--resume-last", "--write"], ro, "now edit").stderr, /resume it without --write/);
  assert.equal(agyCalls(ro)[0]?.stdin.includes("look only"), true, "--read-only is a flag, never prompt text");
});

test("resume is scoped to the Claude session", () => {
  const repo = makeRepo();
  const env = fakeEnv("task");
  companion(repo, ["task", "do it"], env);
  assert.match(companion(repo, ["task", "--resume-last"], { ...env, AGY_COMPANION_SESSION_ID: "other" }).stderr, /No previous agy task thread/);
  const { AGY_COMPANION_SESSION_ID: _drop, ...noSession } = env;
  assert.match(companion(repo, ["task", "--resume-last"], noSession).stderr, /AGY_COMPANION_SESSION_ID is not set/);
});

test("two simultaneous resumes cannot both take the session's thread", async () => {
  const repo = makeRepo();
  const env = fakeEnv("task");
  companion(repo, ["task", "first"], env);
  const resume = (): Promise<Run> =>
    new Promise((done) => {
      const child = spawn(process.execPath, [COMPANION, "task", "--resume-last", "--background", "--json"], {
        cwd: repo,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGY_COMPANION_AGY_BIN: FAKE_AGY, ...env, FAKE_AGY_MODE: "slow" }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.stdin.end("go on");
      child.on("close", (status) => done({ status: status ?? 1, stdout, stderr }));
    });
  const runs = await Promise.all([resume(), resume()]);
  assert.deepEqual(runs.map((r) => r.status).sort(), [0, 1]);
  assert.match(runs.find((r) => r.status === 1)?.stderr ?? "", /still running/);
  companion(repo, ["cancel"], env);
});

test("failed agy runs exit non-zero with the actionable error", () => {
  const repo = makeRepo();
  const error = companion(repo, ["task", "--write", "x"], fakeEnv("error"));
  assert.equal(error.status, 1);
  assert.match(error.stdout, /quota exhausted/);
  assert.match(error.stdout, /Files edited by agy before it stopped:\n- \/repo\/half-done\.js/);
  assert.match(error.stdout, /continue it with \/agy:rescue --resume/);
  const denied = companion(repo, ["task", "x"], fakeEnv("denied"));
  assert.equal(denied.status, 1);
  assert.match(denied.stdout, /auto-denied: RunCommand \(command\)/);
});

test("--full-access drops the sandbox", () => {
  const env = fakeEnv("task");
  assert.equal(companion(makeRepo(), ["task", "--full-access"], env, "build it").status, 0);
  assert.ok(!agyCalls(env)[0]?.args.includes("--sandbox"));
});

test("cancel stops a foreground run: the companion and agy's own process group", async () => {
  const repo = makeRepo();
  const env = fakeEnv("slow");
  const child = spawn(process.execPath, [COMPANION, "task", "slow work"], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGY_COMPANION_AGY_BIN: FAKE_AGY, ...env },
    stdio: ["pipe", "ignore", "ignore"]
  });
  child.stdin.end();
  const exited = new Promise((r) => child.on("exit", r));
  let job: Job | undefined;
  for (let i = 0; i < 50 && !job?.agyPid; i += 1) {
    await sleep(100);
    job = (JSON.parse(companion(repo, ["status", "--json"], env).stdout) as { jobs: Job[] }).jobs[0];
  }
  const agyPid = job?.agyPid ?? 0;
  assert.ok(agyPid > 0, "agy pid recorded");
  assert.equal(companion(repo, ["cancel", job?.id ?? ""], env).status, 0);
  await exited;
  await sleep(200);
  assert.throws(() => process.kill(agyPid, 0), /ESRCH/);
  assert.equal((JSON.parse(companion(repo, ["status", job?.id ?? "", "--json"], env).stdout) as Job).status, "cancelled");
});

test("a foreground run that outlasts the wait slice keeps running and can be awaited again", async () => {
  const repo = makeRepo();
  const env = { ...fakeEnv("slow"), AGY_COMPANION_WAIT_MS: "1500" };
  const first = companion(repo, ["task", "long one"], env);
  assert.equal(first.status, 0);
  const jobId = /agy task (\S+) is still running/.exec(first.stdout)?.[1] ?? "";
  assert.ok(jobId, first.stdout);
  assert.match(first.stdout, new RegExp(`result ${jobId} --wait`));
  assert.match(companion(repo, ["result", jobId, "--wait"], env).stdout, /still running/);
  assert.match(companion(repo, ["result", "--wait"], env).stdout, new RegExp(`${jobId} is still running`), "no id: waits on the running job");
  assert.equal(companion(repo, ["cancel", jobId], env).status, 0);
});

test("a stale recovered ERROR status does not fail a completed turn, but is shown", () => {
  const run = companion(makeRepo(), ["task", "--write", "x"], fakeEnv("stale-error"));
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /Fixed after a retry\./);
  assert.match(run.stdout, /Note: agy flagged an earlier error .*503/);
});

test("a read-only run that somehow edits files fails loudly", () => {
  const run = companion(makeRepo(), ["task", "look only"], fakeEnv("rogue"));
  assert.equal(run.status, 1);
  assert.match(run.stdout, /edited files during a read-only run \(\/repo\/calc\.py\)/);
});

test("background task runs in a detached worker; status and result follow it", async () => {
  const repo = makeRepo();
  const env = fakeEnv("task");
  const launch = companion(repo, ["task", "--background", "--json"], env, "fix it");
  const { jobId } = JSON.parse(launch.stdout) as { jobId: string };
  let job: Job | undefined;
  for (let i = 0; i < 50 && job?.status !== "completed"; i += 1) {
    await sleep(100);
    job = JSON.parse(companion(repo, ["status", jobId, "--json"], env).stdout) as Job;
  }
  assert.equal(job?.status, "completed");
  assert.match(companion(repo, ["status"], env).stdout, new RegExp(`\\| ${jobId} \\| task \\| completed`));
  assert.match(companion(repo, ["result"], env).stdout, /Fixed mul\./);
  assert.ok(agyCalls(env).some((c) => c.args.includes("--agent")), "background read-only task uses the read-only agent");
});

test("cancel stops a running background job and the worker cannot overwrite it", async () => {
  const repo = makeRepo();
  const env = fakeEnv("slow");
  const { jobId } = JSON.parse(companion(repo, ["task", "--background", "--json"], env, "slow").stdout) as { jobId: string };
  await sleep(1500);
  const cancel = companion(repo, ["cancel"], env);
  assert.equal(cancel.status, 0, cancel.stderr);
  await sleep(500);
  const job = JSON.parse(companion(repo, ["status", jobId, "--json"], env).stdout) as Job;
  assert.equal(job.status, "cancelled");
  assert.match(companion(repo, ["result", jobId], env).stdout, /Cancelled by user/);
});

test("session hooks export the session id and cancel only that session's jobs", async () => {
  const repo = makeRepo();
  const env = fakeEnv("slow");
  const envFile = join(tempDir(), "env");
  writeFileSync(envFile, "");
  companion(repo, ["hook", "SessionStart"], { ...env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: "/plugins/data/agy" }, JSON.stringify({ session_id: "s1" }));
  const exported = readFileSync(envFile, "utf8");
  assert.match(exported, /export AGY_COMPANION_SESSION_ID='s1'/);
  assert.match(exported, /export AGY_COMPANION_DATA='\/plugins\/data\/agy'/);
  assert.ok(!exported.includes("CLAUDE_PLUGIN_DATA"), "must not clobber other plugins' CLAUDE_PLUGIN_DATA");
  const mine = JSON.parse(companion(repo, ["task", "--background", "--json"], env, "a").stdout) as { jobId: string };
  const theirs = JSON.parse(companion(repo, ["task", "--background", "--json"], { ...env, AGY_COMPANION_SESSION_ID: "s2" }, "b").stdout) as { jobId: string };
  await sleep(1000);
  companion(repo, ["hook", "SessionEnd"], env, JSON.stringify({ session_id: "s1", cwd: repo }));
  const elsewhere = makeRepo();
  const other = JSON.parse(companion(repo, ["task", "--background", "--json", "--cwd", elsewhere], env, "c").stdout) as { jobId: string };
  await sleep(1000);
  companion(repo, ["hook", "SessionEnd"], env, JSON.stringify({ session_id: "s1", cwd: repo }));
  const status = (id: string, cwd = repo): string => (JSON.parse(companion(cwd, ["status", id, "--json"], env).stdout) as Job).status;
  assert.equal(status(other.jobId, elsewhere), "cancelled", "SessionEnd covers every repository the session used");
  assert.equal(status(mine.jobId), "cancelled");
  assert.equal(status(theirs.jobId), "running");
  companion(repo, ["cancel", theirs.jobId], env);
});

test("stop gate: off by default, skips clean trees and re-entry, blocks only on findings", () => {
  const repo = makeRepo();
  const stop = (mode: string, data: string, input: Record<string, unknown> = {}): Run =>
    companion(repo, ["hook", "Stop"], { ...fakeEnv(mode), CLAUDE_PLUGIN_DATA: data }, JSON.stringify({ session_id: "s1", cwd: repo, last_assistant_message: "Edited calc.py", ...input }));
  const data = tempDir();
  assert.equal(stop("block", data).stdout, "");
  companion(repo, ["setup", "--enable-review-gate", "--json"], { ...fakeEnv("task"), AGY_COMPANION_DATA: data });
  assert.deepEqual(JSON.parse(stop("block", data).stdout), { decision: "block", reason: "agy stop-time review: fake block" });
  assert.equal(stop("allow", data).stdout, "");
  assert.equal(stop("block", data, { stop_hook_active: true }).stdout, "");
  assert.match(stop("error", data).stdout, /"systemMessage":"agy stop-time review skipped: quota exhausted"/);
  assert.match(stop("badverdict", data).stdout, /no valid allow\/block verdict/);
  assert.match(stop("block", data, { cwd: "/nonexistent/agy-test" }).stdout, /"systemMessage":"agy stop-time review skipped/);
  git(repo, "commit", "-qam", "clean");
  assert.equal(stop("block", data).stdout, "");
});

test("setup reports readiness, missing auth, and conflicting /agy plugins", () => {
  const repo = makeRepo();
  const home = tempDir();
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "agy@antigravity-cc": [], "agy@ph3on1x": [] } }));
  const ready = JSON.parse(companion(repo, ["setup", "--json"], { ...fakeEnv("task"), HOME: home }).stdout) as { ready: boolean; conflicts: string[]; availability: { detail: string } };
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.conflicts, ["agy@antigravity-cc"]);
  assert.equal(ready.availability.detail, "Gemini Models | Weekly Limit Remaining | 99%");
  const unauth = JSON.parse(companion(repo, ["setup", "--json"], fakeEnv("unauthenticated")).stdout) as { ready: boolean };
  assert.equal(unauth.ready, false);
  const missing = JSON.parse(companion(repo, ["setup", "--json"], { ...fakeEnv("task"), AGY_COMPANION_AGY_BIN: "/nonexistent/agy" }).stdout) as { ready: boolean; availability: { installed: boolean } };
  assert.equal(missing.availability.installed, false);
});

// ---------- command contracts ----------

const read = (path: string): string => readFileSync(join(PLUGIN, path), "utf8");

test("plugin exposes the codex command set minus /transfer (agy cannot import Claude transcripts)", () => {
  assert.deepEqual(readdirSync(join(PLUGIN, "commands")).sort(), ["adversarial-review.md", "cancel.md", "rescue.md", "result.md", "review.md", "setup.md", "status.md"]);
});

test("review commands stay review-only, ask once, and support background runs", () => {
  for (const [file, kind] of [["commands/review.md", "review"], ["commands/adversarial-review.md", "adversarial-review"]] as const) {
    const source = read(file);
    assert.match(source, /disable-model-invocation: true/);
    assert.match(source, /review-only/);
    assert.match(source, /Do not fix issues/);
    assert.match(source, /AskUserQuestion/);
    assert.match(source, /\(Recommended\)/);
    assert.ok(source.includes(`agy-companion.mts" ${kind} "$ARGUMENTS"`));
    assert.ok(source.includes(`agy-companion.mts" ${kind} "--background $ARGUMENTS"`), "--background must precede a user --");
    assert.match(source, /Return the command stdout verbatim/);
  }
});

test("rescue routes through the subagent, which forwards task text on stdin", () => {
  const rescue = read("commands/rescue.md");
  assert.match(rescue, /subagent_type: "agy:agy-rescue"/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /Continue current agy thread/);
  const agent = read("agents/agy-rescue.md");
  assert.match(agent, /^tools: Bash$/m);
  assert.match(agent, /<<'AGY_TASK_<suffix>'/);
  assert.match(agent, /no line of the task text equals the delimiter/);
  assert.match(agent, /result <job-id> --wait/);
});

test("hooks wire session tracking and the stop gate to the companion", () => {
  const hooks = JSON.parse(read("hooks/hooks.json")) as { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> };
  for (const event of ["SessionStart", "SessionEnd", "Stop"]) {
    assert.ok(hooks.hooks[event]?.[0]?.hooks[0]?.command.endsWith(`agy-companion.mts" hook ${event}`), event);
  }
  assert.equal(hooks.hooks.Stop?.[0]?.hooks[0]?.timeout, 900);
});
