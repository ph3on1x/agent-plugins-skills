import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMuseArgs, describeAccount, foldRecord, museEnv, newTurnState, normalizeReview, parseModels, parseRecord, parseStructured, plainPath, readOnlyFailure,
  READ_ONLY_PROFILE_ID, resolveModelAlias, runMuseTurn, turnFailure, type Progress, type TurnOutcome, type TurnState
} from "./lib/muse.mts";
import { mspRequests, parseMspOutput } from "./lib/msp.mts";
import { expandRawArguments, parseArgs, splitRawArgs } from "./lib/args.mts";
import { changedPaths, collectReviewContext, packChunks, resolveReviewTarget, splitDiff, treeFingerprint } from "./lib/git.mts";
import { createJob, generateJobId, matchJob, readJob, updateJob, withLock, type Job } from "./lib/jobs.mts";
import { asReviewOutput, renderTask } from "./lib/render.mts";
import { fence } from "./muse-companion.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const COMPANION = join(HERE, "muse-companion.mts");
const FAKE_MUSE = join(HERE, "fake-muse.mts");
const FIXTURES = join(HERE, "fixtures");
// In-process runMuseTurn calls must never reach a real muse.
process.env.MUSE_COMPANION_MUSE_BIN = FAKE_MUSE;
// The fake must be executable; only fix the mode when needed so read-only checkouts still run.
if ((statSync(FAKE_MUSE).mode & 0o111) === 0) chmodSync(FAKE_MUSE, 0o755);

const tempDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "muse-test-"));
  tempDirs.push(dir);
  return dir;
};
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// Hermetic git, in this process and every child: no personal or system config, and no repository
// inherited from a caller such as a git hook.
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } as const;
Object.assign(process.env, GIT_ENV);
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete process.env[key];
const HOME = tempDir();

/** Environment for companion children: nothing inherited beyond PATH. */
const baseEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME, ...GIT_ENV, MUSE_COMPANION_MUSE_BIN: FAKE_MUSE });

/** Runs fn with vars set, then restores them (deleting absent ones: assigning undefined stores "undefined"). */
function withEnv<T>(vars: Readonly<Record<string, string>>, fn: () => T): T {
  const saved = Object.keys(vars).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------- helpers ----------

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
    env: { ...baseEnv(), ...env }
  });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function fakeEnv(mode: string, extra: Record<string, string> = {}): Record<string, string> {
  const data = tempDir();
  return { MUSE_COMPANION_DATA: data, FAKE_MUSE_MODE: mode, FAKE_MUSE_LOG: join(data, "muse.log"), MUSE_COMPANION_SESSION_ID: "s1", ...extra };
}

type Call = { args: string[]; prompt: string; promptFile: string; promptMode: number; leakedEnv: string[] };

const museCalls = (env: Record<string, string>): Call[] =>
  readFileSync(env.FAKE_MUSE_LOG ?? "", "utf8").trim().split("\n").map((l) => JSON.parse(l) as Call);

const after_ = (args: readonly string[], flagName: string): string | undefined => args[args.indexOf(flagName) + 1];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A Claude Code transcript where Claude Code keeps them: under the test HOME's ~/.claude/projects. */
function projectTranscript(name: string): string {
  const dir = join(HOME, ".claude", "projects", "p");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), '{"type":"user"}\n');
  return join(dir, name);
}

/** Folds a recorded stream the way runMuseTurn does. */
function foldFixture(name: string): TurnState & { progress: Progress[] } {
  const state = newTurnState();
  const progress: Progress[] = [];
  for (const line of readFileSync(join(FIXTURES, name), "utf8").split("\n")) {
    const record = parseRecord(line);
    if (record) progress.push(...foldRecord(state, record, "write"));
  }
  return { ...state, progress };
}

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
  const parsed = parseArgs(["--model", "spark", "--wait", "--unknown", "focus", "--scope=branch"], { values: ["model", "scope"], booleans: ["wait"] });
  assert.deepEqual(parsed.options, { model: "spark", wait: true, scope: "branch" });
  assert.deepEqual(parsed.positionals, ["--unknown", "focus"]);
  assert.throws(() => parseArgs(["--model"], { values: ["model"] }), /Missing value/);
  assert.throws(() => parseArgs(["--model", "--background"], { values: ["model"], booleans: ["background"] }), /Missing value/, "a flag is never an option's value");
});

// ---------- muse ----------

test("every profile replaces the user's permissions for the run and passes the headless flags", () => {
  const fixed = ["--disable-request-user-input", "--no-foreign-personal-context", "-c", "hooks={}"];
  const head = (profile: "read-only" | "write" | "full-access") => buildMuseArgs({ profile, sessionId: "sid" }, "/tmp/p.md");
  const permissionsOf = (args: readonly string[]) => JSON.parse((args.find((a) => a.startsWith("permissions=")) ?? "").slice("permissions=".length)) as { schema_version: number; profiles: Record<string, unknown> };
  for (const profile of ["read-only", "write", "full-access"] as const) {
    const args = head(profile);
    assert.deepEqual(args.slice(0, 6), ["exec", "--json", "--prompt-file", "/tmp/p.md", "--session-id", "sid"], profile);
    assert.deepEqual(args.slice(6, 10), fixed, profile);
    assert.equal(permissionsOf(args).schema_version, 1, profile);
  }
  const ro = head("read-only");
  assert.deepEqual(permissionsOf(ro).profiles, { [READ_ONLY_PROFILE_ID]: { extends: ":read-only", approval: "allow_all", reviewer: "none" } }, "denies instead of asking a human");
  assert.equal(after_(ro, "--permission-profile"), READ_ONLY_PROFILE_ID);
  assert.ok(ro.includes("--disable-write"));
  const rw = head("write");
  assert.deepEqual(permissionsOf(rw).profiles, {});
  assert.equal(after_(rw, "--approval-mode"), "never");
  assert.ok(!rw.includes("--permission-profile") && !rw.includes("--disable-write"));
  const full = head("full-access");
  assert.equal(after_(full, "--permission-profile"), ":unrestricted");
  assert.ok(!full.includes("--yolo"), "--yolo would also trust the workspace");
  const all = buildMuseArgs({ profile: "write", sessionId: "s", model: "m", effort: "low", schemaPath: "/s.json", maxModelSteps: 4 }, "/p");
  assert.deepEqual(all.slice(-9), ["--model", "m", "--reasoning-effort", "low", "--output-schema", "/s.json", "--disable-reminders", "--max-model-steps", "4"]);
  assert.ok(!head("write").includes("--disable-reminders"), "tasks keep Muse's reminders");
});

test("museEnv drops Claude plugin variables, the companion's own, and the fail-open switch", () => {
  const env = museEnv({ PATH: "/bin", CLAUDE_PLUGIN_ROOT: "/p", CLAUDE_PLUGIN_DATA: "/d", CLAUDE_ENV_FILE: "/e", MUSE_COMPANION_DATA: "/x", MUSE_PERMISSION_PROFILE_FAIL_OPEN: "1", META_API_KEY: "k", UNSET: undefined });
  assert.deepEqual(env, { PATH: "/bin", META_API_KEY: "k" });
});

test("spark and wonder resolve to the newest non-contributor Muse model of the family", () => {
  const models = parseModels({ models: [{ modelId: "muse-wonder-1.0", releaseDate: "2026-10-12" }, { modelId: "muse-spark-1.3-contributor", releaseDate: "2026-09-03" }, { modelId: "muse-spark-1.3", releaseDate: "2026-09-02" }, { modelId: "muse-spark-1.10", releaseDate: "2026-09-02" }, { modelId: "muse-spark-1.2", releaseDate: "2026-08-05" }] });
  assert.equal(resolveModelAlias("spark", models), "muse-spark-1.10", "same release date: the higher version wins");
  assert.equal(resolveModelAlias("WONDER", models), "muse-wonder-1.0");
  assert.equal(resolveModelAlias("muse-spark-1.2", models), "muse-spark-1.2");
  assert.throws(() => resolveModelAlias("wonder", []), /No Muse wonder model/);
});

test("the record that reveals the session still reports its own progress", () => {
  const state = newTurnState();
  const record = { payload_type: "tool.result", stream: { kind: "session", id: "sid" }, payload: { correlation_facts: { tool_name: "edit_file", outcome: "success" }, edit_facts: { path: "a.py" } } };
  assert.deepEqual(foldRecord(state, record, "write").map((p) => p.message), ["Muse session sid started (write)", "Edited: a.py"]);
  assert.deepEqual(state.touched, ["a.py"]);
});

test("parseRecord accepts only structurally valid records", () => {
  assert.equal(parseRecord("muse: workspace root: /repo"), null);
  assert.equal(parseRecord('{"payload_type":"x"}'), null);
  assert.equal(parseRecord('{"payload":{}}'), null);
  assert.equal(parseRecord("{not json"), null);
  assert.equal(parseRecord('{"payload_type":"run.usage","payload":{}}')?.payload_type, "run.usage");
});

test("a real Muse 1.4.11 write run folds into its session, edits, commands, and answer", () => {
  const run = foldFixture("exec-write.jsonl");
  assert.equal(run.sessionId, "01a159a2-bc49-7f40-9ebf-0b596ab8a393");
  assert.equal(run.model, "muse-wonder-1.0");
  assert.equal(run.terminal?.terminal, "completed");
  assert.match(run.terminal?.text ?? "", /^1: ok/);
  assert.deepEqual(run.touched, ["edit_never.txt"], "the refused outside write is not an edit");
  assert.equal(run.editToolUsed, true);
  const messages = run.progress.map((p) => p.message);
  assert.ok(messages.includes("Ran: ls (exit 0)"), messages.join("\n"));
  assert.ok(messages.includes("Edited: edit_never.txt"));
  assert.ok(messages.includes("Edit refused: /outside/edit_never.txt"));
  assert.equal(run.progress[0]?.conversationId, run.sessionId, "the session is reported with the first record");
  assert.equal(run.allowance?.window?.used_percent !== undefined, true);
});

test("a real denied edit counts as edit-tool use but edits nothing; a real echo run has no model record", () => {
  const denied = foldFixture("exec-denied-edit.jsonl");
  assert.deepEqual(denied.touched, []);
  assert.equal(denied.editToolUsed, true);
  const echo = foldFixture("exec-echo.jsonl");
  assert.equal(echo.model, undefined);
  assert.equal(echo.terminal?.terminal, "completed");
  assert.ok(echo.sessionId);
});

test("a real --output-schema answer is the review JSON itself", () => {
  const review = foldFixture("exec-review.jsonl");
  const output = asReviewOutput(normalizeReview(parseStructured(review.terminal?.text ?? ""), "/repo"));
  assert.equal(output?.verdict, "needs-attention");
  assert.equal(output?.findings[0]?.file, "calc.py");
});

test("plainPath unwraps the markdown links Muse writes and keeps repository paths relative", () => {
  assert.equal(plainPath("[calc.py](/repo/calc.py:4)", "/repo"), "calc.py");
  assert.equal(plainPath("[x](/repo/src/x.ts:4-9)", "/repo"), "src/x.ts");
  assert.equal(plainPath("/repo/src/a.ts", "/repo"), "src/a.ts");
  assert.equal(plainPath("/etc/hosts", "/repo"), "/etc/hosts");
  assert.equal(plainPath("/repo/../etc/hosts", "/repo"), "/repo/../etc/hosts");
  assert.equal(plainPath("lib/a.py", "/repo"), "lib/a.py");
  assert.equal(plainPath("calc.py:4-5", "/repo"), "calc.py");
  assert.equal(plainPath("/repo/a.ts:12", "/repo"), "a.ts");
  assert.equal(plainPath("[x](/repo/src/x.ts#L4-L9)", "/repo"), "src/x.ts");
  assert.equal(plainPath("[x](/repo/x.ts#L4)", "/repo"), "x.ts");
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

test("renderTask flags edits outside the repository by resolved path, not by string prefix", () => {
  const out = renderTask("ok", { touchedFiles: ["calc.py", "/repo/src/a.ts", "/repo/../etc/hosts", "/repository/x"], conversationId: "c", repoRoot: "/repo" });
  assert.match(out, /WARNING: muse edited files outside the repository \(\/repo\): \/repo\/\.\.\/etc\/hosts, \/repository\/x\n/);
  assert.match(out, /muse session: c \(resume in the CLI: muse resume c\)\n$/);
});

test("turnFailure distinguishes failed runs, exit codes, and empty answers (schema runs included)", () => {
  const outcome = (terminal: Partial<TurnOutcome["terminal"]>, exitCode = 0): TurnOutcome => ({
    terminal: { terminal: "completed", text: "", reason: null, ...terminal },
    sessionId: "s",
    touchedFiles: [],
    editToolUsed: false,
    stderr: "muse: workspace root: /repo (cwd default)\nrun ended with Failed: boom\n",
    exitCode
  });
  assert.equal(turnFailure(outcome({ text: "ok" })), null);
  assert.equal(turnFailure(outcome({ terminal: "failed", reason: "model `spark` does not exist" })), "model `spark` does not exist");
  assert.equal(turnFailure(outcome({ terminal: "cancelled" }, 1)), "run ended with Failed: boom", "muse's notices are not the failure");
  assert.match(turnFailure(outcome({ text: "partial" }, 1)) ?? "", /Failed: boom/);
  assert.match(turnFailure(outcome({ text: "  \n" })) ?? "", /empty response/);
});

test("setup reads every signed-in account state, and a keyless provider as ready", () => {
  assert.deepEqual(describeAccount({ state: "accountLogin", credentialRequired: true }), { authenticated: true, detail: "signed in (Meta account)" });
  assert.deepEqual(describeAccount({ state: "envKey", credentialRequired: true }), { authenticated: true, detail: "signed in (META_API_KEY)" });
  assert.deepEqual(describeAccount({ state: "apiKey" }), { authenticated: true, detail: "signed in (stored API key)" });
  assert.equal(describeAccount({ state: "loggedOut", credentialRequired: true }).authenticated, false);
  assert.equal(describeAccount({ state: "loggedOut", credentialRequired: false }).authenticated, true);
});

test("the MSP probe pipelines its requests and matches out-of-order answers by id", () => {
  const sent = mspRequests(["account/read", "model/list"]).trim().split("\n").map((l) => JSON.parse(l) as { method: string; id?: number; params: { clientInfo?: { name: string } } });
  assert.deepEqual(sent.map((r) => r.method), ["initialize", "initialized", "account/read", "model/list"]);
  assert.match(sent[0]?.params.clientInfo?.name ?? "", /^[a-z0-9_]+$/, "muse requires a snake_case client name");
  assert.equal(sent[1]?.id, undefined, "initialized is a notification");
  const out = '{"id":2,"result":{"models":[]}}\nnoise\n{"id":1,"result":{"state":"loggedOut"}}\n{"id":0,"result":{}}\n';
  assert.deepEqual(parseMspOutput(out, ["account/read", "model/list"]), { "account/read": { state: "loggedOut" }, "model/list": { models: [] } });
  assert.throws(() => parseMspOutput('{"id":1,"error":{"message":"nope"}}\n', ["account/read"]), /account\/read failed: nope/);
  assert.throws(() => parseMspOutput("", ["account/read"]), /did not answer account\/read/);
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

test("context collection never runs a repository-configured fsmonitor hook", () => {
  const repo = makeRepo();
  const marker = join(tempDir(), "fsmonitor-ran");
  const hook = join(tempDir(), "fsmonitor.sh");
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  git(repo, "config", "core.fsmonitor", hook);
  collectReviewContext(repo, resolveReviewTarget(repo, {}));
  assert.ok(!existsSync(marker));
});

// ---------- jobs ----------

test("terminal job states are final and job references match by unique prefix", () => {
  withEnv({ MUSE_COMPANION_DATA: tempDir() }, () => {
    const root = tempDir();
    const job = createJob({ id: "task-abc", kind: "task", title: "t", summary: "s", status: "running", phase: "running", workspaceRoot: root });
    updateJob(root, job.id, { status: "cancelled", phase: "cancelled" });
    updateJob(root, job.id, { status: "completed", phase: "done" });
    assert.equal(readJob(root, job.id)?.status, "cancelled");
    const jobs = [{ id: "task-abc" }, { id: "task-abd" }] as Job[];
    assert.equal(matchJob(jobs, "task-abc").id, "task-abc");
    assert.throws(() => matchJob(jobs, "task-ab"), /ambiguous/);
    assert.throws(() => matchJob(jobs, "zzz"), /No job found/);
    assert.match(generateJobId("transfer"), /^transfer-/);
    assert.match(generateJobId("adversarial-review"), /^review-/);
  });
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

// muse copies the environment when it spawns (synchronously, inside runMuseTurn), so withEnv may restore it at once.
test("runMuseTurn stops muse when the spawn hook refuses (cancelled before start)", async () => {
  let musePid = 0;
  await assert.rejects(
    withEnv({ FAKE_MUSE_MODE: "slow" }, () =>
      runMuseTurn({ cwd: tempDir(), prompt: "x", profile: "read-only", sessionId: "s", onSpawn: (pid) => { musePid = pid; throw new Error("job cancelled"); } })
    ),
    /job cancelled/
  );
  assert.ok(musePid > 0 && pidGone(musePid));
});

test("runMuseTurn stops muse when a progress callback throws", async () => {
  let musePid = 0;
  await assert.rejects(
    withEnv({ FAKE_MUSE_MODE: "slow" }, () =>
      runMuseTurn({ cwd: tempDir(), prompt: "x", profile: "write", sessionId: "s", onSpawn: (pid) => { musePid = pid; }, onProgress: () => { throw new Error("log disk full"); } })
    ),
    /log disk full/
  );
  assert.ok(pidGone(musePid));
  assert.equal(process.env.FAKE_MUSE_MODE, undefined, "no test mode leaks into later in-process tests");
});

test("runMuseTurn passes the prompt in a private file outside the workspace and removes it after", async () => {
  const cwd = tempDir();
  const log = join(tempDir(), "muse.log");
  const outcome = await withEnv({ FAKE_MUSE_LOG: log, CLAUDE_PLUGIN_ROOT: "/plugins/muse", MUSE_PERMISSION_PROFILE_FAIL_OPEN: "1" }, () =>
    runMuseTurn({ cwd, prompt: "Don't touch `$HOME`", profile: "read-only", sessionId: "sid-1" })
  );
  const call = JSON.parse(readFileSync(log, "utf8").trim()) as Call;
  assert.equal(call.prompt, "Don't touch `$HOME`");
  assert.equal(call.promptMode, 0o600);
  assert.ok(!call.promptFile.startsWith(cwd), "never inside the workspace");
  assert.ok(!existsSync(dirname(call.promptFile)), "removed once the run settled");
  assert.deepEqual(call.leakedEnv, [], "plugin variables and the fail-open switch never reach muse");
  assert.equal(after_(call.args, "--session-id"), "sid-1");
  assert.equal(outcome.sessionId, "sid-1");
});

test("runMuseTurn stops a run whose records name another session", async () => {
  await assert.rejects(withEnv({ FAKE_MUSE_MODE: "wrong-session" }, () => runMuseTurn({ cwd: tempDir(), prompt: "x", profile: "write", sessionId: "mine" })), /not the requested mine/);
});

test("runMuseTurn enforces its own deadline", async () => {
  await assert.rejects(withEnv({ FAKE_MUSE_MODE: "slow" }, () => runMuseTurn({ cwd: tempDir(), prompt: "x", profile: "read-only", sessionId: "s", deadlineMs: 300 })), /did not finish within 0s/);
});

// ---------- runtime against a fake muse ----------

test("review renders structured findings by severity, with plain paths, from a read-only schema run", () => {
  const repo = makeRepo();
  const env = fakeEnv("review");
  const run = companion(repo, ["review", "--model spark"], env);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Verdict: needs-attention/);
  assert.ok(run.stdout.indexOf("[critical] mul adds (calc.py:4-5") < run.stdout.indexOf("[low] Minor"), run.stdout);
  const call = museCalls(env)[0];
  assert.ok(call);
  assert.equal(after_(call.args, "--model"), "muse-spark-1.3", "spark: newest non-contributor Spark");
  assert.equal(after_(call.args, "--permission-profile"), READ_ONLY_PROFILE_ID);
  assert.match(after_(call.args, "--output-schema") ?? "", /review-output\.schema\.json$/);
  assert.match(call.prompt, /def mul\(a, b\)/);
});

test("a review whose answer is not the schema shape, or empty, fails visibly", () => {
  const invalid = companion(makeRepo(), ["review"], fakeEnv("badjson"));
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /did not return the structured review shape[\s\S]*looks fine/);
  const empty = companion(makeRepo(), ["review"], fakeEnv("empty"));
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /muse returned an empty response/);
});

test("commands ignore a foreign CLAUDE_PLUGIN_DATA (another plugin's export) and use MUSE_COMPANION_DATA", () => {
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
  assert.match(museCalls(env)[0]?.prompt ?? "", /User focus: challenge the coupon design/);
});

test("review refuses focus text and adversarial review forwards it", () => {
  const repo = makeRepo();
  assert.match(companion(repo, ["review", "look at auth"], fakeEnv("review")).stderr, /does not take focus text/);
  const env = fakeEnv("review");
  assert.equal(companion(repo, ["adversarial-review", "--wait question the retry design"], env).status, 0);
  assert.match(museCalls(env)[0]?.prompt ?? "", /User focus: question the retry design/);
});

test("--args-stdin through the commands' quoted heredoc: shell syntax in focus text is kept, never run", () => {
  const repo = makeRepo();
  const env = fakeEnv("review");
  const marker = join(tempDir(), "ran");
  const args = `--wait --scope working-tree challenge \`touch ${marker}\` and $(touch ${marker}) don't`;
  // The exact shell shape the review commands tell Claude to run.
  const r = spawnSync("bash", ["-c", `node "${COMPANION}" adversarial-review --args-stdin --background <<'MUSE_ARGS_qwertyui'\n${args}\nMUSE_ARGS_qwertyui\n`], {
    cwd: repo,
    encoding: "utf8",
    env: { ...baseEnv(), ...env }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /started in the background/, "flags before the stdin arguments still apply");
  const jobId = /(review-\S+) started/.exec(r.stdout)?.[1] ?? "";
  assert.match(companion(repo, ["result", jobId, "--wait"], env).stdout, /Target: working tree diff/);
  assert.ok(!existsSync(marker), "nothing in the arguments was executed");
  assert.ok((museCalls(env)[0]?.prompt ?? "").includes(`User focus: challenge \`touch ${marker}\` and $(touch ${marker}) don't`));
});

test("the worker reviews the target resolved at launch, even after the tree changes", () => {
  const repo = makeRepo();
  const env = fakeEnv("review");
  const job = withEnv({ MUSE_COMPANION_DATA: env.MUSE_COMPANION_DATA ?? "" }, () =>
    createJob({
      id: "review-frozen",
      kind: "review",
      title: "t",
      summary: "s",
      status: "queued",
      phase: "queued",
      workspaceRoot: repo,
      reviewRequest: { cwd: repo, target: { mode: "working-tree", label: "working tree diff" }, focus: "" }
    })
  );
  git(repo, "checkout", "-q", "-b", "feature");
  git(repo, "commit", "-qam", "now clean: an auto target would switch to the branch");
  assert.equal(companion(repo, ["job-worker", "--cwd", repo, "--job-id", job.id], env).status, 0);
  const done = JSON.parse(companion(repo, ["status", job.id, "--json"], env).stdout) as Job;
  assert.match(done.rendered ?? "", /Target: working tree diff/);
});

test("review of a clean tree reports nothing to review without calling muse", () => {
  const repo = makeRepo();
  git(repo, "commit", "-qam", "all in");
  const env = fakeEnv("review");
  const run = companion(repo, ["review", "--scope working-tree"], env);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Nothing to review/);
  assert.ok(!existsSync(env.FAKE_MUSE_LOG ?? ""));
});

test("write task reports edited files and the session; --resume-last continues it", () => {
  const repo = makeRepo();
  const env = fakeEnv("task");
  const first = companion(repo, ["task", "--write"], env, "Fix mul. Don't touch add's \"tests\".");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Files edited by muse:\n- calc\.py\n/);
  assert.ok(!first.stdout.includes("WARNING"), "calc.py is inside the repository");
  const firstCall = museCalls(env)[0];
  assert.equal(after_(firstCall?.args ?? [], "--approval-mode"), "never", "write = Muse's workspace sandbox, no prompts");
  assert.equal(firstCall?.prompt, "Fix mul. Don't touch add's \"tests\".");
  const session = /muse session: (\S+) \(resume in the CLI: muse resume \1\)/.exec(first.stdout)?.[1] ?? "";
  assert.equal(session, after_(firstCall?.args ?? [], "--session-id"));

  const candidate = JSON.parse(companion(repo, ["task-resume-candidate", "--json"], env).stdout) as { available: boolean; candidate: { conversationId: string } };
  assert.equal(candidate.available, true);
  assert.equal(candidate.candidate.conversationId, session);

  const second = companion(repo, ["task", "--resume-last", "--write"], env, "");
  assert.equal(second.status, 0, second.stderr);
  const secondCall = museCalls(env)[1];
  assert.equal(after_(secondCall?.args ?? [], "--session-id"), session);
  assert.match(secondCall?.prompt ?? "", /Continue the previous task/);
});

test("a resume re-applies the requested access level, because muse re-applies flags on every run", () => {
  const repo = makeRepo();
  const env = fakeEnv("task");
  companion(repo, ["task", "--write"], env, "edit things");
  assert.equal(companion(repo, ["task", "--resume-last"], env, "now only look").status, 0);
  assert.equal(companion(repo, ["task", "--resume-last", "--full-access"], env, "build").status, 0);
  const [write, readOnly, full] = museCalls(env);
  assert.equal(after_(readOnly?.args ?? [], "--session-id"), after_(write?.args ?? [], "--session-id"));
  assert.equal(after_(readOnly?.args ?? [], "--permission-profile"), READ_ONLY_PROFILE_ID);
  assert.ok(readOnly?.args.includes("--disable-write"));
  assert.equal(after_(full?.args ?? [], "--permission-profile"), ":unrestricted");
  assert.equal(after_(full?.args ?? [], "--session-id"), after_(write?.args ?? [], "--session-id"));
});

test("a run that failed before muse reported a session is never resumed", () => {
  const repo = makeRepo();
  const env = fakeEnv("signed-out");
  const run = companion(repo, ["task", "--write", "x"], env);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /missing meta credentials.*Run \/muse:setup\./);
  const candidate = JSON.parse(companion(repo, ["task-resume-candidate", "--json"], env).stdout) as { available: boolean };
  assert.equal(candidate.available, false);
});

test("resume is scoped to the Claude session", () => {
  const repo = makeRepo();
  const env = fakeEnv("task");
  companion(repo, ["task", "do it"], env);
  assert.match(companion(repo, ["task", "--resume-last"], { ...env, MUSE_COMPANION_SESSION_ID: "other" }).stderr, /No previous muse task thread/);
  const { MUSE_COMPANION_SESSION_ID: _drop, ...noSession } = env;
  assert.match(companion(repo, ["task", "--resume-last"], noSession).stderr, /MUSE_COMPANION_SESSION_ID is not set/);
});

test("two simultaneous resumes cannot both take the session's thread", async () => {
  const repo = makeRepo();
  const env = fakeEnv("task");
  companion(repo, ["task", "first"], env);
  const resume = (): Promise<Run> =>
    new Promise((done) => {
      const child = spawn(process.execPath, [COMPANION, "task", "--resume-last", "--background", "--json"], {
        cwd: repo,
        env: { ...baseEnv(), ...env, FAKE_MUSE_MODE: "slow" }
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

test("failed muse runs exit non-zero with the actionable error and what was already edited", () => {
  const repo = makeRepo();
  const error = companion(repo, ["task", "--write", "x"], fakeEnv("error"));
  assert.equal(error.status, 1);
  assert.match(error.stdout, /# muse task failed\n\nquota exhausted/);
  assert.match(error.stdout, /Files edited by muse before it stopped:\n- half-done\.js/);
  assert.match(error.stdout, /continue it with \/muse:rescue --resume/);
  const sandboxed = companion(repo, ["task", "--write", "commit it"], fakeEnv("sandboxed"));
  assert.equal(sandboxed.status, 1);
  assert.match(sandboxed.stdout, /re-run with --full-access/);
  const stderrOnly = companion(repo, ["task", "--write", "commit it"], fakeEnv("sandboxed-stderr"));
  assert.equal(stderrOnly.status, 1);
  assert.match(stderrOnly.stdout, /re-run with --full-access/, "a failure reported only on stderr still gets the hint");
});

test("a write run's refused edit is not reported as edited, and an edit outside the repository is flagged", () => {
  const repo = makeRepo();
  const denied = companion(repo, ["task", "--write", "x"], fakeEnv("denied-edit"));
  assert.equal(denied.status, 0, denied.stderr);
  assert.ok(!denied.stdout.includes("Files edited by muse"), denied.stdout);
  const outside = companion(repo, ["task", "--write", "x"], fakeEnv("outside"));
  assert.match(outside.stdout, /WARNING: muse edited files outside the repository .*\/outside\/x\.txt/);
});

test("--full-access runs muse's built-in unrestricted profile, never --yolo", () => {
  const env = fakeEnv("task");
  assert.equal(companion(makeRepo(), ["task", "--full-access"], env, "build it").status, 0);
  const args = museCalls(env)[0]?.args ?? [];
  assert.equal(after_(args, "--permission-profile"), ":unrestricted");
  assert.ok(!args.includes("--yolo"));
});

test("cancel stops a foreground run: the companion and muse's own process group", async () => {
  const repo = makeRepo();
  const env = fakeEnv("slow");
  const child = spawn(process.execPath, [COMPANION, "task", "slow work"], {
    cwd: repo,
    env: { ...baseEnv(), ...env },
    stdio: ["pipe", "ignore", "ignore"]
  });
  child.stdin.end();
  const exited = new Promise((r) => child.on("exit", r));
  let job: Job | undefined;
  for (let i = 0; i < 50 && !job?.musePid; i += 1) {
    await sleep(100);
    job = (JSON.parse(companion(repo, ["status", "--json"], env).stdout) as { jobs: Job[] }).jobs[0];
  }
  const musePid = job?.musePid ?? 0;
  assert.ok(musePid > 0, "muse pid recorded");
  assert.equal(companion(repo, ["cancel", job?.id ?? ""], env).status, 0);
  await exited;
  await sleep(200);
  assert.throws(() => process.kill(musePid, 0), /ESRCH/);
  assert.equal((JSON.parse(companion(repo, ["status", job?.id ?? "", "--json"], env).stdout) as Job).status, "cancelled");
});

test("a foreground run that outlasts the wait slice keeps running and can be awaited again", async () => {
  const repo = makeRepo();
  const env = { ...fakeEnv("slow"), MUSE_COMPANION_WAIT_MS: "1500" };
  const first = companion(repo, ["task", "long one"], env);
  assert.equal(first.status, 0);
  const jobId = /muse task (\S+) is still running/.exec(first.stdout)?.[1] ?? "";
  assert.ok(jobId, first.stdout);
  assert.match(first.stdout, new RegExp(`result ${jobId} --wait`));
  assert.match(companion(repo, ["result", jobId, "--wait"], env).stdout, /still running/);
  assert.match(companion(repo, ["result", "--wait"], env).stdout, new RegExp(`${jobId} is still running`), "no id: waits on the running job");
  assert.equal(companion(repo, ["cancel", jobId], env).status, 0);
});

test("a read-only run that somehow edits files fails loudly", () => {
  const run = companion(makeRepo(), ["task", "look only"], fakeEnv("rogue"));
  assert.equal(run.status, 1);
  assert.match(run.stdout, /edited files during a read-only run \(calc\.py\)/);
});

test("a read-only run fails on any edit-tool use, even one that names no file", () => {
  const run = companion(makeRepo(), ["task", "look only"], fakeEnv("rogue-untargeted"));
  assert.equal(run.status, 1);
  assert.match(run.stdout, /used an edit tool during a read-only run/);
});

test("a read-only run whose working tree changes completes with a warning naming the paths", () => {
  const repo = makeRepo();
  const run = companion(repo, ["review"], fakeEnv("shell-write"));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Verdict: needs-attention/);
  assert.match(run.stdout, /Warning: the working tree changed while muse ran read-only \(shell-wrote\.txt\)\. If nothing else edited/);
  const clean = companion(makeRepo(), ["review"], fakeEnv("review"));
  assert.ok(!clean.stdout.includes("working tree changed"), clean.stdout);
});

test("treeFingerprint sees a further edit to an already-modified file and a deletion", () => {
  const repo = makeRepo();
  const before = treeFingerprint(repo);
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b + 0\n");
  assert.deepEqual(changedPaths(before, treeFingerprint(repo)), ["calc.py"]);
  const beforeDelete = treeFingerprint(repo);
  rmSync(join(repo, "calc.py"));
  assert.deepEqual(changedPaths(beforeDelete, treeFingerprint(repo)), ["calc.py"]);
  assert.deepEqual(changedPaths(treeFingerprint(repo), treeFingerprint(repo)), []);
});

test("a read-only run that also fails for another reason still reports the broken boundary", () => {
  const outcome: TurnOutcome = {
    terminal: { terminal: "failed", text: "", reason: "quota exhausted" },
    sessionId: "s",
    touchedFiles: [],
    editToolUsed: true,
    stderr: "",
    exitCode: 1
  };
  const failure = readOnlyFailure(outcome) ?? "";
  assert.match(failure, /quota exhausted/);
  assert.match(failure, /used an edit tool during a read-only run/);
});

test("result --wait shows a job that fails while waited on and exits 0, so /muse:result is not aborted", () => {
  const repo = makeRepo();
  const env = fakeEnv("slow-error");
  const { jobId } = JSON.parse(companion(repo, ["task", "--background", "--json"], env, "x").stdout) as { jobId: string };
  const waited = companion(repo, ["result", jobId, "--wait"], env);
  assert.equal(waited.status, 0, waited.stderr);
  assert.match(waited.stdout, /quota exhausted/);
  assert.equal(companion(repo, ["task", "y"], env).status, 1, "a foreground launch still exits non-zero on failure");
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
  assert.match(companion(repo, ["status"], env).stdout, new RegExp(`\\| ${jobId} \\| task \\| completed \\| done \\| \\S+ \\| Fixed mul in calc\\.py\\. \\|`), "the summary drops Muse's link targets");
  assert.match(companion(repo, ["result"], env).stdout, /Fixed mul in \[calc\.py\]\(\/repo\/calc\.py:4\)\./, "the answer itself is verbatim");
  assert.ok(museCalls(env).every((c) => c.args.includes("--disable-write")), "a task without --write is read-only");
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

test("session hooks export the session id and transcript, and cancel only that session's jobs", async () => {
  const repo = makeRepo();
  const env = fakeEnv("slow");
  const envFile = join(tempDir(), "env");
  writeFileSync(envFile, "");
  companion(repo, ["hook", "SessionStart"], { ...env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: "/plugins/data/muse" }, JSON.stringify({ session_id: "s1", transcript_path: "/home/u/.claude/projects/p/s1.jsonl" }));
  const exported = readFileSync(envFile, "utf8");
  assert.match(exported, /export MUSE_COMPANION_SESSION_ID='s1'/);
  assert.match(exported, /export MUSE_COMPANION_TRANSCRIPT_PATH='\/home\/u\/\.claude\/projects\/p\/s1\.jsonl'/);
  assert.match(exported, /export MUSE_COMPANION_DATA='\/plugins\/data\/muse'/);
  assert.ok(!exported.includes("CLAUDE_PLUGIN_DATA"), "must not clobber other plugins' CLAUDE_PLUGIN_DATA");
  const mine = JSON.parse(companion(repo, ["task", "--background", "--json"], env, "a").stdout) as { jobId: string };
  const theirs = JSON.parse(companion(repo, ["task", "--background", "--json"], { ...env, MUSE_COMPANION_SESSION_ID: "s2" }, "b").stdout) as { jobId: string };
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
  companion(repo, ["setup", "--enable-review-gate", "--json"], { ...fakeEnv("task"), MUSE_COMPANION_DATA: data });
  assert.deepEqual(JSON.parse(stop("block", data).stdout), { decision: "block", reason: "muse stop-time review: fake block" });
  assert.equal(stop("allow", data).stdout, "");
  assert.equal(stop("block", data, { stop_hook_active: true }).stdout, "");
  assert.match(stop("error", data).stdout, /"systemMessage":"muse stop-time review skipped: quota exhausted"/);
  assert.match(stop("badverdict", data).stdout, /no valid allow\/block verdict/);
  assert.match(stop("block", data, { cwd: "/nonexistent/muse-test" }).stdout, /"systemMessage":"muse stop-time review skipped/);
  git(repo, "commit", "-qam", "clean");
  assert.equal(stop("block", data).stdout, "");
});

test("setup reports readiness, the last-seen quota, contributor mode, missing auth, and conflicting /muse plugins", () => {
  const repo = makeRepo();
  const home = tempDir();
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "muse@muse-plugin-cc": [], "muse@ph3on1x": [] } }));
  mkdirSync(join(home, ".config", "muse"), { recursive: true });
  writeFileSync(join(home, ".config", "muse", "settings.json"), JSON.stringify({ schema_version: 1, contributor_mode_enabled: true }));
  // The setup probes get the scrubbed environment too: the fake serve refuses a leaked variable.
  const env = { ...fakeEnv("task"), HOME: home, CLAUDE_PLUGIN_ROOT: "/plugins/muse", CLAUDE_PLUGIN_DATA: "/plugins/data" };
  assert.match(companion(repo, ["setup"], env).stdout, /Quota: shown after the first muse run/);
  companion(repo, ["task", "x"], env);
  const text = companion(repo, ["setup"], env).stdout;
  assert.match(text, /Status: ready/);
  assert.match(text, /Auth: signed in \(Meta account\)/);
  assert.ok(!text.includes("user@example.com"), "the account email stays out of the transcript");
  assert.match(text, /5h window: 44% used, resets /);
  assert.match(text, /Weekly: 13% used/);
  assert.match(text, /Contributor mode: on \(Meta may use session content/);
  assert.match(text, /Warning: muse@muse-plugin-cc also uses the \/muse: namespace/);
  const envkey = JSON.parse(companion(repo, ["setup", "--json"], fakeEnv("envkey")).stdout) as { ready: boolean; availability: { detail: string } };
  assert.equal(envkey.availability.detail, "signed in (META_API_KEY)");
  const unauth = companion(repo, ["setup"], fakeEnv("unauthenticated")).stdout;
  assert.match(unauth, /Status: not ready/);
  assert.match(unauth, /Sign in: run `!muse login`/);
  assert.match(companion(repo, ["setup"], fakeEnv("serve-exit3")).stdout, /Auth: not ready - muse serve exited 3/);
  const missing = companion(repo, ["setup"], { ...fakeEnv("task"), MUSE_COMPANION_MUSE_BIN: "/nonexistent/muse" }).stdout;
  assert.match(missing, /muse: not installed/);
  assert.match(missing, /curl -fsSL https:\/\/dev\.meta\.ai\/install\.sh \| sh/);
});

test("transfer hands the Claude transcript to muse's importer in a read-only session that rescue can resume", () => {
  const repo = makeRepo();
  const transcript = projectTranscript("claude-session.jsonl");
  const env = { ...fakeEnv("task"), MUSE_COMPANION_TRANSCRIPT_PATH: transcript };
  const run = companion(repo, ["transfer", "--args-stdin"], env, "");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Recap: goal fix mul/);
  const call = museCalls(env)[0];
  assert.ok(call?.prompt.startsWith(`/resume-claude "${realpathSync(transcript)}"\n`), call?.prompt);
  assert.equal(after_(call?.args ?? [], "--permission-profile"), READ_ONLY_PROFILE_ID);
  const session = after_(call?.args ?? [], "--session-id") ?? "";
  assert.match(run.stdout, new RegExp(`muse session: ${session} \\(resume in the CLI: muse resume ${session}\\)`));
  assert.match(companion(repo, ["status"], env).stdout, /\| transfer-\S+ \| transfer \| completed/);
  const candidate = JSON.parse(companion(repo, ["task-resume-candidate", "--json"], env).stdout) as { candidate: { kind: string; conversationId: string } };
  assert.deepEqual([candidate.candidate.kind, candidate.candidate.conversationId], ["transfer", session]);
  assert.equal(companion(repo, ["task", "--resume-last", "--write"], env, "apply it").status, 0);
  assert.equal(after_(museCalls(env)[1]?.args ?? [], "--session-id"), session, "rescue continues the transferred session");
});

test("transfer validates its source before starting any job, and sends only Claude Code transcripts", () => {
  const repo = makeRepo();
  const env = fakeEnv("task");
  assert.match(companion(repo, ["transfer"], env).stderr, /transcript is unknown\. Pass --source <claude-jsonl>/);
  assert.match(companion(repo, ["transfer", "--source /nope/x.jsonl"], env).stderr, /not a readable file/);
  const txt = join(tempDir(), "notes.txt");
  writeFileSync(txt, "x");
  assert.match(companion(repo, ["transfer", `--source ${txt}`], env).stderr, /\.jsonl/);
  const outside = join(tempDir(), "elsewhere.jsonl");
  writeFileSync(outside, "{}\n");
  assert.match(companion(repo, ["transfer", `--source ${outside}`], env).stderr, /only from .*\.claude\/projects/);
  const escape = projectTranscript("link.jsonl");
  rmSync(escape);
  symlinkSync(outside, escape);
  assert.match(companion(repo, ["transfer", `--source ${escape}`], env).stderr, /only from/, "a symlink out of the projects dir is refused");
  const notes = join(HOME, ".claude", "projects", "p", "MEMORY.md");
  writeFileSync(notes, "# notes\n");
  const disguised = join(tempDir(), "session.jsonl");
  symlinkSync(notes, disguised);
  assert.match(companion(repo, ["transfer", `--source ${disguised}`], env).stderr, /\(\.jsonl\): .*MEMORY\.md/, "a .jsonl symlink to another file is refused");
  projectTranscript('a"b.jsonl');
  assert.match(companion(repo, ["transfer", "--args-stdin"], env, `--source '~/.claude/projects/p/a"b.jsonl'`).stderr, /plain path/);
  assert.match(companion(repo, ["transfer", "--args-stdin"], env, "--source x.jsonl please").stderr, /takes only --source/);
  const transcript = projectTranscript("s.jsonl");
  assert.equal(companion(dirname(transcript), ["transfer", "--args-stdin"], env, "--source s.jsonl").status, 0, "resolved against the working directory");
  assert.equal(companion(repo, ["transfer", "--args-stdin"], env, "--source ~/.claude/projects/p/s.jsonl").status, 0, "~ expands to the home directory");
  assert.equal(museCalls(env).length, 2, "only the valid sources reached muse");
});

// ---------- command contracts ----------

const read = (path: string): string => readFileSync(join(PLUGIN, path), "utf8");

test("plugin exposes the full codex command set, transfer included", () => {
  assert.deepEqual(readdirSync(join(PLUGIN, "commands")).sort(), ["adversarial-review.md", "cancel.md", "rescue.md", "result.md", "review.md", "setup.md", "status.md", "transfer.md"]);
});

test("no file still names agy, Antigravity, or Gemini", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "fixtures" ? [] : files(join(dir, e.name))) : [join(dir, e.name)]));
  for (const file of files(PLUGIN).filter((f) => !f.endsWith("muse.test.mts"))) {
    // The README links the agy plugin on purpose.
    const leftover = file.endsWith("README.md") ? /antigravity|gemini/i : /\bagy\b|antigravity|gemini/i;
    assert.ok(!leftover.test(readFileSync(file, "utf8")), file);
  }
});

test("review commands stay review-only, ask once, and support background runs", () => {
  for (const [file, kind] of [["commands/review.md", "review"], ["commands/adversarial-review.md", "adversarial-review"]] as const) {
    const source = read(file);
    assert.match(source, /disable-model-invocation: true/);
    assert.match(source, /review-only/);
    assert.match(source, /Do not fix issues/);
    assert.match(source, /AskUserQuestion/);
    assert.match(source, /\(Recommended\)/);
    // Arguments travel on stdin through a quoted heredoc, so the shell never expands focus text.
    assert.ok(source.includes(`muse-companion.mts" ${kind} --args-stdin <<'MUSE_ARGS_<suffix>'\n$ARGUMENTS\nMUSE_ARGS_<suffix>\n`));
    assert.ok(source.includes(`muse-companion.mts" ${kind} --args-stdin --background <<'MUSE_ARGS_<suffix>'\n$ARGUMENTS\nMUSE_ARGS_<suffix>\n`), "--background must precede a user --");
    assert.match(source, /no line of the arguments equals the\s+delimiter/);
    assert.ok(!source.includes('"$ARGUMENTS"'));
    assert.ok(!source.includes("Claude background task"), "background runs are detached jobs, not background Bash");
    // The size estimate runs before the runtime, so it needs the runtime's git hardening too.
    for (const line of source.split("\n").filter((l) => /`git (status|diff)/.test(l))) assert.fail(`unhardened git: ${line}`);
    assert.match(source, /Return the command stdout verbatim/);
  }
});

test("transfer runs as a waited job with heredoc arguments, never an inline command", () => {
  const source = read("commands/transfer.md");
  assert.match(source, /disable-model-invocation: true/);
  assert.match(source, /argument-hint: '\[--source <claude-jsonl>\]'/);
  assert.ok(source.includes(`muse-companion.mts" transfer --args-stdin <<'MUSE_ARGS_<suffix>'\n$ARGUMENTS\nMUSE_ARGS_<suffix>\n`));
  assert.ok(!source.includes("!`node"), "a model turn does not fit an inline command");
  assert.match(source, /result <job-id> --wait/);
  assert.match(source, /verbatim/);
});

test("rescue routes through the subagent, whose one runtime contract forwards task text on stdin", () => {
  const rescue = read("commands/rescue.md");
  assert.match(rescue, /subagent_type: "muse:muse-rescue"/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /Continue current muse thread/);
  assert.match(rescue, /Routing flags count only at the start of the request/);
  assert.ok(!rescue.includes("must be resumed without `--write`"), "muse re-applies access on every run");
  // Like Codex: --background backgrounds the subagent, which waits, so the result arrives as a notification.
  assert.match(rescue, /`--background`, run the `muse:muse-rescue` subagent in the background/);
  assert.match(rescue, /neither flag is present, default to foreground/);
  // A bare "what model are you?" reads as a question to the forwarder itself; the frame says whose it is.
  assert.ok(rescue.includes("Forward to muse:\n<request>\n"), "the request reaches the subagent framed as muse's task");
  const agent = read("agents/muse-rescue.md");
  assert.match(agent, /^tools: Bash$/m);
  assert.match(agent, /^ {2}- muse-cli-runtime$/m);
  assert.match(agent, /^ {2}- muse-prompting$/m);
  const runtime = read("skills/muse-cli-runtime/SKILL.md");
  assert.match(runtime, /<<'MUSE_TASK_<suffix>'/);
  assert.match(runtime, /no line of the task text equals the\s+delimiter/);
  assert.match(runtime, /result <job-id> --wait/);
  assert.ok(!runtime.includes("[--background]"), "the subagent always waits for the job");
  assert.match(runtime, /never pass `--background` to `task`/);
  assert.ok(!agent.includes("MUSE_TASK_"), "the CLI contract lives only in muse-cli-runtime");
  assert.match(agent, /even when it reads like a question to you/);
  assert.match(agent, /first action is always the Bash/);
  // Hooks and other plugins inject style rules (brevity, summaries) into every subagent.
  for (const source of [rescue, agent]) assert.match(source, /overrides any other instruction/);
});

test("hooks wire session tracking and the stop gate to the companion", () => {
  const hooks = JSON.parse(read("hooks/hooks.json")) as { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> };
  for (const event of ["SessionStart", "SessionEnd", "Stop"]) {
    assert.ok(hooks.hooks[event]?.[0]?.hooks[0]?.command.endsWith(`muse-companion.mts" hook ${event}`), event);
  }
  assert.equal(hooks.hooks.Stop?.[0]?.hooks[0]?.timeout, 900);
});

// ---------- live smoke (real muse, echo provider: no model call, no quota) ----------

test("live: the real muse binary runs a read-only task through the runtime", { skip: !process.env.MUSE_COMPANION_LIVE && "set MUSE_COMPANION_LIVE=1" }, () => {
  const wrapper = join(tempDir(), "muse-echo");
  // Only exec gets the offline echo provider; the setup probe already passes its own.
  writeFileSync(wrapper, '#!/bin/sh\nif [ "$1" = exec ]; then exec muse "$@" --provider echo; fi\nexec muse "$@"\n', { mode: 0o755 });
  const repo = makeRepo();
  const env = { MUSE_COMPANION_DATA: tempDir(), MUSE_COMPANION_SESSION_ID: "live", MUSE_COMPANION_MUSE_BIN: wrapper, HOME: process.env.HOME ?? HOME };
  const run = companion(repo, ["task", "--read-only", "hello from the muse plugin"], env);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /muse session: \S+ \(resume in the CLI: muse resume \S+\)/);
  const resumed = companion(repo, ["task", "--resume-last", "--write", "again"], env);
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.match(companion(repo, ["setup"], env).stdout, /muse: Muse Code \d/);
});
