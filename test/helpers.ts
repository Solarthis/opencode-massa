import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ModelInfo } from "../src/models.js";
import type { RunState } from "../src/state.js";

export function tempRepo(git = true): string {
  const d = mkdtempSync(join(tmpdir(), "massa-test-"));
  if (git) {
    spawnSync("git", ["init", "-q"], { cwd: d });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: d });
    spawnSync("git", ["config", "user.name", "t"], { cwd: d });
    spawnSync("sh", ["-lc", "echo base > base.txt"], { cwd: d });
    spawnSync("git", ["add", "-A"], { cwd: d });
    spawnSync("git", ["commit", "-qm", "init"], { cwd: d });
  }
  return d;
}

export function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    ref: "p/m",
    providerID: "p",
    id: "m",
    name: "M",
    family: "m",
    context: 100_000,
    output: 32_000,
    tools: true,
    reasoning: true,
    costIn: 1,
    costOut: 2,
    free: false,
    ...over,
  };
}

export function runState(dir: string, over: Partial<RunState> = {}): RunState {
  return {
    runId: "test-run",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    projectDir: dir,
    route: "normal",
    status: "planning",
    objective: "test objective",
    constraints: [],
    criteria: [],
    plan: [],
    workers: [],
    verifications: [],
    reviews: [],
    iteration: 0,
    maxIterations: 4,
    preexisting: [],
    notes: [],
    ...over,
  };
}

/**
 * Minimal stand-in for the OpenCode HTTP server. `script` decides how each
 * prompt behaves so tests can simulate failures, bad output, or real edits.
 */
export interface FakeOpts {
  /** Called per prompt. Return the assistant message, or throw to 500. */
  onPrompt?: (sessionID: string, body: any, n: number) => any;
  /** Sessions that should fail to create. */
  failCreate?: boolean;
}

export interface Fake {
  url: string;
  close: () => Promise<void>;
  created: Array<{ id: string; body: any; directory: string }>;
  prompts: Array<{ sessionID: string; body: any; directory: string }>;
  aborted: string[];
}

export async function fakeOpencode(opts: FakeOpts = {}): Promise<Fake> {
  const created: Fake["created"] = [];
  const prompts: Fake["prompts"] = [];
  const aborted: string[] = [];
  let n = 0;
  let seq = 0;

  const srv: Server = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    const directory = u.searchParams.get("directory") ?? "";
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const body = raw ? JSON.parse(raw) : {};

      if (u.pathname === "/doc") return json(200, { ok: true });
      if (u.pathname === "/api/model") return json(200, { data: fakeCatalog });

      if (u.pathname === "/session" && req.method === "POST") {
        if (opts.failCreate) return json(500, { error: "cannot create session" });
        const id = `ses_test${++seq}`;
        created.push({ id, body, directory });
        return json(200, { id, title: body.title });
      }
      const m = u.pathname.match(/^\/session\/([^/]+)\/(message|abort)$/);
      if (m && req.method === "POST") {
        if (m[2] === "abort") {
          aborted.push(m[1]);
          return json(200, {});
        }
        prompts.push({ sessionID: m[1], body, directory });
        try {
          return json(200, opts.onPrompt ? opts.onPrompt(m[1], { ...body, directory }, ++n) : okMessage("done"));
        } catch (e) {
          return json(500, { error: String(e) });
        }
      }
      if (u.pathname === "/vcs/status") return json(200, []);
      return json(404, { error: u.pathname });
    });
  });

  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => srv.close(() => r())),
    created,
    prompts,
    aborted,
  };
}

export const fakeCatalog = [
  {
    id: "fast-lightning-free",
    providerID: "fk",
    name: "Fast Lightning Free",
    family: "lightning",
    limit: { context: 200_000, output: 32_000 },
    capabilities: { tools: true, reasoning: false },
    cost: [{ input: 0, output: 0 }],
  },
  {
    id: "deep-thinker",
    providerID: "fk",
    name: "Deep Thinker",
    family: "thinker",
    limit: { context: 1_000_000, output: 128_000 },
    capabilities: { tools: true, reasoning: true },
    cost: [{ input: 5, output: 25 }],
  },
  {
    id: "other-family-pro",
    providerID: "fk",
    name: "Other Family Pro",
    family: "otherfam",
    limit: { context: 900_000, output: 120_000 },
    capabilities: { tools: true, reasoning: true },
    cost: [{ input: 4, output: 20 }],
  },
  {
    id: "no-tools",
    providerID: "fk",
    name: "No Tools",
    family: "notools",
    limit: { context: 500_000, output: 60_000 },
    capabilities: { tools: false, reasoning: true },
    cost: [{ input: 0, output: 0 }],
  },
];

export function okMessage(text: string, extra: any[] = []) {
  return {
    info: { role: "assistant", error: null, tokens: { total: 100 } },
    parts: [{ type: "step-start" }, ...extra, { type: "text", text }, { type: "step-finish" }],
  };
}

export function structuredMessage(obj: unknown, valid = true) {
  return {
    info: { role: "assistant", error: null, tokens: { total: 100 } },
    parts: [
      { type: "tool", tool: "StructuredOutput", state: { status: "completed", input: obj, metadata: { valid } } },
    ],
  };
}

export function errorMessage(msg: string) {
  return { info: { role: "assistant", error: { message: msg }, tokens: { total: 0 } }, parts: [] };
}
