import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { discoverModels } from "../src/models.js";
import { runBatch, runTask } from "../src/run.js";
import { REVIEW_SCHEMA } from "../src/roles.js";
import {
  completionBlockers,
  createRun,
  latestRun,
  listRuns,
  load,
  newRunId,
  save,
  statusBoard,
} from "../src/state.js";
import { discoverCommands, execCommand, runAll } from "../src/verify.js";
import { changedBetween, diffStat, fileFingerprints, preexistingChanges } from "../src/worktree.js";
import {
  errorMessage,
  fakeOpencode,
  okMessage,
  runState,
  structuredMessage,
  tempRepo,
} from "./helpers.js";

const mkRun = (dir: string, over = {}) =>
  createRun({ ...runState(dir, over), runId: newRunId() } as any);

// --- session handling ------------------------------------------------------

test("a worker creates a session pinned to the routed model and role permissions", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode();
  try {
    const state = mkRun(dir);
    const models = await discoverModels(f.url);
    const r = await runTask(state, f.url, models, { id: "s1", role: "scout", prompt: "explore" });

    assert.equal(r.ok, true);
    assert.equal(f.created.length, 1);
    const created = f.created[0];
    assert.equal(created.body.model.providerID, "fk");
    // Scout must be created with a deny-everything-mutating ruleset.
    const denies = created.body.permission.filter((p: any) => p.action === "deny").map((p: any) => p.permission);
    for (const p of ["edit", "write", "patch", "bash"]) assert.ok(denies.includes(p), `scout session allows ${p}`);
    // And the prompt must disable the mutating tools.
    assert.equal(f.prompts[0].body.tools.edit, false);
    assert.equal(f.prompts[0].body.tools.write, false);
  } finally {
    await f.close();
  }
});

test("a builder session permits writes", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    await runTask(mkRun(dir), f.url, models, { id: "b1", role: "builder", prompt: "build" });
    assert.equal(f.prompts[0].body.tools.edit, true);
    assert.equal(f.prompts[0].body.tools.write, true);
  } finally {
    await f.close();
  }
});

test("session ids are persisted and resumable across a reload", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode();
  try {
    const state = mkRun(dir);
    const models = await discoverModels(f.url);
    const r = await runTask(state, f.url, models, { id: "s1", role: "scout", prompt: "x" });

    const reloaded = load(dir, state.runId);
    assert.equal(reloaded.workers.length, 1);
    assert.equal(reloaded.workers[0].sessionID, r.sessionID);
    assert.equal(reloaded.workers[0].status, "ok");
    assert.equal(latestRun(dir)!.runId, state.runId);
  } finally {
    await f.close();
  }
});

test("an existing session is continued rather than recreated", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    const state = mkRun(dir);
    await runTask(state, f.url, models, { id: "b1", role: "builder", prompt: "first" });
    const sid = f.created[0].id;
    await runTask(state, f.url, models, { id: "b2", role: "builder", prompt: "correction", sessionID: sid });

    assert.equal(f.created.length, 1, "a second session was created instead of continuing");
    assert.equal(f.prompts.length, 2);
    assert.equal(f.prompts[1].sessionID, sid);
  } finally {
    await f.close();
  }
});

// --- failure recovery ------------------------------------------------------

test("a model error falls back to another model automatically", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode({
    onPrompt: (_s, b, n) => {
      if (n === 1) return errorMessage("model overloaded");
      writeFileSync(join(b.directory, "recovered.ts"), "export const ok = true;\n");
      return okMessage("recovered");
    },
  });
  try {
    const models = await discoverModels(f.url);
    const r = await runTask(mkRun(dir), f.url, models, { id: "b1", role: "builder", prompt: "x" });
    assert.equal(r.ok, true);
    assert.match(r.report, /recovered/);
    assert.equal(f.created.length, 2, "did not create a session on a second model");
    assert.notEqual(f.created[0].body.model.id, f.created[1].body.model.id);
  } finally {
    await f.close();
  }
});

test("when every model fails the worker is marked failed, not silently skipped", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode({ onPrompt: () => { throw new Error("always down"); } });
  try {
    const state = mkRun(dir);
    const r = await runTask(state, f.url, models_(await discoverModels(f.url)), { id: "b1", role: "builder", prompt: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /all attempted models failed/);
    assert.equal(load(dir, state.runId).workers[0].status, "failed");
  } finally {
    await f.close();
  }
});
const models_ = <T>(m: T) => m;

test("an unreachable server surfaces the real blocker", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode();
  const url = f.url;
  const models = await discoverModels(url);
  await f.close(); // server goes away
  const r = await runTask(mkRun(dir), url, models, { id: "b1", role: "builder", prompt: "x", timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.length > 0);
});

test("a timeout is reported as a failure rather than a completion", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode({
    onPrompt: () => {
      const end = Date.now() + 3000;
      while (Date.now() < end) { /* block past the client timeout */ }
      return okMessage("late");
    },
  });
  try {
    const models = await discoverModels(f.url);
    const r = await runTask(mkRun(dir), f.url, models, { id: "b1", role: "builder", prompt: "x", timeoutMs: 400 });
    assert.equal(r.ok, false);
  } finally {
    await f.close();
  }
});

test("a batch failure does not take down the sibling workers", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode({
    onPrompt: (_s, b) => {
      if (String(b.parts[0].text).includes("BOOM")) throw new Error("worker exploded");
      return okMessage("fine");
    },
  });
  try {
    const models = await discoverModels(f.url);
    const o = await runBatch(mkRun(dir), f.url, models, [
      { id: "a", role: "scout", prompt: "ok" },
      { id: "b", role: "scout", prompt: "BOOM" },
    ]);
    assert.equal(o.results.find((r) => r.id === "a")!.ok, true);
    assert.equal(o.results.find((r) => r.id === "b")!.ok, false);
  } finally {
    await f.close();
  }
});

// --- parallel execution ----------------------------------------------------

test("read-only workers run concurrently", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    const o = await runBatch(mkRun(dir), f.url, models, [
      { id: "s1", role: "scout", prompt: "a" },
      { id: "s2", role: "scout", prompt: "b" },
      { id: "s3", role: "architect", prompt: "c" },
    ]);
    assert.equal(o.parallel, true);
    assert.equal(o.results.filter((r) => r.ok).length, 3);
  } finally {
    await f.close();
  }
});

test("writers with overlapping scopes are serialized by the batch runner", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    const o = await runBatch(mkRun(dir), f.url, models, [
      { id: "b1", role: "builder", prompt: "a", scope: ["src/api/**"] },
      { id: "b2", role: "builder", prompt: "b", scope: ["src/api/users.ts"] },
    ]);
    assert.equal(o.parallel, false);
    assert.match(o.reason, /overlapping write scopes/);
  } finally {
    await f.close();
  }
});

test("writers with disjoint scopes run in parallel", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    const o = await runBatch(mkRun(dir), f.url, models, [
      { id: "b1", role: "builder", prompt: "a", scope: ["src/api/**"] },
      { id: "b2", role: "builder", prompt: "b", scope: ["src/web/**"] },
    ]);
    assert.equal(o.parallel, true);
    assert.match(o.reason, /disjoint/);
  } finally {
    await f.close();
  }
});

test("isolated writers get their own worktree and their work is merged back", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode({
    onPrompt: (_s, b) => {
      // Write inside whichever directory the worker was given.
      writeFileSync(join(b.directory, `${b.parts[0].text}.txt`), "generated\n");
      return okMessage("wrote a file");
    },
  });
  try {
    const models = await discoverModels(f.url);
    const state = mkRun(dir);
    const o = await runBatch(state, f.url, models, [
      { id: "b1", role: "builder", prompt: "alpha", isolate: true, scope: ["alpha.txt"] },
      { id: "b2", role: "builder", prompt: "beta", isolate: true, scope: ["beta.txt"] },
    ]);

    assert.equal(o.results.every((r) => r.ok), true, JSON.stringify(o.results.map((r) => r.error)));
    // Both isolated results must have landed in the real repo.
    assert.ok(existsSync(join(dir, "alpha.txt")), "alpha.txt was not merged back");
    assert.ok(existsSync(join(dir, "beta.txt")), "beta.txt was not merged back");
    // And the temporary worktrees must be gone.
    assert.ok(!existsSync(join(dir, ".massa", "worktrees")) ||
      spawnSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).stdout.trim().split("\n").length === 1);
  } finally {
    await f.close();
  }
});

// --- verification ----------------------------------------------------------

test("verification commands are discovered from real manifests only", () => {
  const dir = tempRepo();
  assert.deepEqual(discoverCommands(dir), [], "invented commands for an empty repo");

  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }));
  const cmds = discoverCommands(dir).map((c) => c.command);
  assert.ok(cmds.includes("npm run test"));
  assert.ok(cmds.includes("npm run build"));
  assert.ok(!cmds.includes("npm run lint"), "invented a lint script that does not exist");
});

test("a failing command is recorded as a failure with its output", async () => {
  const dir = tempRepo();
  const r = await execCommand("echo boom >&2; exit 3", dir);
  assert.equal(r.passed, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.stderr, /boom/);
});

test("verification refuses to run a destructive command", async () => {
  const dir = tempRepo();
  const r = await execCommand("git push --force origin main", dir);
  assert.equal(r.passed, false);
  assert.match(r.stderr, /safety guard/);
});

test("failing tests block completion", async () => {
  const dir = tempRepo();
  const state = mkRun(dir, {
    criteria: [{ id: "c1", text: "tests pass", check: "exit 1", status: "pending" }],
  });
  state.verifications = await runAll(["exit 1"], dir);
  for (const c of state.criteria) {
    const v = state.verifications.find((x) => x.command === c.check);
    if (v) c.status = v.passed ? "pass" : "fail";
  }
  save(state);

  const blockers = completionBlockers(state);
  assert.ok(blockers.some((b) => /not passing/.test(b)), blockers.join("|"));
  assert.ok(blockers.some((b) => /failing verification/.test(b)), blockers.join("|"));
});

test("passing everything clears the blockers", async () => {
  const dir = tempRepo();
  const state = mkRun(dir, {
    criteria: [{ id: "c1", text: "tests pass", check: "exit 0", status: "pending" }],
  });
  state.verifications = await runAll(["exit 0"], dir);
  state.criteria[0].status = "pass";
  state.reviews.push({ verdict: "pass", summary: "ok", findings: [], at: Date.now(), iteration: 1 });
  save(state);
  assert.deepEqual(completionBlockers(state), []);
});

test("no verification at all blocks completion", () => {
  const dir = tempRepo();
  const state = mkRun(dir, { criteria: [{ id: "c1", text: "works", status: "pending" }] });
  assert.ok(completionBlockers(state).some((b) => /no verification has been run/.test(b)));
});

test("a failed worker blocks completion even if checks pass", async () => {
  const dir = tempRepo();
  const state = mkRun(dir, {});
  state.verifications = await runAll(["exit 0"], dir);
  state.workers.push({
    id: "b1", role: "builder", model: "x/y", sessionID: "s", directory: dir,
    status: "failed", startedAt: Date.now(), endedAt: Date.now(), error: "died",
  });
  assert.ok(completionBlockers(state).some((b) => /worker/.test(b)));
});

// --- review loop -----------------------------------------------------------

test("reviewer output is validated against the schema and drives the loop", async () => {
  const dir = tempRepo();
  const findings = {
    verdict: "changes_required",
    summary: "missing validation",
    findings: [{ severity: "high", file: "src/a.ts", issue: "no input validation", recommended_fix: "validate before use" }],
  };
  const f = await fakeOpencode({ onPrompt: () => structuredMessage(findings) });
  try {
    const models = await discoverModels(f.url);
    const state = mkRun(dir);
    const r = await runTask(state, f.url, models, { id: "rev", role: "reviewer", prompt: "review", schema: REVIEW_SCHEMA });
    assert.equal(r.ok, true);
    assert.deepEqual(r.structured, findings);
    // The reviewer must have been asked for structured output.
    assert.equal(f.prompts[0].body.format.type, "json_schema");
  } finally {
    await f.close();
  }
});

test("review findings block completion until resolved", () => {
  const dir = tempRepo();
  const state = mkRun(dir, {
    criteria: [{ id: "c1", text: "x", status: "pass" }],
    verifications: [{ command: "exit 0", exitCode: 0, passed: true, tail: "", durationMs: 1, at: Date.now() }],
  });
  state.reviews.push({
    verdict: "changes_required", summary: "s",
    findings: [{ severity: "critical", file: "a.ts", issue: "i", recommended_fix: "f" }],
    at: Date.now(), iteration: 1,
  });
  assert.ok(completionBlockers(state).some((b) => /changes_required/.test(b)));

  // A follow-up passing review clears it.
  state.reviews.push({ verdict: "pass", summary: "fixed", findings: [], at: Date.now(), iteration: 2 });
  assert.deepEqual(completionBlockers(state), []);
});

test("invalid structured output is a failure, not an empty pass", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode({ onPrompt: () => okMessage("I reviewed it, looks fine!") });
  try {
    const models = await discoverModels(f.url);
    const r = await runTask(mkRun(dir), f.url, models, { id: "rev", role: "reviewer", prompt: "review", schema: REVIEW_SCHEMA });
    assert.equal(r.ok, false);
    assert.match(r.error!, /structured output/);
  } finally {
    await f.close();
  }
});

// --- state / audit route ---------------------------------------------------

test("pre-existing uncommitted work is recorded so it can be protected", () => {
  const dir = tempRepo();
  writeFileSync(join(dir, "user-wip.txt"), "important unsaved work\n");
  assert.deepEqual(preexistingChanges(dir), ["user-wip.txt"]);
  const state = mkRun(dir, { preexisting: preexistingChanges(dir) });
  assert.deepEqual(load(dir, state.runId).preexisting, ["user-wip.txt"]);
  assert.match(statusBoard(state), /Pre-existing uncommitted files \(protected/);
});

test("runs persist and the newest is found first (audit / continue route)", () => {
  const dir = tempRepo();
  const a = createRun({ ...runState(dir, { objective: "first" }), runId: "20260101-000000" } as any);
  const b = createRun({ ...runState(dir, { objective: "second" }), runId: "20260101-000001" } as any);
  b.createdAt = a.createdAt + 1000;
  save(b);
  assert.equal(listRuns(dir).length, 2);
  assert.equal(latestRun(dir)!.objective, "second");
});

test("massa state is kept out of the user's commits", () => {
  const dir = tempRepo();
  mkRun(dir);
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\.massa\/$/m);
});

test("the status board stays compact regardless of transcript size", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode({ onPrompt: () => okMessage("x".repeat(200_000)) });
  try {
    const models = await discoverModels(f.url);
    const state = mkRun(dir);
    const r = await runTask(state, f.url, models, { id: "s1", role: "scout", prompt: "x" });
    assert.ok(r.report.length < 10_000, `report leaked ${r.report.length} chars into context`);
    assert.ok(statusBoard(load(dir, state.runId)).length < 4_000);
  } finally {
    await f.close();
  }
});

test("diffStat reports both tracked and untracked changes", () => {
  const dir = tempRepo();
  writeFileSync(join(dir, "base.txt"), "changed\n");
  writeFileSync(join(dir, "new.txt"), "new\n");
  const d = diffStat(dir);
  assert.ok(d.files.includes("base.txt"));
  assert.ok(d.files.includes("new.txt"));
});

test("a worker is credited only with the files it actually changed", async () => {
  const dir = tempRepo();
  // The user has unrelated uncommitted work, and another file is already dirty.
  writeFileSync(join(dir, "USER_WIP.txt"), "do not blame the builder for this\n");
  writeFileSync(join(dir, "base.txt"), "pre-existing edit\n");

  const f = await fakeOpencode({
    onPrompt: (_s, b) => {
      writeFileSync(join(b.directory, "written-by-builder.ts"), "export const x = 1;\n");
      return okMessage("wrote one file");
    },
  });
  try {
    const models = await discoverModels(f.url);
    const r = await runTask(mkRun(dir), f.url, models, { id: "b1", role: "builder", prompt: "write a file" });
    assert.deepEqual(r.filesChanged, ["written-by-builder.ts"]);
    assert.ok(!r.filesChanged.includes("USER_WIP.txt"), "credited the builder with the user's work");
    assert.ok(!r.filesChanged.includes("base.txt"), "credited the builder with a pre-existing edit");
    assert.ok(!r.filesChanged.includes(".gitignore"), "credited the builder with massa's own .gitignore edit");
  } finally {
    await f.close();
  }
});

test("a writing worker that changes nothing is a failure, not a success", async () => {
  const dir = tempRepo();
  // The classic weak-model failure: it narrates a fix it never applied.
  const f = await fakeOpencode({ onPrompt: () => okMessage("All done! I fixed the bug. Everything looks great.") });
  try {
    const models = await discoverModels(f.url);
    const state = mkRun(dir, { plan: [{ id: "b1", role: "builder", description: "fix it", dependsOn: [], done: false }] });
    const r = await runTask(state, f.url, models, { id: "b1", role: "builder", prompt: "fix it" });
    assert.equal(r.ok, false, "a no-op builder was reported as success");
    assert.match(r.error!, /changed no files/);
    assert.deepEqual(r.filesChanged, []);
    assert.equal(load(dir, state.runId).workers[0].status, "failed");
  } finally {
    await f.close();
  }
});

test("a read-only worker that changes nothing is still a success", async () => {
  const dir = tempRepo();
  const f = await fakeOpencode({ onPrompt: () => okMessage("Here is what I found.") });
  try {
    const models = await discoverModels(f.url);
    const r = await runTask(mkRun(dir), f.url, models, { id: "s1", role: "scout", prompt: "look" });
    assert.equal(r.ok, true);
  } finally {
    await f.close();
  }
});

test("changedBetween detects modification of an already-dirty file", () => {
  const dir = tempRepo();
  writeFileSync(join(dir, "base.txt"), "first edit\n");
  const before = fileFingerprints(dir);
  writeFileSync(join(dir, "base.txt"), "first edit\nsecond edit\n");
  assert.deepEqual(changedBetween(before, fileFingerprints(dir)), ["base.txt"]);
});

test("changedBetween detects a rewritten untracked file", () => {
  const dir = tempRepo();
  writeFileSync(join(dir, "note.txt"), "a\n");
  const before = fileFingerprints(dir);
  writeFileSync(join(dir, "note.txt"), "b\n");
  assert.deepEqual(changedBetween(before, fileFingerprints(dir)), ["note.txt"]);
});
