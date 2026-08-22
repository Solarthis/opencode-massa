#!/usr/bin/env node
/**
 * opencode-massa MCP server.
 *
 * Six tools, deliberately. Every MCP schema costs Claude context on every turn,
 * so the surface is the smallest one that still lets Claude act as engineering
 * lead: inspect, plan, delegate, verify, review, report.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { client, ensureServer, opencodeVersion } from "./opencode.js";
import { discoverModels, routeAll, type ModelInfo } from "./models.js";
import { ROLES, REVIEW_SCHEMA, type ReviewResult, type Role } from "./roles.js";
import { GuardError, assertSafe } from "./guards.js";
import { diffStat, fullDiff, git, isGitRepo, preexistingChanges } from "./worktree.js";
import { discoverCommands, runAll } from "./verify.js";
import { renderResults, runBatch, type TaskSpec } from "./run.js";
import {
  completionBlockers,
  createRun,
  event,
  latestRun,
  listRuns,
  load,
  newRunId,
  runPath,
  save,
  statusBoard,
  writeArtifact,
  type Route,
  type RunState,
} from "./state.js";

const server = new McpServer({ name: "opencode-massa", version: "0.1.0" });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

/** Model catalog is stable within a run; refresh on demand. */
let modelCache: { at: number; models: ModelInfo[] } | null = null;
async function models(base: string, refresh = false): Promise<ModelInfo[]> {
  if (!refresh && modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache.models;
  const m = await discoverModels(base);
  modelCache = { at: Date.now(), models: m };
  return m;
}

function requireDir(dir: string): string {
  const d = resolve(dir);
  if (!existsSync(d)) throw new Error(`Project directory does not exist: ${d}`);
  return d;
}

function loadRun(dir: string, runId?: string): RunState {
  const d = requireDir(dir);
  const s = runId ? load(d, runId) : latestRun(d);
  if (!s) throw new Error(`No Massa run found under ${d}/.massa/runs/. Call massa_plan first.`);
  return s;
}

async function guarded<T extends { content: unknown[] }>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GuardError) return fail(e.message);
    return fail(`massa error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. massa_env - discovery
// ---------------------------------------------------------------------------
server.registerTool(
  "massa_env",
  {
    title: "Inspect Massa environment",
    description:
      "Check the OpenCode backend and discover the live model catalog and the role->model routing table. " +
      "Call once at the start of a run. Reports blockers (no OpenCode, no models) explicitly rather than degrading silently.",
    inputSchema: {
      project_dir: z.string().describe("Absolute path to the project."),
      refresh: z.boolean().optional().describe("Force re-discovery of the model catalog."),
    },
  },
  async ({ project_dir, refresh }) =>
    guarded(async () => {
      const dir = requireDir(project_dir);
      const srv = await ensureServer();
      const list = await models(srv.url, refresh);

      const lines: string[] = [];
      lines.push(`OpenCode ${srv.version} - server ${srv.url} (${srv.managed ? "managed by massa" : "pre-existing"})`);
      lines.push(`project: ${dir}`);

      if (isGitRepo(dir)) {
        const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
        const pre = preexistingChanges(dir);
        lines.push(`git: branch ${branch}, ${pre.length} uncommitted file(s)${pre.length ? ` (PROTECTED - not Massa's work): ${pre.join(", ")}` : ""}`);
      } else {
        lines.push("git: NOT a git repository. Diff review and worktree isolation are unavailable; run `git init` first for full capability.");
      }

      lines.push("");
      if (list.length === 0) {
        lines.push("BLOCKER: OpenCode reports zero available models.");
        lines.push("Run `opencode auth login` to add a provider, or check network access to the free tier. Massa cannot delegate until this is fixed.");
        return text(lines.join("\n"));
      }

      lines.push(`Available models (${list.length}):`);
      for (const m of list) {
        lines.push(
          `  ${m.ref}  ctx=${m.context.toLocaleString()} out=${m.output.toLocaleString()} ` +
            `tools=${m.tools ? "y" : "n"} reasoning=${m.reasoning ? "y" : "n"} ` +
            `cost=${m.free ? "free" : `$${m.costIn}/$${m.costOut} per Mtok`}`,
        );
      }

      lines.push("");
      lines.push("Role routing (recomputed from the live catalog, no names hard-coded):");
      const table = routeAll(list);
      for (const r of ROLES) lines.push(`  ${r.padEnd(10)} -> ${table[r].model.ref}  (${table[r].reason})`);

      lines.push("");
      const cmds = discoverCommands(dir);
      lines.push(
        cmds.length
          ? `Discovered verification commands:\n${cmds.map((c) => `  ${c.command}  [${c.kind}, from ${c.source}]`).join("\n")}`
          : "No verification commands discovered. Acceptance criteria will need explicit checks (consider having a tester worker create them).",
      );
      return text(lines.join("\n"));
    }),
);

// ---------------------------------------------------------------------------
// 2. massa_plan - create or resume a run
// ---------------------------------------------------------------------------
server.registerTool(
  "massa_plan",
  {
    title: "Create or resume a Massa run",
    description:
      "Create a run with an objective, measurable acceptance criteria and a task plan; or resume/inspect prior runs. " +
      "Use route 'audit' with resume=true for 'continue' / 'what's left?' requests - it reconstructs prior state instead of restarting work. " +
      "Criteria should be observable (a command, a file, a checkable outcome), never subjective.",
    inputSchema: {
      project_dir: z.string(),
      objective: z.string().optional().describe("Concrete desired end state. Required for a new run."),
      route: z.enum(["tiny", "normal", "complex", "audit"]).optional().describe("Execution strategy. Default: normal."),
      criteria: z
        .array(z.object({ id: z.string(), text: z.string(), check: z.string().optional().describe("Shell command; exit 0 = pass.") }))
        .optional(),
      plan: z
        .array(
          z.object({
            id: z.string(),
            role: z.enum(["scout", "architect", "builder", "debugger", "tester", "reviewer"]),
            description: z.string(),
            dependsOn: z.array(z.string()).optional(),
            scope: z.array(z.string()).optional().describe("Write ownership globs, e.g. src/api/**"),
          }),
        )
        .optional(),
      constraints: z.array(z.string()).optional(),
      max_iterations: z.number().optional().describe("Correction-loop budget. Default 4."),
      resume: z.boolean().optional().describe("Load the most recent run instead of creating one."),
      run_id: z.string().optional(),
    },
  },
  async (a) =>
    guarded(async () => {
      const dir = requireDir(a.project_dir);

      if (a.resume || (!a.objective && (a.run_id || latestRun(dir)))) {
        const prior = listRuns(dir);
        if (prior.length === 0) return text(`No prior Massa runs under ${dir}. Start a new one by supplying an objective.`);
        const s = a.run_id ? load(dir, a.run_id) : prior[0];
        const out = [statusBoard(s), "", `state: ${runPath(s)}`];
        const d = diffStat(dir);
        out.push("", `Working tree now: ${d.files.length} changed file(s) (+${d.insertions}/-${d.deletions})`);
        if (d.stat) out.push(d.stat);
        const blockers = completionBlockers(s);
        out.push("", blockers.length ? `Remaining gaps:\n${blockers.map((b) => "  - " + b).join("\n")}` : "No remaining gaps recorded.");
        if (prior.length > 1) out.push("", `Other runs: ${prior.slice(1).map((p) => `${p.runId}(${p.status})`).join(", ")}`);
        return text(out.join("\n"));
      }

      if (!a.objective) throw new Error("objective is required to create a run (or pass resume=true).");
      assertSafe(a.objective);

      const state = createRun({
        runId: newRunId(),
        projectDir: dir,
        route: (a.route ?? "normal") as Route,
        status: "planning",
        objective: a.objective,
        constraints: a.constraints ?? [],
        criteria: (a.criteria ?? []).map((c) => ({ ...c, status: "pending" as const })),
        plan: (a.plan ?? []).map((p) => ({ ...p, dependsOn: p.dependsOn ?? [], done: false })),
        workers: [],
        verifications: [],
        reviews: [],
        iteration: 0,
        maxIterations: a.max_iterations ?? 4,
        preexisting: preexistingChanges(dir),
        branch: isGitRepo(dir) ? git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout : undefined,
        notes: [],
      });

      const out = [statusBoard(state), "", `state: ${runPath(state)}`];
      if (state.criteria.length === 0)
        out.push("", "WARNING: no acceptance criteria. Massa cannot certify completion without them - add measurable criteria before implementation.");
      if (state.preexisting.length)
        out.push("", `Pre-existing uncommitted work is recorded and must be preserved: ${state.preexisting.join(", ")}`);
      return text(out.join("\n"));
    }),
);

// ---------------------------------------------------------------------------
// 3. massa_run - delegate work to OpenCode workers
// ---------------------------------------------------------------------------
server.registerTool(
  "massa_run",
  {
    title: "Run OpenCode worker(s)",
    description:
      "Delegate one or more assignments to OpenCode workers. Each task names a role, which fixes its model (routed dynamically), " +
      "its tools and its server-enforced permissions - scout/architect/reviewer cannot write, by construction. " +
      "Multiple writers run in parallel ONLY when their `scope` globs are disjoint or each sets isolate=true (git worktree); " +
      "otherwise Massa serializes them and says so. Give each worker only the context it needs - do not paste the repository. " +
      "Returns compact evidence (files actually changed, tools actually used); full transcripts stay on disk.",
    inputSchema: {
      project_dir: z.string(),
      run_id: z.string().optional(),
      tasks: z
        .array(
          z.object({
            id: z.string().describe("Short stable id, e.g. 'scout-api'."),
            role: z.enum(["scout", "architect", "builder", "debugger", "tester", "reviewer"]),
            prompt: z.string().describe("The assignment, with the context this worker needs and nothing more."),
            scope: z.array(z.string()).optional().describe("Write ownership globs. Required to parallelize writers."),
            isolate: z.boolean().optional().describe("Run in a dedicated git worktree, merged afterwards."),
            session_id: z.string().optional().describe("Continue this OpenCode session (keeps its context)."),
            model: z.string().optional().describe("Override the routed model. Normally omit."),
            timeout_ms: z.number().optional(),
          }),
        )
        .min(1),
    },
  },
  async (a) =>
    guarded(async () => {
      const state = loadRun(a.project_dir, a.run_id);
      const srv = await ensureServer();
      const list = await models(srv.url);
      if (list.length === 0) throw new Error("No OpenCode models available - cannot delegate. Run massa_env for diagnosis.");

      state.status = "running";
      save(state);

      const tasks: TaskSpec[] = a.tasks.map((t) => ({
        id: t.id,
        role: t.role as Role,
        prompt: t.prompt,
        scope: t.scope,
        isolate: t.isolate,
        sessionID: t.session_id,
        model: t.model,
        timeoutMs: t.timeout_ms,
      }));

      const builderFamily = list.find((m) => m.ref === state.workers.find((w) => w.role === "builder")?.model)?.family;
      const outcome = await runBatch(state, srv.url, list, tasks, { avoidFamily: builderFamily });

      for (const p of state.plan) if (outcome.results.some((r) => r.id === p.id && r.ok)) p.done = true;
      save(state);

      const failed = outcome.results.filter((r) => !r.ok);
      const header = failed.length
        ? `${failed.length}/${outcome.results.length} worker(s) FAILED. Do not treat this work as done.\n\n`
        : "";
      return text(header + renderResults(outcome, runPath(state)));
    }),
);

// ---------------------------------------------------------------------------
// 4. massa_verify - independent verification
// ---------------------------------------------------------------------------
server.registerTool(
  "massa_verify",
  {
    title: "Independently verify the work",
    description:
      "Run the project's real checks in the project directory and record the results against acceptance criteria. " +
      "This is independent of any worker's claim - a worker saying 'done' proves nothing. " +
      "With no commands given, runs every command discovered from the repo's own manifests. Never invents commands. " +
      "Also reports the current diff summary. Failing checks mark criteria failed and block completion.",
    inputSchema: {
      project_dir: z.string(),
      run_id: z.string().optional(),
      commands: z.array(z.string()).optional().describe("Explicit commands. Omit to use discovered ones plus criteria checks."),
      timeout_ms: z.number().optional(),
    },
  },
  async (a) =>
    guarded(async () => {
      const state = loadRun(a.project_dir, a.run_id);
      state.status = "verifying";
      save(state);

      const criteriaChecks = state.criteria.map((c) => c.check).filter((c): c is string => !!c);
      const commands = a.commands?.length
        ? a.commands
        : [...new Set([...discoverCommands(state.projectDir).map((c) => c.command), ...criteriaChecks])];

      if (commands.length === 0)
        return text(
          "No verification commands available: none supplied, none discoverable from the repository, and no acceptance criterion has a `check`.\n" +
            "Massa will NOT certify this work. Add a check to at least one criterion, or have a tester worker create a runnable test.",
        );

      const results = await runAll(commands, state.projectDir, a.timeout_ms);
      state.verifications.push(...results);

      // A criterion with a check is decided by that check, and only that check.
      for (const c of state.criteria) {
        if (!c.check) continue;
        const r = results.find((x) => x.command === c.check);
        if (!r) continue;
        c.status = r.passed ? "pass" : "fail";
        c.evidence = `exit ${r.exitCode} (${Math.round(r.durationMs / 1000)}s)`;
      }
      save(state);
      event(state, "verify", { commands, passed: results.filter((r) => r.passed).length });

      const lines: string[] = [];
      const pass = results.filter((r) => r.passed).length;
      lines.push(`Verification: ${pass}/${results.length} commands passed (run in ${state.projectDir})`);
      lines.push("");
      for (const r of results) {
        lines.push(`${r.passed ? "PASS" : "FAIL"}  ${r.command}  (exit ${r.exitCode}, ${Math.round(r.durationMs / 1000)}s)`);
        if (!r.passed && r.tail) lines.push(r.tail.split("\n").map((l) => "    " + l).join("\n"));
      }

      const d = diffStat(state.projectDir);
      lines.push("", `Diff: ${d.files.length} file(s) (+${d.insertions}/-${d.deletions})`);
      if (d.stat) lines.push(d.stat);

      const untouched = state.preexisting.filter((f) => d.files.includes(f));
      if (untouched.length) lines.push("", `NOTE: these files had uncommitted changes before this run and now appear in the diff - confirm the user's work was preserved: ${untouched.join(", ")}`);

      const blockers = completionBlockers(state);
      lines.push("", blockers.length ? `Completion blocked by:\n${blockers.map((b) => "  - " + b).join("\n")}` : "No completion blockers from verification.");
      return text(lines.join("\n"));
    }),
);

// ---------------------------------------------------------------------------
// 5. massa_review - independent read-only review
// ---------------------------------------------------------------------------
server.registerTool(
  "massa_review",
  {
    title: "Independent read-only review",
    description:
      "Run a read-only reviewer over the actual git diff. The reviewer is routed to a different model family from the builder " +
      "where one is available, to avoid correlated blind spots, and cannot edit anything. " +
      "Returns structured findings {verdict, findings[{severity,file,issue,recommended_fix}]}. " +
      "Claude adjudicates which findings are valid - do not forward them to a fixer unexamined.",
    inputSchema: {
      project_dir: z.string(),
      run_id: z.string().optional(),
      focus: z.string().optional().describe("Extra emphasis, e.g. 'security of the auth path'."),
      model: z.string().optional(),
    },
  },
  async (a) =>
    guarded(async () => {
      const state = loadRun(a.project_dir, a.run_id);
      const srv = await ensureServer();
      const list = await models(srv.url);
      state.status = "reviewing";
      save(state);

      const diff = fullDiff(state.projectDir);
      if (!diff.trim() || diff === "(not a git repository)")
        return text(
          diff === "(not a git repository)"
            ? "Cannot review: not a git repository, so there is no diff to review. Run `git init` and commit a baseline first."
            : "Nothing to review: the working tree has no changes against HEAD.",
        );

      const d = diffStat(state.projectDir);
      const verif = state.verifications.slice(-8).map((v) => `${v.passed ? "PASS" : "FAIL"} ${v.command} (exit ${v.exitCode})`);

      const prompt = [
        `ORIGINAL REQUEST:\n${state.objective}`,
        state.constraints.length ? `CONSTRAINTS:\n${state.constraints.map((c) => "- " + c).join("\n")}` : "",
        state.criteria.length
          ? `ACCEPTANCE CRITERIA:\n${state.criteria.map((c) => `- [${c.status}] ${c.id}: ${c.text}${c.check ? ` (check: ${c.check})` : ""}`).join("\n")}`
          : "",
        state.plan.length ? `IMPLEMENTATION PLAN:\n${state.plan.map((p) => `- ${p.id} (${p.role}): ${p.description}`).join("\n")}` : "",
        verif.length ? `VERIFICATION RESULTS:\n${verif.join("\n")}` : "VERIFICATION: none run yet.",
        `FILES CHANGED (+${d.insertions}/-${d.deletions}):\n${d.files.join("\n")}`,
        a.focus ? `PARTICULAR FOCUS: ${a.focus}` : "",
        `DIFF:\n\`\`\`diff\n${diff}\n\`\`\``,
        "Review this change. Read any surrounding files you need for context. Report only real, actionable defects.",
      ]
        .filter(Boolean)
        .join("\n\n");

      const builderFamily = list.find((m) => m.ref === [...state.workers].reverse().find((w) => w.role === "builder" || w.role === "debugger")?.model)?.family;

      const outcome = await runBatch(
        state,
        srv.url,
        list,
        [{ id: `review-${state.iteration + 1}`, role: "reviewer", prompt, schema: REVIEW_SCHEMA, model: a.model, timeoutMs: 20 * 60_000 }],
        { avoidFamily: builderFamily },
      );

      const r = outcome.results[0];
      if (!r.ok || !r.structured) return fail(`Review failed: ${r.error ?? "no structured findings returned"}. Completion is NOT certified.`);

      const review = r.structured as ReviewResult;
      state.reviews.push({ ...review, at: Date.now(), iteration: state.iteration + 1 });
      state.iteration += 1;
      save(state);
      writeArtifact(state, `review-${state.iteration}.json`, JSON.stringify(review, null, 2));
      event(state, "review", { verdict: review.verdict, findings: review.findings.length });

      const lines: string[] = [];
      lines.push(`Reviewer: ${r.model} (builder family: ${builderFamily ?? "n/a"}) - iteration ${state.iteration}/${state.maxIterations}`);
      lines.push(`Verdict: ${review.verdict.toUpperCase()}`);
      lines.push(`Summary: ${review.summary}`);
      lines.push("");
      if (review.findings.length === 0) lines.push("No findings.");
      for (const f of review.findings) {
        lines.push(`[${f.severity.toUpperCase()}] ${f.file}`);
        lines.push(`  issue: ${f.issue}`);
        lines.push(`  fix:   ${f.recommended_fix}`);
      }
      if (state.iteration >= state.maxIterations)
        lines.push("", `Iteration budget exhausted (${state.maxIterations}). Do not loop further - report remaining findings to the user instead.`);
      lines.push("", "You are the adjudicator: judge each finding against the code before sending any of them to a builder or debugger.");
      return text(lines.join("\n"));
    }),
);

// ---------------------------------------------------------------------------
// 6. massa_status - status, diff, stop, finalize
// ---------------------------------------------------------------------------
server.registerTool(
  "massa_status",
  {
    title: "Massa run status, diff, stop or final report",
    description:
      "action=status: compact progress board. action=diff: current diff (summary, or full with detail=true). " +
      "action=stop: abort every running worker session for this run. " +
      "action=finalize: emit the final report - it REFUSES while completion blockers remain, so it cannot certify work that did not pass.",
    inputSchema: {
      project_dir: z.string(),
      run_id: z.string().optional(),
      action: z.enum(["status", "diff", "stop", "finalize"]).default("status"),
      detail: z.boolean().optional(),
      note: z.string().optional().describe("Append a note to the run record."),
    },
  },
  async (a) =>
    guarded(async () => {
      const state = loadRun(a.project_dir, a.run_id);
      if (a.note) {
        state.notes.push(a.note);
        save(state);
      }

      if (a.action === "stop") {
        const srv = await ensureServer();
        const running = state.workers.filter((w) => w.status === "running");
        for (const w of running) {
          await client.abort(srv.url, w.directory, w.sessionID);
          w.status = "failed";
          w.error = "stopped by user";
          w.endedAt = Date.now();
        }
        state.status = "stopped";
        save(state);
        event(state, "stopped", { aborted: running.length });
        return text(`Stopped run ${state.runId}. Aborted ${running.length} running worker session(s). The working tree is untouched - inspect the diff before deciding what to keep.`);
      }

      if (a.action === "diff") {
        const d = diffStat(state.projectDir);
        if (!a.detail) return text(`${d.files.length} file(s) changed (+${d.insertions}/-${d.deletions})\n${d.stat}\n\nFiles:\n${d.files.join("\n")}`);
        return text(`${d.stat}\n\n${fullDiff(state.projectDir)}`);
      }

      if (a.action === "finalize") {
        const blockers = completionBlockers(state);
        if (blockers.length) {
          state.status = "blocked";
          save(state);
          return fail(
            `Cannot finalize run ${state.runId} - completion is not supported by evidence:\n` +
              blockers.map((b) => "  - " + b).join("\n") +
              "\n\nFix these and re-verify. Report the true state to the user; do not claim completion.",
          );
        }

        const d = diffStat(state.projectDir);
        const latest = new Map(state.verifications.map((v) => [v.command, v]));
        const review = state.reviews[state.reviews.length - 1];
        const totalFindings = state.reviews.reduce((n, r) => n + r.findings.length, 0);
        const committed = isGitRepo(state.projectDir) && diffStat(state.projectDir).files.length === 0;

        const report = [
          `Massa run ${state.runId} completed.`,
          "",
          "Implemented",
          ...state.plan.filter((p) => p.done).map((p) => `- ${p.description}`),
          "",
          "OpenCode workers",
          ...state.workers.map((w) => `- ${w.id} (${w.role}): ${w.model} - ${w.status}`),
          "",
          "Verification",
          ...[...latest.values()].map((v) => `- ${v.command} ${v.passed ? "PASS" : "FAIL"} (exit ${v.exitCode})`),
          "",
          "Acceptance criteria",
          ...state.criteria.map((c) => `- [${c.status.toUpperCase()}] ${c.text}`),
          "",
          "Review",
          review ? `- ${state.reviews.length} review pass(es), ${totalFindings} finding(s) total, final verdict: ${review.verdict}` : "- no review run",
          "",
          `Files changed (+${d.insertions}/-${d.deletions})`,
          ...(d.files.length ? d.files.map((f) => `- ${f}`) : ["- none"]),
          "",
          "State",
          `- Implemented: yes`,
          `- Tested: ${latest.size > 0 ? "yes" : "no"}`,
          `- Committed: ${committed ? "yes" : "no - changes are in the working tree"}`,
          `- Pushed: no`,
          `- Deployed: no`,
          `- Production verified: no`,
          "",
          `Run state: ${runPath(state)}`,
        ].join("\n");

        state.status = "complete";
        save(state);
        writeArtifact(state, "final-report.md", report);
        event(state, "finalized", {});
        return text(report);
      }

      const d = diffStat(state.projectDir);
      const blockers = completionBlockers(state);
      return text(
        [
          statusBoard(state),
          "",
          `Working tree: ${d.files.length} changed file(s) (+${d.insertions}/-${d.deletions})`,
          blockers.length ? `\nCompletion blockers:\n${blockers.map((b) => "  - " + b).join("\n")}` : "\nNo completion blockers.",
          `\nState: ${runPath(state)}`,
        ].join("\n"),
      );
    }),
);

// ---------------------------------------------------------------------------

async function main() {
  // Fail loudly at startup if OpenCode is missing - silently degrading to
  // "Claude does all the work" would hide an orchestration failure.
  try {
    opencodeVersion();
  } catch (e) {
    process.stderr.write(`[opencode-massa] ${e instanceof Error ? e.message : String(e)}\n`);
  }
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`[opencode-massa] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
