/**
 * OpenCode backend: locate the CLI, keep one healthy headless server per machine,
 * and expose the handful of HTTP endpoints Massa actually needs.
 *
 * We deliberately use the blocking `POST /session/{id}/message` call rather than
 * `prompt_async` + polling: it returns the complete assistant message (parts,
 * tokens, error) in one round trip, and parallelism is just concurrent requests.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const MASSA_HOME = join(homedir(), ".massa");
const PORTFILE = join(MASSA_HOME, "server.json");
const DEFAULT_PORT = 4747;

export interface ServerInfo {
  url: string;
  port: number;
  pid?: number;
  managed: boolean;
  version: string;
}

/** Extra dirs to look in when `opencode` is not on PATH (npm/bun/brew installs). */
const BIN_CANDIDATES = [
  join(homedir(), ".opencode", "bin", "opencode"),
  join(homedir(), ".local", "bin", "opencode"),
  join(homedir(), ".bun", "bin", "opencode"),
  "/opt/homebrew/bin/opencode",
  "/usr/local/bin/opencode",
];

let cachedBin: string | null = null;

export function findOpencode(): string {
  if (cachedBin) return cachedBin;
  const which = spawnSync("sh", ["-lc", "command -v opencode"], { encoding: "utf8" });
  const fromPath = which.stdout?.trim().split("\n").pop()?.trim();
  if (fromPath && existsSync(fromPath)) return (cachedBin = fromPath);
  for (const c of BIN_CANDIDATES) if (existsSync(c)) return (cachedBin = c);
  throw new Error(
    "OpenCode CLI not found. Install it with `npm i -g opencode-ai` " +
      "or `curl -fsSL https://opencode.ai/install | bash`, then retry.",
  );
}

export function opencodeVersion(): string {
  const r = spawnSync(findOpencode(), ["--version"], { encoding: "utf8", timeout: 20_000 });
  return (r.stdout || r.stderr || "unknown").trim();
}

async function health(url: string, ms = 1500): Promise<boolean> {
  try {
    const r = await fetch(`${url}/doc`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

function readPortfile(): { url: string; port: number; pid: number } | null {
  try {
    return JSON.parse(readFileSync(PORTFILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Attach to a healthy server if one exists, otherwise start one bound to
 * localhost. Never binds a public interface.
 */
export async function ensureServer(): Promise<ServerInfo> {
  const version = opencodeVersion();

  const envUrl = process.env.MASSA_OPENCODE_URL;
  if (envUrl) {
    if (await health(envUrl)) return { url: envUrl, port: Number(new URL(envUrl).port), managed: false, version };
    throw new Error(`MASSA_OPENCODE_URL=${envUrl} is set but that server is not responding.`);
  }

  const prior = readPortfile();
  if (prior && (await health(prior.url))) {
    return { ...prior, managed: true, version };
  }
  if (prior) {
    try { unlinkSync(PORTFILE); } catch { /* stale portfile, ignore */ }
  }

  const port = Number(process.env.MASSA_OPENCODE_PORT || DEFAULT_PORT);
  const url = `http://127.0.0.1:${port}`;
  if (await health(url)) return { url, port, managed: false, version };

  mkdirSync(MASSA_HOME, { recursive: true });
  const logPath = join(MASSA_HOME, "server.log");
  const child = spawn(findOpencode(), ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await health(url)) {
      const info = { url, port, pid: child.pid! };
      writeFileSync(PORTFILE, JSON.stringify(info, null, 2));
      return { ...info, managed: true, version };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`OpenCode server failed to become healthy on ${url} within 60s. See ${logPath}.`);
}

async function api<T>(base: string, path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`OpenCode ${init?.method ?? "GET"} ${path} -> ${r.status} ${await r.text()}`);
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

export interface RawModel {
  id: string;
  providerID: string;
  name: string;
  family?: string | null;
  limit?: { context?: number; output?: number };
  capabilities?: { tools?: boolean; reasoning?: boolean };
  cost?: Array<{ input?: number; output?: number }>;
}

export const client = {
  models: (base: string) =>
    api<{ data: RawModel[] }>(base, "/api/model").then((r) => r.data ?? []),

  agents: (base: string, dir: string) =>
    api<Array<{ name: string; mode: string }>>(base, `/agent?directory=${encodeURIComponent(dir)}`),

  createSession: (
    base: string,
    dir: string,
    body: {
      title: string;
      parentID?: string;
      model?: { providerID: string; id: string };
      permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>;
    },
  ) =>
    api<{ id: string; title: string }>(base, `/session?directory=${encodeURIComponent(dir)}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Blocking prompt. `timeoutMs` must cover the whole worker turn. */
  prompt: (
    base: string,
    dir: string,
    sessionID: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ) =>
    api<AssistantMessage>(
      base,
      `/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`,
      { method: "POST", body: JSON.stringify(body) },
      timeoutMs,
    ),

  abort: (base: string, dir: string, sessionID: string) =>
    api<unknown>(base, `/session/${sessionID}/abort?directory=${encodeURIComponent(dir)}`, {
      method: "POST",
      body: "{}",
    }).catch(() => undefined),

  /**
   * Full message list for a session. The blocking prompt response omits tool
   * parts, so this is the only reliable source for what a worker actually did.
   */
  messages: (base: string, dir: string, sessionID: string) =>
    api<Array<{ parts?: Array<{ type: string; tool?: string }> }>>(
      base,
      `/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`,
    ).catch(() => []),

  vcsStatus: (base: string, dir: string) =>
    api<Array<{ file: string; additions: number; deletions: number; status: string }>>(
      base,
      `/vcs/status?directory=${encodeURIComponent(dir)}`,
    ).catch(() => []),
};

export interface AssistantMessage {
  info?: {
    role?: string;
    error?: unknown;
    tokens?: { total?: number; input?: number; output?: number };
  };
  parts?: Array<{
    type: string;
    text?: string;
    tool?: string;
    state?: { status?: string; input?: unknown; metadata?: { valid?: boolean }; error?: string };
  }>;
}

/** Last plain-text part — what the worker actually reported. */
export function messageText(m: AssistantMessage): string {
  const texts = (m.parts ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text!.trim());
  return texts.length ? texts[texts.length - 1] : "";
}

/** Validated payload from a `format: json_schema` prompt, if the model produced one. */
export function structuredOutput<T>(m: AssistantMessage): T | null {
  const part = (m.parts ?? []).find((p) => p.tool === "StructuredOutput" && p.state?.status === "completed");
  if (!part || part.state?.metadata?.valid === false) return null;
  return (part.state?.input as T) ?? null;
}

/**
 * Tool names the worker actually invoked - evidence of what it did, not what
 * it claimed. Reads the session's message list because OpenCode does not
 * include tool parts in the synchronous prompt response.
 */
export async function toolsUsed(base: string, dir: string, sessionID: string): Promise<string[]> {
  const msgs = await client.messages(base, dir, sessionID);
  const names = msgs.flatMap((m) => (m.parts ?? []).filter((p) => p.type === "tool" && p.tool).map((p) => p.tool!));
  return [...new Set(names)];
}

export function tmpWorkspace(name: string): string {
  const d = join(tmpdir(), "massa", name);
  mkdirSync(d, { recursive: true });
  return d;
}
