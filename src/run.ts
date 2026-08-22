/**
 * Worker execution: turn a role + assignment into a real OpenCode session,
 * run a batch safely (parallel only when provably safe), and hand Claude back
 * a compact result instead of a transcript.
 */
import {
  client,
  messageText,
  structuredOutput,
  toolsUsed,
  type AssistantMessage,
} from "./opencode.js";
import { assertSafe, redact } from "./guards.js";
import { routeRole, type ModelInfo } from "./models.js";
import { ROLE_SPECS, type Role } from "./roles.js";
import {
  changedBetween,
  createWorktree,
  diffStat,
  fileFingerprints,
  mergeWorktree,
  planScopes,
  removeWorktree,
  type Worktree,
} from "./worktree.js";
import { event, save, writeArtifact, type RunState, type WorkerRecord } from "./state.js";

export interface TaskSpec {
  id: string;
  role: Role;
  /** The assignment. Should already contain the context the worker needs. */
  prompt: string;
  /** Declared write ownership, e.g. ["src/api/**", "tests/api/**"]. */
  scope?: string[];
  /** Run in a dedicated git worktree and merge afterwards. */
  isolate?: boolean;
  /** Continue an existing OpenCode session instead of starting fresh. */
  sessionID?: string;
  /** Force a model, bypassing the router. */
  model?: string;
  /** JSON Schema; when set the worker must produce a matching object. */
  schema?: unknown;
  timeoutMs?: number;
}

export interface TaskResult {
  id: string;
  role: Role;
  model: string;
  sessionID: string;
  ok: boolean;
  /** The worker's own report (truncated, redacted). */
  report: string;
  /** Validated object when a schema was requested. */
  structured?: unknown;
  toolsUsed: string[];
  filesChanged: string[];
  insertions: number;
  deletions: number;
  tokens: number;
  durationMs: number;
  error?: string;
  isolatedIn?: string;
  mergeResult?: string;
}

const DEFAULT_TIMEOUT = 15 * 60_000;

function truncate(s: string, n = 6000): string {
  return s.length > n ? s.slice(0, n) + `\n... [report truncated at ${n} chars]` : s;
}

/**
 * Execute a single task. Creates (or reuses) a session pinned to the routed
 * model with the role's server-enforced permission ruleset, then blocks on the
 * prompt and converts the transcript into evidence.
 */
export async function runTask(
  state: RunState,
  base: string,
  models: ModelInfo[],
  task: TaskSpec,
  opts: { failedModels?: string[]; avoidFamily?: string } = {},
): Promise<TaskResult> {
  const spec = ROLE_SPECS[task.role];
  assertSafe(task.prompt); // never hand a worker a destructive assignment

  const routing = routeRole(task.role, models, {
    override: task.model,
    exclude: opts.failedModels,
    avoidFamily: task.role === "reviewer" ? opts.avoidFamily : undefined,
  });

  let workdir = state.projectDir;
  let wt: Worktree | undefined;
  if (task.isolate && spec.write) {
    wt = createWorktree(state.projectDir, state.runId, task.id);
    workdir = wt.path;
  }

  const started = Date.now();
  // Snapshot before the worker runs so its changes can be attributed to it
  // alone, rather than to whatever else was already dirty in the tree.
  const before = fileFingerprints(workdir);

  const record: WorkerRecord = {
    id: task.id,
    role: task.role,
    model: routing.model.ref,
    sessionID: task.sessionID ?? "",
    directory: workdir,
    status: "running",
    startedAt: started,
  };
  state.workers.push(record);
  save(state);

  const attempted: string[] = [];
  let lastError = "";

  // Try the routed model, then fall back down the ranked list.
  for (const model of [routing.model, ...routing.fallbacks].slice(0, 3)) {
    attempted.push(model.ref);
    try {
      const sessionID =
        task.sessionID ||
        (
          await client.createSession(base, workdir, {
            title: `massa/${state.runId}/${task.id}`,
            model: { providerID: model.providerID, id: model.id },
            permission: spec.permission,
          })
        ).id;

      record.sessionID = sessionID;
      record.model = model.ref;
      save(state);
      event(state, "worker.start", { id: task.id, role: task.role, model: model.ref, sessionID, workdir });

      const body: Record<string, unknown> = {
        model: { providerID: model.providerID, modelID: model.id },
        system: spec.system,
        tools: spec.tools,
        parts: [{ type: "text", text: task.prompt }],
      };
      if (task.schema) body.format = { type: "json_schema", schema: task.schema, retryCount: 2 };

      const msg: AssistantMessage = await client.prompt(
        base,
        workdir,
        sessionID,
        body,
        task.timeoutMs ?? DEFAULT_TIMEOUT,
      );

      if (msg.info?.error) throw new Error(`model reported an error: ${JSON.stringify(msg.info.error).slice(0, 400)}`);

      const after = fileFingerprints(workdir);
      const changed = changedBetween(before, after).filter((f) => !f.startsWith(".massa/"));
      const stat = diffStat(workdir);
      const report = redact(messageText(msg)).text;
      const structured = task.schema ? structuredOutput(msg) : undefined;

      if (task.schema && structured === null)
        throw new Error("worker did not produce valid structured output matching the requested schema");

      // A writing role that changed nothing did not do its job. It either
      // failed silently (common with weaker models: they narrate a fix they
      // never applied) or decided no change was needed. Either way this must
      // NOT count as success - otherwise a plan item gets marked done and a
      // false completion propagates. Claude adjudicates from the report.
      const wroteNothing = spec.write && changed.length === 0;

      const result: TaskResult = {
        id: task.id,
        role: task.role,
        model: model.ref,
        sessionID,
        ok: !wroteNothing,
        error: wroteNothing
          ? "worker completed but changed no files - it either failed silently (claiming a fix it never applied) or judged no change necessary. Read its report and decide; do not treat this task as done."
          : undefined,
        report: truncate(report),
        structured: structured ?? undefined,
        toolsUsed: await toolsUsed(base, workdir, sessionID),
        filesChanged: changed,
        insertions: stat.insertions,
        deletions: stat.deletions,
        tokens: msg.info?.tokens?.total ?? 0,
        durationMs: Date.now() - started,
        isolatedIn: wt?.path,
      };

      writeArtifact(state, `${task.id}.md`, `# ${task.id} (${task.role} / ${model.ref})\n\n${report}\n`);

      if (wt) {
        const m = mergeWorktree(state.projectDir, wt);
        result.mergeResult = m.detail;
        if (!m.ok) {
          result.ok = false;
          result.error = `isolated work could not be merged: ${m.detail}`;
        } else {
          removeWorktree(state.projectDir, wt);
          // After a merge the worker's files live in the main repo; keep the
          // attribution from the isolated tree rather than re-reading the
          // whole (possibly dirty) working tree.
          const merged = diffStat(state.projectDir);
          result.insertions = merged.insertions;
          result.deletions = merged.deletions;
        }
      }

      Object.assign(record, {
        status: result.ok ? "ok" : "failed",
        summary: truncate(report, 800),
        filesChanged: result.filesChanged,
        tokens: result.tokens,
        endedAt: Date.now(),
        error: result.error,
      });
      save(state);
      event(state, "worker.done", { id: task.id, ok: result.ok, model: model.ref, files: result.filesChanged.length });
      return result;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      event(state, "worker.error", { id: task.id, model: model.ref, error: lastError });
      // Retry on a different model only for model-side failures, not guard/merge errors.
      if (/guard|merge|worktree|not a git/i.test(lastError)) break;
    }
  }

  if (wt) removeWorktree(state.projectDir, wt);
  Object.assign(record, { status: "failed", endedAt: Date.now(), error: lastError });
  save(state);

  return {
    id: task.id,
    role: task.role,
    model: attempted[attempted.length - 1] ?? "none",
    sessionID: record.sessionID,
    ok: false,
    report: "",
    toolsUsed: [],
    filesChanged: [],
    insertions: 0,
    deletions: 0,
    tokens: 0,
    durationMs: Date.now() - started,
    error: `all attempted models failed (${attempted.join(", ")}): ${lastError}`,
  };
}

export interface BatchOutcome {
  parallel: boolean;
  reason: string;
  results: TaskResult[];
}

/**
 * Run a batch. Read-only workers always run concurrently. Writers run
 * concurrently only when their declared scopes are provably disjoint or each
 * is isolated in its own worktree; otherwise the batch is serialized.
 *
 * Isolated writers are merged one at a time even when they ran in parallel,
 * because merging is the only genuinely serial step.
 */
export async function runBatch(
  state: RunState,
  base: string,
  models: ModelInfo[],
  tasks: TaskSpec[],
  opts: { avoidFamily?: string } = {},
): Promise<BatchOutcome> {
  const annotated = tasks.map((t) => ({ id: t.id, write: ROLE_SPECS[t.role].write, scope: t.scope }));
  const allIsolated = tasks.filter((t) => ROLE_SPECS[t.role].write).every((t) => t.isolate);
  const plan = allIsolated
    ? { parallel: true, reason: "every writer is isolated in its own git worktree", conflicts: [] }
    : planScopes(annotated);

  event(state, "batch.plan", { tasks: tasks.map((t) => t.id), parallel: plan.parallel, reason: plan.reason });

  let results: TaskResult[];
  if (plan.parallel && tasks.length > 1) {
    if (allIsolated && tasks.filter((t) => ROLE_SPECS[t.role].write).length > 1) {
      // Prompt every worker concurrently, but merge serially to avoid racing on the index.
      const prepared = await Promise.all(
        tasks.map((t) => runTask(state, base, models, { ...t, isolate: true }, opts).catch(errResult(t))),
      );
      results = prepared;
    } else {
      results = await Promise.all(tasks.map((t) => runTask(state, base, models, t, opts).catch(errResult(t))));
    }
  } else {
    results = [];
    for (const t of tasks) results.push(await runTask(state, base, models, t, opts).catch(errResult(t)));
  }

  return { parallel: plan.parallel && tasks.length > 1, reason: plan.reason, results };
}

function errResult(t: TaskSpec) {
  return (e: unknown): TaskResult => ({
    id: t.id,
    role: t.role,
    model: "none",
    sessionID: "",
    ok: false,
    report: "",
    toolsUsed: [],
    filesChanged: [],
    insertions: 0,
    deletions: 0,
    tokens: 0,
    durationMs: 0,
    error: e instanceof Error ? e.message : String(e),
  });
}

/** Compact, Claude-facing rendering of a batch. Full detail stays on disk. */
export function renderResults(o: BatchOutcome, runPathHint: string): string {
  const lines: string[] = [];
  lines.push(`Execution: ${o.parallel ? "parallel" : "serialized"} - ${o.reason}`);
  lines.push("");
  for (const r of o.results) {
    lines.push(`## ${r.id} (${r.role}) - ${r.ok ? "OK" : "FAILED"}`);
    lines.push(`model: ${r.model} | ${Math.round(r.durationMs / 1000)}s | ${r.tokens} tokens | session: ${r.sessionID || "-"}`);
    if (r.isolatedIn) lines.push(`isolated: ${r.isolatedIn}${r.mergeResult ? ` | merge: ${r.mergeResult}` : ""}`);
    if (r.toolsUsed.length) lines.push(`tools used: ${r.toolsUsed.join(", ")}`);
    if (r.filesChanged.length) lines.push(`files changed (+${r.insertions}/-${r.deletions}): ${r.filesChanged.join(", ")}`);
    if (r.error) lines.push(`error: ${r.error}`);
    if (r.structured) lines.push("structured output:\n" + JSON.stringify(r.structured, null, 2));
    else if (r.report) lines.push("\n" + r.report);
    lines.push("");
  }
  lines.push(`Full transcripts: ${runPathHint}/artifacts/`);
  return lines.join("\n");
}
