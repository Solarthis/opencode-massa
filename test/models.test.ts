import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverModels, routeAll, routeRole, scoreModel, PROFILES } from "../src/models.js";
import { fakeOpencode, model } from "./helpers.js";

test("model discovery reads the live catalog", async () => {
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    assert.equal(models.length, 4);
    const fast = models.find((m) => m.id === "fast-lightning-free")!;
    assert.equal(fast.ref, "fk/fast-lightning-free");
    assert.equal(fast.free, true);
    assert.equal(fast.tools, true);
    assert.equal(fast.context, 200_000);
    assert.equal(models.find((m) => m.id === "deep-thinker")!.free, false);
  } finally {
    await f.close();
  }
});

test("zero models produces an actionable blocker, not a silent fallback", () => {
  assert.throws(() => routeRole("builder", []), /No OpenCode models available/);
});

test("models without tool calling are never routed to a role that needs tools", () => {
  const onlyNoTools = [model({ ref: "fk/no-tools", id: "no-tools", tools: false })];
  assert.throws(() => routeRole("builder", onlyNoTools), /tool calling/);
});

test("scout prefers cheap and fast; architect prefers reasoning and context", async () => {
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    assert.equal(routeRole("scout", models).model.id, "fast-lightning-free");
    const arch = routeRole("architect", models).model;
    assert.ok(arch.reasoning && arch.context >= 900_000, `architect got ${arch.ref}`);
  } finally {
    await f.close();
  }
});

test("routing is derived from metadata, not model names", () => {
  // Same catalog, names swapped: the routing must follow the capabilities.
  const a = model({ ref: "x/alpha", id: "alpha", name: "Alpha", family: "a", reasoning: true, context: 1_000_000, output: 128_000, costIn: 5, costOut: 25, free: false });
  const b = model({ ref: "x/beta", id: "beta", name: "Beta", family: "b", reasoning: false, context: 100_000, output: 16_000, costIn: 0, costOut: 0, free: true });
  assert.equal(routeRole("architect", [a, b]).model.id, "alpha");
  assert.equal(routeRole("scout", [a, b]).model.id, "beta");

  // Flip the capabilities between the same two names -> routing flips too.
  const a2 = { ...a, reasoning: false, context: 100_000, output: 16_000, costIn: 0, costOut: 0, free: true };
  const b2 = { ...b, reasoning: true, context: 1_000_000, output: 128_000, costIn: 5, costOut: 25, free: false };
  assert.equal(routeRole("architect", [a2, b2]).model.id, "beta");
  assert.equal(routeRole("scout", [a2, b2]).model.id, "alpha");
});

test("fallback: an excluded (previously failed) model is not selected again", async () => {
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    const first = routeRole("builder", models).model.ref;
    const second = routeRole("builder", models, { exclude: [first] }).model.ref;
    assert.notEqual(first, second);
  } finally {
    await f.close();
  }
});

test("fallback exhaustion reports a blocker rather than looping", async () => {
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    assert.throws(
      () => routeRole("builder", models, { exclude: models.map((m) => m.ref) }),
      /already failed this run/,
    );
  } finally {
    await f.close();
  }
});

test("explicit override wins when the model is available", async () => {
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    const r = routeRole("scout", models, { override: "fk/deep-thinker" });
    assert.equal(r.model.id, "deep-thinker");
    assert.match(r.reason, /override/);
  } finally {
    await f.close();
  }
});

test("an unavailable override falls back to routing instead of failing", async () => {
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    const r = routeRole("scout", models, { override: "nope/does-not-exist" });
    assert.ok(models.some((m) => m.ref === r.model.ref));
    assert.doesNotMatch(r.reason, /override/);
  } finally {
    await f.close();
  }
});

test("reviewer is decorrelated from the builder's model family when competitive", async () => {
  const f = await fakeOpencode();
  try {
    const models = await discoverModels(f.url);
    const table = routeAll(models);
    assert.notEqual(table.reviewer.model.family, table.builder.model.family, "reviewer shares the builder's family");
    assert.match(table.reviewer.reason, /decorrelated/);
  } finally {
    await f.close();
  }
});

test("decorrelation never picks an incapable reviewer just to be different", () => {
  // Only one tool-capable model exists: the reviewer must reuse it.
  const only = [model({ ref: "x/one", id: "one", family: "same" })];
  const r = routeRole("reviewer", only, { avoidFamily: "same" });
  assert.equal(r.model.id, "one");
});

test("every role resolves against a live catalog", async () => {
  const f = await fakeOpencode();
  try {
    const table = routeAll(await discoverModels(f.url));
    for (const role of ["scout", "architect", "builder", "debugger", "tester", "reviewer"] as const) {
      assert.ok(table[role].model.tools, `${role} routed to a non-tool model`);
    }
  } finally {
    await f.close();
  }
});

test("scoring rejects non-tool models outright", () => {
  const all = [model({ tools: false })];
  assert.equal(scoreModel(all[0], PROFILES.builder, all), -Infinity);
});
