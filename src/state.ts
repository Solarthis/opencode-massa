/**
 * Run state. Everything needed to answer "where does this stand?" after Claude,
 * the terminal, OpenCode or the machine restarts.
 *
 * Lives in `<repo>/.massa/runs/<run-id>/` and is operational state, not a
 * project asset - we add it to .gitignore on first write.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "./roles.js";
import type { ReviewResult } from "./roles.js";

export interface AcceptanceCriterion {
  id: string;
  text: string;
  /** Command whose exit code decides the criterion, when one exists. */
  check?: string;
  status: "pending" | "pass" | "fail";
  evidence?: string;
}

export type Route = "tiny" | "normal" | "complex" | "audit";

export interface WorkerRecord {
  id: string;
  role: Role;
  model: string;
  sessionID: string;
  /** Where the worker ran - the repo, or an isolated worktree. */
  directory: string;
  status: "running" | "ok" | "failed";
  summary?: string;
  filesChanged?: string[];
  tokens?: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface VerificationRun {
  command: string;
  exitCode: number;
  passed: boolean;
  tail: string;
  durationMs: number;
  at: number;
}

export interface RunState {
  runId: string;
  createdAt: number;
  updatedAt: number;
  projectDir: string;
  route: Route;
  status: "planning" | "running" | "verifying" | "reviewing" | "blocked" | "complete" | "stopped";
  objective: string;
  constraints: string[];
  criteria: AcceptanceCriterion[];
  plan: Array<{ id: string; role: Role; description: string; dependsOn: string[]; scope?: string[]; done: boolean }>;
  workers: WorkerRecord[];
  verifications: VerificationRun[];
  reviews: Array<ReviewResult & { at: number; iteration: number }>;
  iteration: number;
  maxIterations: number;
  /** Uncommitted files present before Massa started. Never touched. */
  preexisting: string[];
  branch?: string;
  notes: string[];
}

export function runsDir(projectDir: string): string {
  return join(projectDir, ".massa", "runs");
}

function runDir(projectDir: string, runId: string): string {
  return join(runsDir(projectDir), runId);
}

/** Keep operational state out of the user's commits. */
export function ensureGitignore(projectDir: string) {
  const gi = join(projectDir, ".gitignore");
  const line = ".massa/";
  try {
    const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    if (!cur.split("\n").some((l) => l.trim() === line)) {
      writeFileSync(gi, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + line + "\n");
    }
  } catch {
    /* read-only checkout: not worth failing a run over */
  }
}

export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export function createRun(init: Omit<RunState, "createdAt" | "updatedAt">): RunState {
  const state: RunState = { ...init, createdAt: Date.now(), updatedAt: Date.now() };
  mkdirSync(runDir(state.projectDir, state.runId), { recursive: true });
  ensureGitignore(state.projectDir);
  save(state);
  event(state, "run.created", { route: state.route, objective: state.objective });
  return state;
}

export function save(state: RunState) {
  state.updatedAt = Date.now();
  const d = runDir(state.projectDir, state.runId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "state.json"), JSON.stringify(state, null, 2));
}

export function load(projectDir: string, runId: string): RunState {
  const f = join(runDir(projectDir, runId), "state.json");
  if (!existsSync(f)) throw new Error(`No Massa run "${runId}" under ${projectDir}/.massa/runs/`);
  return JSON.parse(readFileSync(f, "utf8"));
}

/** Newest run first. Used by `/massa continue` and the audit route. */
export function listRuns(projectDir: string): RunState[] {
  const d = runsDir(projectDir);
  if (!existsSync(d)) return [];
  const out: RunState[] = [];
  for (const id of readdirSync(d)) {
    try {
      out.push(load(projectDir, id));
    } catch {
      /* partially written run dir */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function latestRun(projectDir: string): RunState | null {
  return listRuns(projectDir)[0] ?? null;
}

/** Append-only audit log. Detail lives here so Claude's context stays small. */
export function event(state: RunState, type: string, data: unknown) {
  const d = runDir(state.projectDir, state.runId);
  mkdirSync(d, { recursive: true });
  appendFileSync(join(d, "events.jsonl"), JSON.stringify({ at: Date.now(), type, data }) + "\n");
}

/** Full worker transcripts, kept on disk rather than in anyone's context. */
export function writeArtifact(state: RunState, name: string, content: string) {
  const d = join(runDir(state.projectDir, state.runId), "artifacts");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), content);
  return join(d, name);
}

export function runPath(state: RunState): string {
  return runDir(state.projectDir, state.runId);
}

/** One-glance progress board for Claude. Deliberately tiny. */
export function statusBoard(s: RunState): string {
  const icon = (b: boolean | undefined, running?: boolean) => (running ? "..." : b === undefined ? "-" : b ? "PASS" : "FAIL");
  const lines: string[] = [];
  lines.push(`Massa run ${s.runId}  [${s.route}]  status=${s.status}  iteration ${s.iteration}/${s.maxIterations}`);
  lines.push(`objective: ${s.objective}`);
  if (s.branch) lines.push(`branch: ${s.branch}`);
  lines.push("");

  if (s.plan.length) {
    lines.push("Plan:");
    for (const p of s.plan) lines.push(`  ${p.done ? "[x]" : "[ ]"} ${p.id} (${p.role}) ${p.description}`);
    lines.push("");
  }

  if (s.workers.length) {
    lines.push("Workers:");
    for (const w of s.workers) {
      const dur = w.endedAt ? `${Math.round((w.endedAt - w.startedAt) / 1000)}s` : "running";
      lines.push(`  ${w.status === "ok" ? "PASS" : w.status === "failed" ? "FAIL" : "..."} ${w.id} (${w.role}) ${w.model} ${dur}`);
    }
    lines.push("");
  }

  const passed = s.criteria.filter((c) => c.status === "pass").length;
  if (s.criteria.length) {
    lines.push(`Acceptance criteria: ${passed}/${s.criteria.length} passing`);
    for (const c of s.criteria) {
      const mark = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "-";
      lines.push(`  ${mark} ${c.id}: ${c.text}`);
    }
    lines.push("");
  }

  const lastVerif = new Map<string, VerificationRun>();
  for (const v of s.verifications) lastVerif.set(v.command, v);
  if (lastVerif.size) {
    lines.push("Verification (latest per command):");
    for (const v of lastVerif.values()) lines.push(`  ${icon(v.passed)} ${v.command}`);
    lines.push("");
  }

  const lastReview = s.reviews[s.reviews.length - 1];
  if (lastReview) {
    const open = lastReview.findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
    lines.push(`Review (iteration ${lastReview.iteration}): ${lastReview.verdict}, ${lastReview.findings.length} findings (${open} critical/high)`);
  }

  if (s.preexisting.length) lines.push(`\nPre-existing uncommitted files (protected, not Massa's): ${s.preexisting.join(", ")}`);
  if (s.notes.length) lines.push(`\nNotes:\n${s.notes.map((n) => "  - " + n).join("\n")}`);
  return lines.join("\n");
}

/**
 * Honest completion test. Passing tests are necessary but not sufficient:
 * every criterion must pass, the latest review must not demand changes, and
 * no verification may be failing.
 */
export function completionBlockers(s: RunState): string[] {
  const blockers: string[] = [];
  const failing = s.criteria.filter((c) => c.status !== "pass");
  if (failing.length) blockers.push(`${failing.length} acceptance criteria not passing: ${failing.map((c) => c.id).join(", ")}`);

  const latest = new Map<string, VerificationRun>();
  for (const v of s.verifications) latest.set(v.command, v);
  const failed = [...latest.values()].filter((v) => !v.passed);
  if (failed.length) blockers.push(`failing verification commands: ${failed.map((v) => v.command).join(", ")}`);
  if (s.criteria.length && s.verifications.length === 0) blockers.push("no verification has been run");

  const review = s.reviews[s.reviews.length - 1];
  if (review && review.verdict === "changes_required")
    blockers.push(`latest review verdict is changes_required (${review.findings.length} findings)`);
  if (s.workers.some((w) => w.status === "failed")) blockers.push("one or more workers failed");

  return blockers;
}
