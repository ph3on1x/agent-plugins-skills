/**
 * Review target selection and repository context collection.
 * Git runs without a shell; repository-derived strings never reach one, and no program the
 * repository configures (fsmonitor hook, external diff, textconv) runs.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ReviewScope = "auto" | "working-tree" | "branch";

export type ReviewTarget =
  | { readonly mode: "working-tree"; readonly label: string }
  | { readonly mode: "branch"; readonly label: string; readonly baseRef: string };

export type WorkingTreeState = {
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
};

export type ReviewContext = {
  readonly repoRoot: string;
  readonly branch: string;
  readonly target: ReviewTarget;
  readonly summary: string;
  readonly content: string;
  readonly changedFiles: readonly string[];
  readonly omittedDiffs: readonly string[];
};

export const DEFAULT_INLINE_BUDGET_BYTES = 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 24 * 1024;
// --no-ext-diff/--no-textconv: never run repository-configured diff programs while collecting context.
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--submodule=diff"] as const;

type GitResult = { readonly status: number; readonly stdout: string; readonly stderr: string };

// A repository's core.fsmonitor names a hook that status/diff would run; optional locks would
// let a read-only review rewrite the index.
const GIT_ARGS = ["-c", "core.fsmonitor=false"] as const;

function git(cwd: string, args: readonly string[]): GitResult {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const result = spawnSync("git", [...GIT_ARGS, ...args], { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new Error(code === "ENOENT" ? "git is not installed." : result.error.message);
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function gitChecked(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

/** NUL-separated path lists (`-z`) keep non-ASCII and odd file names exact. */
const paths = (text: string): string[] => text.split("\0").filter(Boolean);

/** Repository root, or null when cwd is not inside a git work tree. */
export function findRepoRoot(cwd: string): string | null {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function requireRepoRoot(cwd: string): string {
  const root = findRepoRoot(cwd);
  if (!root) {
    throw new Error("This command must run inside a Git repository.");
  }
  return root;
}

export function detectDefaultBranch(cwd: string): string {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0 && symbolic.stdout.trim().startsWith("refs/remotes/origin/")) {
    return symbolic.stdout.trim().slice("refs/remotes/".length);
  }
  for (const candidate of ["main", "master", "trunk"]) {
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0) {
      return candidate;
    }
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]).status === 0) {
      return `origin/${candidate}`;
    }
  }
  throw new Error("Unable to detect the default branch. Pass --base <ref> or use --scope working-tree.");
}

export function readWorkingTreeState(cwd: string): WorkingTreeState {
  return {
    staged: paths(gitChecked(cwd, ["diff", "--cached", "--name-only", "-z"])),
    unstaged: paths(gitChecked(cwd, ["diff", "--name-only", "-z"])),
    untracked: paths(gitChecked(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
  };
}

const isDirty = (state: WorkingTreeState): boolean =>
  state.staged.length + state.unstaged.length + state.untracked.length > 0;

export function resolveReviewTarget(cwd: string, options: { readonly scope?: string; readonly base?: string }): ReviewTarget {
  const root = requireRepoRoot(cwd);
  if (options.base) {
    return { mode: "branch", label: `branch diff against ${options.base}`, baseRef: options.base };
  }
  const scope = options.scope ?? "auto";
  if (scope !== "auto" && scope !== "working-tree" && scope !== "branch") {
    throw new Error(`Unsupported review scope "${scope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`);
  }
  if (scope === "working-tree" || (scope === "auto" && isDirty(readWorkingTreeState(root)))) {
    return { mode: "working-tree", label: "working tree diff" };
  }
  const baseRef = detectDefaultBranch(root);
  return { mode: "branch", label: `branch diff against ${baseRef}`, baseRef };
}

/** Splits a unified diff into per-file chunks, each starting at its `diff --git` header. */
export function splitDiff(diff: string): string[] {
  return diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
}

/**
 * Greedily inlines whole chunks while they fit the budget; chunks that do not fit are reported by
 * their first line (the `diff --git` or `### file` header) so the reviewer knows what it missed.
 */
export function packChunks(chunks: readonly string[], budgetBytes: number): { inlined: string[]; omitted: string[]; used: number } {
  const inlined: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const size = Buffer.byteLength(chunk, "utf8");
    if (used + size <= budgetBytes) {
      inlined.push(chunk);
      used += size;
    } else {
      omitted.push(chunk.slice(0, chunk.indexOf("\n") === -1 ? undefined : chunk.indexOf("\n")));
    }
  }
  return { inlined, omitted, used };
}

const isProbablyText = (buffer: Buffer): boolean => !buffer.subarray(0, 4096).includes(0);

function formatUntrackedFile(root: string, file: string): string {
  try {
    // lstat: never follow symlinks out of the repository.
    const stat = lstatSync(join(root, file));
    if (stat.isSymbolicLink()) return `### ${file}\n(skipped: symlink)`;
    if (stat.isDirectory()) return `### ${file}\n(skipped: directory)`;
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) return `### ${file}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_FILE_BYTES} byte limit; read it directly)`;
    const buffer = readFileSync(join(root, file));
    if (!isProbablyText(buffer)) return `### ${file}\n(skipped: binary file)`;
    return `### ${file}\n\`\`\`\n${buffer.toString("utf8").trimEnd()}\n\`\`\``;
  } catch {
    return `### ${file}\n(skipped: unreadable file or broken symlink)`;
  }
}

const section = (title: string, body: string): string => `## ${title}\n\n${body.trim() || "(none)"}\n`;

function omittedSection(omitted: readonly string[], inspect: string): string {
  return omitted.length === 0
    ? ""
    : section("Not Inlined (budget exceeded)", `These changes did not fit. Inspect them yourself with ${inspect}:\n${omitted.join("\n")}`);
}

export function collectReviewContext(cwd: string, target: ReviewTarget, budgetBytes: number = DEFAULT_INLINE_BUDGET_BYTES): ReviewContext {
  const root = requireRepoRoot(cwd);
  const branch = gitChecked(root, ["branch", "--show-current"]).trim() || "HEAD (detached)";

  if (target.mode === "working-tree") {
    const state = readWorkingTreeState(root);
    const status = gitChecked(root, ["status", "--short", "--untracked-files=all"]);
    // One budget shared by staged, unstaged, and untracked content, in that order.
    const staged = packChunks(splitDiff(gitChecked(root, ["diff", "--cached", ...DIFF_FLAGS])), budgetBytes);
    const unstaged = packChunks(splitDiff(gitChecked(root, ["diff", ...DIFF_FLAGS])), budgetBytes - staged.used);
    const untracked = packChunks(state.untracked.map((file) => `${formatUntrackedFile(root, file)}\n\n`), budgetBytes - staged.used - unstaged.used);
    const omittedDiffs = [...staged.omitted, ...unstaged.omitted, ...untracked.omitted];
    return {
      repoRoot: root,
      branch,
      target,
      summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
      content: [
        section("Git Status", status),
        section("Staged Diff", staged.inlined.join("")),
        section("Unstaged Diff", unstaged.inlined.join("")),
        section("Untracked Files", untracked.inlined.join("")),
        omittedSection(omittedDiffs, "`git diff --cached -- <path>` (staged) and `git diff -- <path>` (unstaged); read untracked files directly")
      ].join("\n"),
      changedFiles: [...new Set([...state.staged, ...state.unstaged, ...state.untracked])].sort(),
      omittedDiffs
    };
  }

  const mergeBase = gitChecked(root, ["merge-base", "HEAD", target.baseRef]).trim();
  const range = `${mergeBase}..HEAD`;
  const packed = packChunks(splitDiff(gitChecked(root, ["diff", ...DIFF_FLAGS, range])), budgetBytes);
  return {
    repoRoot: root,
    branch,
    target,
    summary: `Reviewing branch ${branch} against ${target.baseRef} from merge-base ${mergeBase.slice(0, 12)}.`,
    content: [
      section("Commit Log", gitChecked(root, ["log", "--oneline", "--decorate", range])),
      section("Diff Stat", gitChecked(root, ["diff", "--stat", range])),
      section("Branch Diff", packed.inlined.join("")),
      omittedSection(packed.omitted, `\`git diff ${range} -- <path>\``)
    ].join("\n"),
    changedFiles: paths(gitChecked(root, ["diff", "--name-only", "-z", range])),
    omittedDiffs: packed.omitted
  };
}

/** True when there is nothing to review for the target. */
export const isEmptyReview = (context: ReviewContext): boolean => context.changedFiles.length === 0;
