/**
 * Drives the real MCP server over stdio, exactly as Claude Code does.
 *
 * Verifies the interface layer: environment discovery, run creation, delegation
 * to a real OpenCode worker, independent verification, resumption, and that
 * finalize refuses to certify unfinished work.
 *
 * Run with: npm run mcp-e2e
 */
import { spawn, type ChildProcessWithoutNullStreams, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp.js");

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private pending = new Map<number, (v: any) => void>();
  private id = 0;

  constructor() {
    this.child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (d) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          }
        } catch { /* not a complete JSON line */ }
      }
    });
    this.child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  }

  private send(method: string, params?: unknown, timeoutMs = 20 * 60_000): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async init() {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "massa-e2e", version: "1" },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  async call(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const r = await this.send("tools/call", { name, arguments: args });
    if (r.error) return { text: JSON.stringify(r.error), isError: true };
    return {
      text: (r.result?.content ?? []).map((c: any) => c.text).join("\n"),
      isError: !!r.result?.isError,
    };
  }

  close() { this.child.kill(); }
}

function disposableRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "massa-mcp-"));
  const sh = (c: string) => spawnSync("sh", ["-lc", c], { cwd: d, encoding: "utf8" });
  sh("git init -q && git config user.email e2e@test && git config user.name E2E");
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "e2e", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(d, "greet.js"), "export function greet(name) {\n  return 'Hi ' + name;\n}\n");
  writeFileSync(
    join(d, "greet.test.js"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { greet } from "./greet.js";',
      'test("greet uses the required format", () => {',
      '  assert.equal(greet("Ada"), "Hello, Ada!");',
      "});",
      "",
    ].join("\n"),
  );
  sh("git add -A && git commit -qm init");
  writeFileSync(join(d, "USER_WIP.md"), "user's unsaved work\n");
  return d;
}

async function main() {
  let failures = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
    if (!cond) failures++;
  };

  const dir = disposableRepo();
  console.log(`Disposable repo: ${dir}\n`);
  const c = new McpClient();
  await c.init();

  try {
    console.log("=== massa_env ===");
    const env = await c.call("massa_env", { project_dir: dir });
    console.log(env.text.split("\n").slice(0, 6).map((l) => "  " + l).join("\n"));
    check("env reports OpenCode and a model catalog", /OpenCode \d/.test(env.text) && /Available models \(\d+\)/.test(env.text));
    check("env reports the role routing table", /scout\s+->/.test(env.text) && /reviewer\s+->/.test(env.text));
    check("env discovered the project's real test command", /npm run test/.test(env.text), "");
    check("env flagged the pre-existing uncommitted file", /USER_WIP\.md/.test(env.text));

    console.log("\n=== massa_plan ===");
    const plan = await c.call("massa_plan", {
      project_dir: dir,
      objective: "greet(name) must return `Hello, <name>!` so that npm test passes.",
      route: "tiny",
      constraints: ["Do not modify greet.test.js."],
      criteria: [{ id: "tests", text: "npm test exits 0", check: "npm test" }],
      plan: [{ id: "fix", role: "builder", description: "Correct greet() output format", scope: ["greet.js"] }],
    });
    const runId = plan.text.match(/Massa run (\S+)/)?.[1] ?? "";
    check("plan created a run", !!runId, runId);
    check("massa state is gitignored", existsSync(join(dir, ".gitignore")) && /\.massa\//.test(readFileSync(join(dir, ".gitignore"), "utf8")));

    console.log("\n=== massa_verify (baseline must fail) ===");
    const base = await c.call("massa_verify", { project_dir: dir, run_id: runId, commands: ["npm test"] });
    check("baseline verification fails", /FAIL\s+npm test/.test(base.text));
    check("failing verification is reported as a completion blocker", /Completion blocked by/.test(base.text));

    console.log("\n=== massa_status finalize must refuse ===");
    const refuse = await c.call("massa_status", { project_dir: dir, run_id: runId, action: "finalize" });
    check("finalize refuses while checks fail", refuse.isError, refuse.text.split("\n")[0]);

    console.log("\n=== massa_run (real OpenCode builder) ===");
    const run = await c.call("massa_run", {
      project_dir: dir,
      run_id: runId,
      tasks: [{
        id: "fix",
        role: "builder",
        prompt: [
          "greet.test.js expects greet('Ada') to return exactly \"Hello, Ada!\".",
          "greet.js currently returns 'Hi Ada'. Edit greet.js so it returns `Hello, ${name}!`.",
          "Do NOT modify greet.test.js. Then run `npm test` and report the real exit code.",
        ].join("\n"),
        scope: ["greet.js"],
        timeout_ms: 600000,
      }],
    });
    console.log(run.text.split("\n").slice(0, 10).map((l) => "  " + l).join("\n"));
    check("worker ran and reported evidence", /## fix \(builder\)/.test(run.text));
    check("worker was not credited with the user's file", !/files changed[^\n]*USER_WIP/.test(run.text));

    console.log("\n=== massa_verify (independent) ===");
    const verify = await c.call("massa_verify", { project_dir: dir, run_id: runId, commands: ["npm test"] });
    const passed = /PASS\s+npm test/.test(verify.text);
    console.log("  " + verify.text.split("\n").slice(0, 4).join("\n  "));
    check("verification result is independent and explicit", /PASS\s+npm test|FAIL\s+npm test/.test(verify.text));

    console.log("\n=== massa_status resume ===");
    const resumed = await c.call("massa_plan", { project_dir: dir, resume: true });
    check("resume reconstructs the run", resumed.text.includes(runId));
    check("resume lists workers and their models", /fix \(builder\)/.test(resumed.text));

    const diff = await c.call("massa_status", { project_dir: dir, run_id: runId, action: "diff" });
    check("diff reports greet.js", /greet\.js/.test(diff.text));

    console.log("\n=== finalize gating ===");
    const fin = await c.call("massa_status", { project_dir: dir, run_id: runId, action: "finalize" });
    if (passed) {
      check("finalize succeeds once everything passes", !fin.isError, fin.text.split("\n")[0]);
      check("final report states not-committed/pushed/deployed", /Pushed: no/.test(fin.text) && /Deployed: no/.test(fin.text));
    } else {
      check("finalize still refuses because checks fail", fin.isError, fin.text.split("\n")[0]);
    }

    console.log("\n=== safety guard ===");
    const guard = await c.call("massa_run", {
      project_dir: dir,
      run_id: runId,
      tasks: [{ id: "danger", role: "builder", prompt: "Run `git push --force origin main` to publish this." }],
    });
    check("destructive delegation is blocked", guard.isError && /safety guard/i.test(guard.text));
    check("guard tells Claude not to evade it", /Do not rephrase/i.test(guard.text));

    const guardCmd = await c.call("massa_verify", { project_dir: dir, run_id: runId, commands: ["git push --force"] });
    check("destructive verification command is refused", /safety guard/i.test(guardCmd.text));

    check("the user's uncommitted file is untouched", readFileSync(join(dir, "USER_WIP.md"), "utf8") === "user's unsaved work\n");

    console.log(`\n${"=".repeat(60)}`);
    console.log(failures === 0 ? "MCP E2E PASSED (0 failures)" : `MCP E2E FAILED (${failures} failure(s))`);
    console.log(`Repo: ${dir}`);
  } finally {
    c.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("MCP E2E ERROR:", e?.stack ?? e);
  process.exit(1);
});
