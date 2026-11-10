import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCommands, execCommand } from "../src/verify.js";

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "massa-verifier-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("discovery rejects non-string and blank package scripts", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: [], build: true, lint: "  ", check: "echo ok" } }));
  assert.deepEqual(discoverCommands(dir).map(c => c.command), ["npm run check"]);
});
test("redaction happens before a tail cuts off a token prefix", async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "emit.cjs"), "process.stdout.write('ghp_' + 'Z'.repeat(40))");
  const r = await execCommand("node emit.cjs", dir, 2000, 25);
  assert.equal(r.passed, true);
  assert.ok(!r.stdout.includes("Z".repeat(20)), "secret suffix escaped redaction");
});
test("UTF-8 codepoints split across writes are preserved", async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "emit.cjs"), "const b=Buffer.from('🌼');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),70)");
  const r = await execCommand("node emit.cjs", dir, 2000);
  assert.equal(r.stdout, "🌼");
});
test("timeout terminates descendants that hold inherited pipes", async (t) => {
  const dir = fixture(t);
  const r = await execCommand("sleep 2 & wait", dir, 80);
  assert.equal(r.timedOut, true);
  assert.equal(r.passed, false);
  assert.ok(r.durationMs < 1500, `timeout took ${r.durationMs}ms`);
});
test("oversized output is omitted rather than returning a cut-off secret", async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "emit.cjs"), "process.stdout.write('X'.repeat(210000));setTimeout(()=>process.stdout.write('tail'),40)");
  const r = await execCommand("node emit.cjs", dir, 2000);
  assert.equal(r.passed, true);
  assert.match(r.stdout, /omitted.*limit/i);
  assert.ok(r.stdout.length < 200);
});
test("invalid timeout is rejected without running the command", async (t) => {
  const r = await execCommand("echo should-not-run", fixture(t), NaN);
  assert.equal(r.passed, false);
  assert.match(r.stderr, /invalid.*limit/i);
});
test("zero tail suppresses normal stdout and stderr", async (t) => {
  const r = await execCommand("echo hello; echo problem >&2", fixture(t), 2000, 0);
  assert.equal(r.passed, true);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});
test("stderr redacts before truncating and reports overflow", async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "emit.cjs"), "process.stderr.write('ghp_' + 'Z'.repeat(40))");
  const r = await execCommand("node emit.cjs", dir, 2000, 25);
  assert.ok(!r.stderr.includes("Z".repeat(20)));
  writeFileSync(join(dir, "emit.cjs"), "process.stderr.write('Y'.repeat(210000))");
  const large = await execCommand("node emit.cjs", dir, 2000);
  assert.match(large.stderr, /omitted.*limit/i);
});
test("spawn errors remain failures", async () => {
  const r = await execCommand("echo ok", "/nonexistent-massa-fixture", 2000);
  assert.equal(r.passed, false);
  assert.equal(r.exitCode, -1);
});
