/**
 * Dynamic model discovery and role-based routing.
 *
 * No model name is ever hard-coded as a routing mechanism. Roles declare what
 * they need (reasoning, context, tool use, cheapness, speed) and models are
 * scored against the catalog discovered at runtime. If the catalog changes,
 * routing changes with it; nothing here needs editing.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { client, type RawModel } from "./opencode.js";
import type { Role } from "./roles.js";

export interface ModelInfo {
  ref: string; // "provider/id"
  providerID: string;
  id: string;
  name: string;
  family: string;
  context: number;
  output: number;
  tools: boolean;
  reasoning: boolean;
  costIn: number;
  costOut: number;
  free: boolean;
}

const CATALOG_CACHE = join(homedir(), ".cache", "opencode", "models.json");

/**
 * The server's /api/model is authoritative for *availability* but omits some
 * metadata (reasoning support, family). models.dev's on-disk catalog fills
 * those in. Missing cache is not an error — we just route with less detail.
 */
function enrich(m: RawModel): ModelInfo {
  let family = m.family ?? "";
  let reasoning = m.capabilities?.reasoning ?? false;
  let context = m.limit?.context ?? 0;
  let output = m.limit?.output ?? 0;
  let costIn = m.cost?.[0]?.input ?? 0;
  let costOut = m.cost?.[0]?.output ?? 0;

  if (existsSync(CATALOG_CACHE)) {
    try {
      const cat = JSON.parse(readFileSync(CATALOG_CACHE, "utf8"));
      const entry = cat?.[m.providerID]?.models?.[m.id];
      if (entry) {
        family ||= entry.family ?? "";
        reasoning = entry.reasoning ?? entry.capabilities?.reasoning ?? reasoning;
        context ||= entry.limit?.context ?? 0;
        output ||= entry.limit?.output ?? 0;
        costIn = entry.cost?.input ?? costIn;
        costOut = entry.cost?.output ?? costOut;
      }
    } catch {
      /* corrupt cache is not fatal */
    }
  }

  // Family is used only for reviewer/builder diversity. Fall back to a stable
  // stem of the id so distinct models never collapse into one "family".
  if (!family) family = m.id.replace(/-(free|preview|latest|beta)\b.*$/, "").replace(/[.\d]+$/, "");

  return {
    ref: `${m.providerID}/${m.id}`,
    providerID: m.providerID,
    id: m.id,
    name: m.name ?? m.id,
    family,
    context,
    output,
    tools: m.capabilities?.tools ?? false,
    reasoning,
    costIn,
    costOut,
    free: (costIn ?? 0) === 0 && (costOut ?? 0) === 0,
  };
}

/**
 * A freshly started server answers /doc before its provider catalog has
 * loaded, so an immediate query can return an empty list that looks
 * identical to "no credentials". Retry briefly before believing zero.
 */
export async function discoverModels(base: string, attempts = 6): Promise<ModelInfo[]> {
  let raw = await client.models(base);
  for (let i = 1; i < attempts && raw.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 500 * i));
    raw = await client.models(base);
  }
  return raw.map(enrich);
}

/** What a role wants. Weights are relative; only ordering matters. */
export interface RoleProfile {
  needsTools: boolean;
  needsWrite: boolean;
  wReasoning: number;
  wContext: number;
  wOutput: number;
  wCheap: number;
  wSpeed: number;
}

export const PROFILES: Record<Role, RoleProfile> = {
  //                     tools  write  reason ctx   out   cheap speed
  scout:     { needsTools: true,  needsWrite: false, wReasoning: 0.5, wContext: 1.0, wOutput: 0.2, wCheap: 3.0, wSpeed: 2.5 },
  architect: { needsTools: true,  needsWrite: false, wReasoning: 3.0, wContext: 3.0, wOutput: 1.0, wCheap: 0.8, wSpeed: 0.3 },
  builder:   { needsTools: true,  needsWrite: true,  wReasoning: 2.0, wContext: 2.0, wOutput: 2.5, wCheap: 0.8, wSpeed: 0.5 },
  debugger:  { needsTools: true,  needsWrite: true,  wReasoning: 3.0, wContext: 2.0, wOutput: 1.5, wCheap: 0.5, wSpeed: 0.3 },
  tester:    { needsTools: true,  needsWrite: true,  wReasoning: 1.5, wContext: 1.5, wOutput: 1.5, wCheap: 1.5, wSpeed: 1.0 },
  reviewer:  { needsTools: true,  needsWrite: false, wReasoning: 3.0, wContext: 2.5, wOutput: 1.0, wCheap: 0.8, wSpeed: 0.3 },
};

/**
 * Speed proxy. Real latency data is not in any catalog, so we use output-token
 * ceiling as a weak inverse proxy plus a name hint. This only ever breaks ties
 * between otherwise-equal models — it is never the primary signal.
 */
const FAST_HINT = /\b(lightning|flash|mini|fast|turbo|lite|small|haiku|instant)\b/i;
function speedScore(m: ModelInfo): number {
  return (FAST_HINT.test(m.name) || FAST_HINT.test(m.id) ? 1 : 0.4) * (m.output > 0 && m.output < 64_000 ? 1 : 0.7);
}

function norm(v: number, max: number): number {
  return max > 0 ? Math.min(1, v / max) : 0;
}

export function scoreModel(m: ModelInfo, p: RoleProfile, all: ModelInfo[]): number {
  if (p.needsTools && !m.tools) return -Infinity;
  const maxCtx = Math.max(...all.map((x) => x.context), 1);
  const maxOut = Math.max(...all.map((x) => x.output), 1);
  const maxCost = Math.max(...all.map((x) => x.costIn + x.costOut), 0);
  const cheap = maxCost > 0 ? 1 - (m.costIn + m.costOut) / maxCost : 1;
  return (
    p.wReasoning * (m.reasoning ? 1 : 0) +
    p.wContext * norm(m.context, maxCtx) +
    p.wOutput * norm(m.output, maxOut) +
    p.wCheap * cheap +
    p.wSpeed * speedScore(m)
  );
}

export interface Routing {
  model: ModelInfo;
  fallbacks: ModelInfo[];
  reason: string;
}

/**
 * Pick a model for a role.
 * `avoidFamily` implements reviewer/builder decorrelation: a reviewer from the
 * same family as the builder tends to repeat the builder's blind spots.
 * `exclude` carries models that already failed this run.
 */
export function routeRole(
  role: Role,
  models: ModelInfo[],
  opts: { avoidFamily?: string; exclude?: string[]; override?: string } = {},
): Routing {
  const exclude = new Set(opts.exclude ?? []);
  const pool = models.filter((m) => !exclude.has(m.ref));
  if (pool.length === 0) {
    throw new Error(
      models.length === 0
        ? "No OpenCode models available. Run `opencode auth login` (or check network) and retry."
        : `Every available model has already failed this run: ${models.map((m) => m.ref).join(", ")}`,
    );
  }

  if (opts.override) {
    const hit = pool.find((m) => m.ref === opts.override || m.id === opts.override);
    if (hit) return { model: hit, fallbacks: pool.filter((m) => m !== hit), reason: "explicit override" };
  }

  const p = PROFILES[role];
  const ranked = pool
    .map((m) => ({ m, s: scoreModel(m, p, models) }))
    .filter((x) => x.s > -Infinity)
    .sort((a, b) => b.s - a.s);

  if (ranked.length === 0) {
    throw new Error(`No available model supports tool calling, which role "${role}" requires.`);
  }

  let chosen = ranked[0];
  let reason = `best ${role} score`;
  if (opts.avoidFamily) {
    const diverse = ranked.find((x) => x.m.family !== opts.avoidFamily);
    // Only take the diverse pick if it is genuinely competitive (within 20%).
    if (diverse && diverse !== chosen && diverse.s >= chosen.s * 0.8) {
      chosen = diverse;
      reason = `best ${role} score from a family other than "${opts.avoidFamily}" (decorrelated review)`;
    }
  }

  return {
    model: chosen.m,
    fallbacks: ranked.filter((x) => x !== chosen).map((x) => x.m),
    reason,
  };
}

/** Full role -> model table, with reviewer decorrelated from builder. */
export function routeAll(models: ModelInfo[], overrides: Partial<Record<Role, string>> = {}) {
  const roles: Role[] = ["scout", "architect", "builder", "debugger", "tester", "reviewer"];
  const table: Partial<Record<Role, Routing>> = {};
  for (const r of roles) {
    const avoidFamily = r === "reviewer" ? table.builder?.model.family : undefined;
    table[r] = routeRole(r, models, { avoidFamily, override: overrides[r] });
  }
  return table as Record<Role, Routing>;
}
