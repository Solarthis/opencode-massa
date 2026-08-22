/**
 * Safety boundaries. Two jobs:
 *  1. Refuse to hand a worker an assignment that asks for a destructive or
 *     outward-facing operation without explicit human authorisation.
 *  2. Keep secrets out of prompts, logs and reports.
 *
 * These are backstops, not the only defence — role permissions already deny
 * mutating tools to read-only roles.
 */

export interface GuardHit {
  rule: string;
  match: string;
  why: string;
}

/**
 * Operations that are irreversible, outward-facing, or destroy data.
 * A hit blocks autonomous execution and demands explicit authorisation.
 */
const DESTRUCTIVE: Array<{ rule: string; re: RegExp; why: string }> = [
  { rule: "git-push",        re: /\bgit\s+push\b/i,                                    why: "publishes to a remote" },
  { rule: "git-force-push",  re: /\bgit\s+push\b[^\n]*(--force|-f\b)/i,                why: "force-push can destroy remote history" },
  { rule: "git-delete-remote", re: /\bgit\s+push\b[^\n]*(--delete|:\s*\w)/i,           why: "deletes a remote branch" },
  { rule: "git-hard-reset",  re: /\bgit\s+reset\s+--hard\b/i,                          why: "discards uncommitted work" },
  { rule: "git-clean",       re: /\bgit\s+clean\b[^\n]*-[a-z]*[fdx]/i,                 why: "deletes untracked files" },
  { rule: "deploy",          re: /\b(deploy|publish|release)\b[^\n]{0,40}\b(prod|production|live)\b/i, why: "production deployment" },
  { rule: "deploy-cli",      re: /\b(vercel|netlify|fly|heroku|wrangler)\s+deploy\b|\bnpm\s+publish\b|\bkubectl\s+apply\b|\bterraform\s+(apply|destroy)\b/i, why: "deploys or publishes a release" },
  { rule: "db-destroy",      re: /\b(drop\s+(database|table|schema)|truncate\s+table)\b/i, why: "destroys database data" },
  { rule: "db-prod-migrate", re: /\bmigrat\w*\b[^\n]{0,40}\b(prod|production)\b/i,     why: "production migration" },
  { rule: "rm-rf-root",      re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/i,     why: "recursive delete of a root path" },
  { rule: "credential-rotate", re: /\b(rotate|revoke|regenerate)\b[^\n]{0,30}\b(credential|secret|api[- ]?key|token|password)s?\b/i, why: "credential rotation" },
  { rule: "billing",         re: /\b(billing|invoice|subscription|payment method|charge the card)\b/i, why: "billing modification" },
  { rule: "chmod-777",       re: /\bchmod\s+(-R\s+)?777\b/i,                           why: "removes access controls" },
  { rule: "curl-pipe-sh",    re: /\bcurl\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i,           why: "executes remote code unreviewed" },
  { rule: "sudo",            re: /\bsudo\s+\S/i,                                       why: "privileged system modification" },
];

export function scanDestructive(text: string): GuardHit[] {
  const hits: GuardHit[] = [];
  for (const d of DESTRUCTIVE) {
    const m = text.match(d.re);
    if (m) hits.push({ rule: d.rule, match: m[0].slice(0, 120), why: d.why });
  }
  return hits;
}

/**
 * Secret-shaped strings. Ordered most-specific first so a GitHub token is
 * reported as such rather than as a generic long string.
 */
const SECRET_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { rule: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { rule: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { rule: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "private-key-block", re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },
  { rule: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g },
  // Assignment form: FOO_SECRET=<value>. Keeps the name, drops the value.
  { rule: "env-assignment", re: /\b([A-Z][A-Z0-9_]{2,}(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL))\s*[=:]\s*["']?([^\s"'`,;]{8,})/g },
];

/** Replace secret-shaped values with a labelled placeholder. */
export function redact(text: string): { text: string; found: string[] } {
  let out = text;
  const found: string[] = [];
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, (full, name?: string) => {
      found.push(p.rule);
      // Preserve the variable name so the report stays intelligible.
      return name ? `${name}=«redacted:${p.rule}»` : `«redacted:${p.rule}»`;
    });
  }
  return { text: out, found: [...new Set(found)] };
}

export class GuardError extends Error {
  constructor(public hits: GuardHit[]) {
    super(
      "Blocked by Massa safety guard — this requires explicit authorisation from the user:\n" +
        hits.map((h) => `  • [${h.rule}] ${h.why} — matched: ${h.match}`).join("\n") +
        "\nAsk the user to confirm before proceeding. Do not rephrase the request to evade this check.",
    );
    this.name = "GuardError";
  }
}

/** Throws unless the caller has passed an explicit authorisation flag. */
export function assertSafe(text: string, authorized = false): GuardHit[] {
  const hits = scanDestructive(text);
  if (hits.length && !authorized) throw new GuardError(hits);
  return hits;
}
