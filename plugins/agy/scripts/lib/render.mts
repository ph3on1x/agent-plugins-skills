/** Plain-text/markdown rendering of companion results. Pure functions only. */
import type { Job } from "./jobs.mts";

export type Finding = {
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly title: string;
  readonly body: string;
  readonly file: string;
  readonly line_start: number;
  readonly line_end: number;
  readonly confidence: number;
  readonly recommendation: string;
};

export type ReviewOutput = {
  readonly verdict: "approve" | "needs-attention";
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly next_steps: readonly string[];
};

const SEVERITY_RANK: Readonly<Record<Finding["severity"], number>> = { critical: 0, high: 1, medium: 2, low: 3 };

const isFinding = (f: unknown): f is Finding => {
  if (typeof f !== "object" || f === null) return false;
  const v = f as Record<string, unknown>;
  return (
    typeof v.severity === "string" && Object.hasOwn(SEVERITY_RANK, v.severity) &&
    typeof v.title === "string" && typeof v.body === "string" && typeof v.file === "string" &&
    Number.isInteger(v.line_start) && Number.isInteger(v.line_end) &&
    typeof v.confidence === "number" && typeof v.recommendation === "string"
  );
};

/** agy enforces the schema; this guards against an agy that silently ignored it. */
export function asReviewOutput(value: unknown): ReviewOutput | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const ok =
    (v.verdict === "approve" || v.verdict === "needs-attention") &&
    typeof v.summary === "string" &&
    Array.isArray(v.findings) && v.findings.every(isFinding) &&
    Array.isArray(v.next_steps) && v.next_steps.every((s) => typeof s === "string");
  return ok ? (value as ReviewOutput) : null;
}

const lineRange = (f: Finding): string => (f.line_end > f.line_start ? `:${f.line_start}-${f.line_end}` : `:${f.line_start}`);

export function renderReview(output: ReviewOutput, meta: { readonly label: string; readonly target: string; readonly omitted: number }): string {
  const findings = [...output.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const lines = [`# agy ${meta.label}`, "", `Target: ${meta.target}`, `Verdict: ${output.verdict}`, "", output.summary, ""];
  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const f of findings) {
      lines.push(`- [${f.severity}] ${f.title} (${f.file}${lineRange(f)}, confidence ${f.confidence})`);
      lines.push(`  ${f.body}`);
      if (f.recommendation) lines.push(`  Recommendation: ${f.recommendation}`);
    }
  }
  if (output.next_steps.length > 0) {
    lines.push("", "Next steps:", ...output.next_steps.map((s) => `- ${s}`));
  }
  if (meta.omitted > 0) {
    lines.push("", `Note: ${meta.omitted} file diff(s) exceeded the inline budget; agy was told to inspect them itself.`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderInvalidReview(meta: { readonly label: string; readonly target: string }, raw: string): string {
  return [`# agy ${meta.label}`, "", `Target: ${meta.target}`, "agy did not return the structured review shape.", "", "Raw response:", "", "```text", raw.trim() || "(empty)", "```", ""].join("\n");
}

export function renderTask(response: string, meta: { readonly touchedFiles: readonly string[]; readonly conversationId: string; readonly repoRoot: string }): string {
  const lines = [response.trimEnd()];
  if (meta.touchedFiles.length > 0) lines.push("", "Files edited by agy:", ...meta.touchedFiles.map((f) => `- ${f}`));
  const outside = meta.touchedFiles.filter((f) => f !== meta.repoRoot && !f.startsWith(`${meta.repoRoot}/`));
  if (outside.length > 0) lines.push("", `WARNING: agy edited files outside the repository (${meta.repoRoot}): ${outside.join(", ")}`);
  lines.push("", `agy conversation: ${meta.conversationId} (resume in the CLI: agy --conversation ${meta.conversationId})`);
  return `${lines.join("\n").trimEnd()}\n`;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function formatDuration(startIso: string | undefined, endIso: string | undefined, now = Date.now()): string {
  const start = Date.parse(startIso ?? "");
  const end = endIso ? Date.parse(endIso) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "-";
  const s = Math.round((end - start) / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m` : s >= 60 ? `${Math.floor(s / 60)}m${pad(s % 60)}s` : `${s}s`;
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function renderJobTable(jobs: readonly Job[], now = Date.now()): string {
  if (jobs.length === 0) return "No agy jobs recorded for this session yet.\n";
  const rows = jobs.map(
    (j) => `| ${j.id} | ${j.kind} | ${j.status} | ${j.phase} | ${formatDuration(j.startedAt ?? j.createdAt, j.completedAt, now)} | ${cell(j.summary || j.title)} |`
  );
  return ["| Job | Kind | Status | Phase | Time | Summary |", "|---|---|---|---|---|---|", ...rows, ""].join("\n");
}

export function renderJobDetail(job: Job, preview: readonly string[], now = Date.now()): string {
  const lines = [
    `# agy job ${job.id}`,
    "",
    `Kind: ${job.kind}${job.profile ? ` (${job.profile})` : ""}`,
    `Status: ${job.status} (${job.phase})`,
    `Title: ${job.title}`,
    `Time: ${formatDuration(job.startedAt ?? job.createdAt, job.completedAt, now)}`
  ];
  if (job.conversationId) lines.push(`agy conversation: ${job.conversationId}`);
  if (job.errorMessage) lines.push(`Error: ${job.errorMessage}`);
  if (preview.length > 0) lines.push("", "Recent progress:", ...preview.map((l) => `- ${l}`));
  lines.push("", `Log: ${job.logFile}`);
  if (job.status === "completed" || job.status === "failed") lines.push(`Result: /agy:result ${job.id}`);
  if (job.status === "queued" || job.status === "running") lines.push(`Cancel: /agy:cancel ${job.id}`);
  return `${lines.join("\n")}\n`;
}
