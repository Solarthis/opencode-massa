/**
 * Real end-to-end smoke test against the locally installed OpenCode.
 *
 * Uses a disposable git repository, so the destructive part of the test cannot
 * touch anything the user cares about. Exercises the whole path:
 *   discover models -> route roles -> builder writes a file -> independent
 *   verification -> read-only reviewer produces structured findings ->
 *   completion gating.
 *
 * Run with: npm run smoke
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ensureServer } from "../src/opencode.js";
import { discoverModels, routeAll } from "../src/models.js";
import { runBatch, runTask } from "../src/run.js";
import { REVIEW_SCHEMA, type ReviewResult } from "../src/roles.js";
import { completionBlockers, createRun, load, newRunId, save, statusBoard } from "../src/state.js";
import { runAll } from "../src/verify.js";
import { diffStat } from "../src/worktree.js";

const log = (s: string) => console.log(s);
const step = (n: number, s: string) => log(`\n=== ${n}. ${s} ===`);

function disposableRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "massa-smoke-"));
  const sh = (c: string) => spawnSync("sh", ["-lc", c], { cwd: d, encoding: "utf8" });
  sh("git init -q && git config user.email smoke@test && git config user.name Smoke");
  writeFileSync(
    join(d, "package.json"),
    JSON.stringify({ name: "smoke", type: "module", scripts: { test: "node --test" } }, null, 2),
  );
  // A deliberately broken function plus a test that proves the bug.
  writeFileSync(join(d, "math.js"), "export function add(a, b) {\n  return a - b; // BUG: subtracts\n}\n");
  writeFileSync(
    join(d, "math.test.js"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add } from "./math.js";',
      "",
      'test("add sums its arguments", () => {',
      "  assert.equal(add(2, 3), 5);",
      "  assert.equal(add(-1, 1), 0);",
      "});",
      "",
    ].join("\n"),
  );
  sh("git add -A && git commit -qm 'initial with failing test'");
  // Pre-existing uncommitted work that must survive the run untouched.
  writeFileSync(join(d, "USER_WIP.txt"), "the user's unsaved work - must not be destroyed\n");
  return d;
}

async function main() {
  let failures = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
    if (!cond) failures++;
  };

  step(1, "OpenCode backend");
  const srv = await ensureServer();
  log(`  OpenCode ${srv.version} at ${srv.url} (${srv.managed ? "started/reused by massa" : "pre-existing"})`);

  step(2, "Dynamic model discovery");
  const models = await discoverModels(srv.url);
  for (const m of models) {
    log(`  ${m.ref}  ctx=${m.context} out=${m.output} tools=${m.tools} reasoning=${m.reasoning} ${m.free ? "free" : `$${m.costIn}/$${m.costOut}`}`);
  }
  check("at least one model is available", models.length > 0);
  if (models.length === 0) {
    log("\nCannot continue: OpenCode reports no available models. Run `opencode auth login`.");
    process.exit(1);
  }

  step(3, "Role routing from the live catalog");
  const table = routeAll(models);
  for (const [role, r] of Object.entries(table)) log(`  ${role.padEnd(10)} -> ${r.model.ref}  (${r.reason})`);
  check("every role routed to a tool-capable model", Object.values(table).every((r) => r.model.tools));

  step(4, "Disposable test repository");
  const dir = disposableRepo();
  log(`  ${dir}`);
  const baseline = await runAll(["npm test"], dir);
  check("baseline test fails (the bug is real)", !baseline[0].passed, `exit ${baseline[0].exitCode}`);

  const state = createRun({
    runId: newRunId(),
    projectDir: dir,
    route: "normal",
    status: "planning",
    objective: "Fix the add() function in math.js so that it returns the sum of its arguments and the existing test suite passes.",
    constraints: ["Do not modify math.test.js.", "Do not add dependencies."],
    criteria: [{ id: "tests-pass", text: "npm test exits 0", check: "npm test", status: "pending" }],
    plan: [{ id: "fix", role: "builder", description: "Correct add() in math.js", dependsOn: [], scope: ["math.js"], done: false }],
    workers: [],
    verifications: [],
    reviews: [],
    iteration: 0,
    maxIterations: 3,
    preexisting: ["USER_WIP.txt"],
    notes: [],
  });

  step(5, "Read-only scout (parallel, cannot write)");
  const before = readFileSync(join(dir, "math.js"), "utf8");
  const scouts = await runBatch(state, srv.url, models, [
    { id: "scout-code", role: "scout", prompt: "Read math.js and math.test.js. State in two sentences what add() does now and what the test expects. Do not propose a fix.", timeoutMs: 5 * 60_000 },
    { id: "scout-cmds", role: "scout", prompt: "Read package.json. State the exact command that runs this project's tests. One line.", timeoutMs: 5 * 60_000 },
  ]);
  for (const r of scouts.results) log(`  ${r.id}: ${r.ok ? "ok" : "FAILED " + r.error} [${r.model}] ${Math.round(r.durationMs / 1000)}s\n    ${r.report.replace(/\n/g, "\n    ").slice(0, 400)}`);
  check("scouts ran in parallel", scouts.parallel);
  check("scouts succeeded", scouts.results.every((r) => r.ok));
  check("scouts modified nothing", readFileSync(join(dir, "math.js"), "utf8") === before);

  step(6, "Builder implements the fix");
  const build = await runTask(state, srv.url, models, {
    id: "fix",
    role: "builder",
    prompt: [
      "The function add() in math.js is wrong: it subtracts instead of adding.",
      "Fix math.js so add(a, b) returns the sum.",
      "Do NOT modify math.test.js. Do not touch any other file.",
      "Then run `npm test` and report the real result.",
    ].join("\n"),
    scope: ["math.js"],
    timeoutMs: 10 * 60_000,
  });
  log(`  [${build.model}] ${Math.round(build.durationMs / 1000)}s  files: ${build.filesChanged.join(", ") || "none"}`);
  log(`  tools used: ${build.toolsUsed.join(", ") || "none"}`);
  check("builder succeeded", build.ok, build.error ?? "");
  check("builder changed math.js", build.filesChanged.includes("math.js"));
  check("builder did not touch the test file", !build.filesChanged.includes("math.test.js"));

  step(7, "Independent verification (not the builder's claim)");
  state.verifications = await runAll(["npm test"], dir);
  let v = state.verifications[state.verifications.length - 1];
  log(`  npm test -> exit ${v.exitCode} (${Math.round(v.durationMs / 1000)}s)`);
  check(
    "verification is independent of the worker's claim",
    build.ok === v.passed || !build.ok,
    `builder said ok=${build.ok}, tests say passed=${v.passed}`,
  );

  // Correction loop. Free models are variable: a builder sometimes narrates a
  // fix it never applied. That is exactly what the loop exists for, so the
  // smoke test drives it rather than pretending the first attempt always works.
  for (let attempt = 1; attempt <= 2 && !v.passed; attempt++) {
    log(`\n  --- correction cycle ${attempt}: verification failed, dispatching a debugger ---`);
    const fix = await runTask(state, srv.url, models, {
      id: `debug-${attempt}`,
      role: "debugger",
      prompt: [
        "`npm test` is failing in this repository.",
        "The function add() in math.js must return the SUM of its two arguments; right now it subtracts.",
        "Read math.js, apply the fix with the edit tool, then run `npm test` and report the real exit code.",
        "Do NOT modify math.test.js.",
        "",
        "Current failure output:",
        v.tail.slice(0, 1500),
      ].join("\n"),
      scope: ["math.js"],
      timeoutMs: 10 * 60_000,
    });
    log(`  [${fix.model}] ${Math.round(fix.durationMs / 1000)}s files: ${fix.filesChanged.join(", ") || "none"} tools: ${fix.toolsUsed.join(", ") || "none"}`);
    if (fix.error) log(`  error: ${fix.error}`);
    const again = await runAll(["npm test"], dir);
    state.verifications.push(...again);
    v = again[again.length - 1];
    log(`  npm test -> exit ${v.exitCode}`);
  }

  if (!v.passed) log(`  ${v.tail.split("\n").slice(0, 12).join("\n  ")}`);
  state.criteria[0].status = v.passed ? "pass" : "fail";
  state.plan[0].done = v.passed;
  save(state);
  check("tests pass after the correction loop", v.passed);

  step(8, "Pre-existing user work preserved");
  check("USER_WIP.txt still exists", existsSync(join(dir, "USER_WIP.txt")));
  check(
    "USER_WIP.txt content unchanged",
    readFileSync(join(dir, "USER_WIP.txt"), "utf8") === "the user's unsaved work - must not be destroyed\n",
  );

  step(9, "Read-only reviewer with structured output");
  const d = diffStat(dir);
  const review = await runTask(state, srv.url, models, {
    id: "review-1",
    role: "reviewer",
    prompt: [
      `ORIGINAL REQUEST: ${state.objective}`,
      `CONSTRAINTS:\n${state.constraints.map((c) => "- " + c).join("\n")}`,
      `VERIFICATION: npm test exit ${v.exitCode}`,
      `FILES CHANGED: ${d.files.join(", ")}`,
      "DIFF:\n```diff\n" + spawnSync("git", ["diff", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout + "\n```",
      "Review this change and report real defects only. An empty findings list is valid.",
    ].join("\n\n"),
    schema: REVIEW_SCHEMA,
    timeoutMs: 10 * 60_000,
  });
  check("reviewer succeeded", review.ok, review.error ?? "");
  check("reviewer returned schema-valid structured output", !!review.structured);
  if (review.structured) {
    const rr = review.structured as ReviewResult;
    log(`  [${review.model}] verdict=${rr.verdict}, ${rr.findings.length} finding(s)`);
    for (const f of rr.findings) log(`    [${f.severity}] ${f.file}: ${f.issue}`);
    state.reviews.push({ ...rr, at: Date.now(), iteration: 1 });
    save(state);
  }
  check(
    "reviewer used a different model family from the builder where possible",
    models.filter((m) => m.tools).length < 2 || review.model !== build.model,
    `builder=${build.model} reviewer=${review.model}`,
  );

  step(10, "Parallel write isolation via git worktrees");
  const isolated = await runBatch(state, srv.url, models, [
    { id: "wt-a", role: "builder", prompt: "Create a new file alpha.js containing exactly: export const alpha = 1;\nDo not touch any other file.", scope: ["alpha.js"], isolate: true, timeoutMs: 8 * 60_000 },
    { id: "wt-b", role: "builder", prompt: "Create a new file beta.js containing exactly: export const beta = 2;\nDo not touch any other file.", scope: ["beta.js"], isolate: true, timeoutMs: 8 * 60_000 },
  ]);
  for (const r of isolated.results) log(`  ${r.id}: ${r.ok ? "ok" : "FAILED " + r.error} [${r.model}] isolated=${r.isolatedIn ?? "no"} merge=${r.mergeResult ?? "-"}`);
  check("isolated builders ran in parallel", isolated.parallel);
  check("alpha.js merged into the real repo", existsSync(join(dir, "alpha.js")));
  check("beta.js merged into the real repo", existsSync(join(dir, "beta.js")));
  const wtList = spawnSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).stdout.trim().split("\n");
  check("temporary worktrees cleaned up", wtList.length === 1, wtList.join(" | "));
  const finalVerify = await runAll(["npm test"], dir);
  check("the fix survived the worktree merges", finalVerify[0].passed, `exit ${finalVerify[0].exitCode}`);

  step(11, "Completion gating is honest");
  const reloaded = load(dir, state.runId);
  check("run state survived a reload", reloaded.workers.length === state.workers.length);
  check("session ids persisted", reloaded.workers.every((w) => w.sessionID.startsWith("ses")));

  const blockers = completionBlockers(reloaded);
  log(`  blockers now: ${blockers.length ? blockers.join("; ") : "none"}`);

  // Force a failure and confirm completion is refused.
  reloaded.criteria[0].status = "fail";
  reloaded.verifications.push({ command: "npm test", exitCode: 1, passed: false, tail: "forced", durationMs: 1, at: Date.now() });
  const forced = completionBlockers(reloaded);
  check("a failing check blocks completion", forced.some((b) => /failing verification|not passing/.test(b)), forced.join("; "));

  step(12, "Status board");
  log(statusBoard(state).split("\n").map((l) => "  " + l).join("\n"));

  log(`\n${"=".repeat(60)}`);
  log(failures === 0 ? `SMOKE TEST PASSED (0 failures)` : `SMOKE TEST FAILED (${failures} failure(s))`);
  log(`Disposable repo left for inspection: ${dir}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nSMOKE TEST ERROR:", e?.stack ?? e);
  process.exit(1);
});
