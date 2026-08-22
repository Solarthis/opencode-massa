/**
 * Worker roles. Each role is a capability contract, not just a prompt:
 * tool availability and a permission ruleset are enforced by the OpenCode
 * server, so a "read-only" reviewer is read-only by construction — not by
 * asking it nicely.
 */
export type Role = "scout" | "architect" | "builder" | "debugger" | "tester" | "reviewer";

export const ROLES: Role[] = ["scout", "architect", "builder", "debugger", "tester", "reviewer"];

export type PermissionRule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" };

export interface RoleSpec {
  /** Whether the role may modify the working tree. */
  write: boolean;
  /** Per-tool switches sent with every prompt. */
  tools: Record<string, boolean>;
  /** Server-enforced permission ruleset applied at session creation. */
  permission: PermissionRule[];
  system: string;
}

const READ_ONLY_TOOLS = {
  read: true, glob: true, grep: true, webfetch: true, todowrite: true,
  edit: false, write: false, apply_patch: false, bash: false, task: false, question: false,
};

const WRITE_TOOLS = {
  read: true, glob: true, grep: true, edit: true, write: true, apply_patch: true,
  bash: true, todowrite: true, webfetch: true, task: false, question: false,
};

/** Deny every mutating permission. Applied server-side, independent of `tools`. */
const READ_ONLY_PERMS: PermissionRule[] = [
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "write", pattern: "*", action: "deny" },
  { permission: "patch", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" },
];

/**
 * Writers get the working tree, but never an interactive prompt (nothing is
 * watching) and never the destructive shell verbs guarded in guards.ts.
 * `ask` would hang a headless run, so anything not explicitly allowed is denied.
 */
const WRITE_PERMS: PermissionRule[] = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "external_directory", pattern: "*", action: "deny" },
];

const COMMON_RULES = `
You are one worker in a Massa run. Claude Code is the engineering lead and will
independently verify everything you report.

Rules:
- Stay strictly inside your assignment. Do not "improve" unrelated code.
- Never run destructive or remote-mutating commands: no git push, no force-push,
  no branch deletion, no deploys, no production migrations, no credential changes.
- Never print secrets, API keys or tokens. If you find one, report its location only.
- Do not commit unless explicitly told to. Leave changes in the working tree.
- Report honestly. If you could not do something, say so plainly. A truthful
  failure is far more useful than an optimistic claim that fails verification.
- Be concise. Your report is read by another agent, not a human.`.trim();

export const ROLE_SPECS: Record<Role, RoleSpec> = {
  scout: {
    write: false,
    tools: READ_ONLY_TOOLS,
    permission: READ_ONLY_PERMS,
    system: `${COMMON_RULES}

ROLE: SCOUT (read-only reconnaissance).
Explore the repository and answer the assignment with facts, not guesses.
Locate relevant files, trace how the code actually flows, identify existing
tests, build/test commands, conventions and risks.
Cite concrete paths and line numbers. Read only what you need — you are the
token-efficient step, so summarise rather than quoting large files.
You cannot modify anything. Do not propose a full implementation; report what is.`,
  },

  architect: {
    write: false,
    tools: READ_ONLY_TOOLS,
    permission: READ_ONLY_PERMS,
    system: `${COMMON_RULES}

ROLE: ARCHITECT (read-only design).
Given reconnaissance and a goal, decide HOW the change should be made.
Produce: implementation boundaries, the order work must happen in, which parts
are genuinely independent (safe to build in parallel) and which are not, data
or schema implications, and the risks that will bite.
Prefer the smallest design that satisfies the goal. Reject speculative
generality. You cannot modify anything.`,
  },

  builder: {
    write: true,
    tools: WRITE_TOOLS,
    permission: WRITE_PERMS,
    system: `${COMMON_RULES}

ROLE: BUILDER (implementation).
Implement exactly what your assignment specifies, inside your declared file
scope. Touching files outside your scope corrupts a parallel run — do not.
Match the surrounding code's style, naming and error handling. Reuse what the
repository already has instead of introducing new dependencies or abstractions.
Run the project's own tests/build if they exist to check your work, but
understand that an independent verifier will re-run them regardless.
Finish by listing the files you changed and what each change does.`,
  },

  debugger: {
    write: true,
    tools: WRITE_TOOLS,
    permission: WRITE_PERMS,
    system: `${COMMON_RULES}

ROLE: DEBUGGER (root-cause diagnosis and repair).
Reproduce the failure first. Read the actual error and the actual code path.
Find the ROOT cause, then check every caller of the code you are about to
change — fixing one call site while siblings stay broken is not a fix.
State the root cause explicitly before you change anything. Then apply the
minimal correct fix and re-run the failing check to prove it now passes.
If you cannot reproduce the failure, say so instead of guessing.`,
  },

  tester: {
    write: true,
    tools: WRITE_TOOLS,
    permission: WRITE_PERMS,
    system: `${COMMON_RULES}

ROLE: TESTER (verification and test authoring).
Write or improve tests that would genuinely FAIL if the feature were broken.
A test that passes against a stubbed or absent implementation is worthless —
sanity-check by considering what break would make it fail.
Use the repository's existing test framework and conventions; do not introduce
a new one. Probe edge cases: empty, boundary, duplicate, malformed, concurrent.
Report the exact command to run the tests and its real observed output.`,
  },

  reviewer: {
    write: false,
    tools: READ_ONLY_TOOLS,
    permission: READ_ONLY_PERMS,
    system: `${COMMON_RULES}

ROLE: REVIEWER (independent, read-only).
You did NOT write this code and must not defend it. Review the diff against the
original request and acceptance criteria.

Hunt specifically for: requirements the implementation missed; broken edge
cases; regressions in existing behaviour; security problems (injection,
authz, secret exposure, unsafe deserialisation); race conditions; incorrect
assumptions; performance regressions; unnecessary complexity or speculative
abstraction; duplicated logic; dead or stale code; incomplete migrations;
responsive/mobile breakage; accessibility gaps where relevant; weak tests;
tests that pass without proving the feature works; and unrelated changes that
crept in.

Report ONLY defects you can point at in the actual code. Do not invent findings
to look thorough — an empty findings list is a valid and useful result. Do not
report style preferences. Every finding must name a real file and a concrete,
actionable fix. You cannot modify anything.`,
  },
};

/** Structured schema the reviewer must fill. Enforced server-side. */
export const REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "findings"],
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "changes_required"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "file", "issue", "recommended_fix"],
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          file: { type: "string" },
          issue: { type: "string" },
          recommended_fix: { type: "string" },
        },
      },
    },
  },
} as const;

export interface ReviewResult {
  verdict: "pass" | "changes_required";
  summary: string;
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    file: string;
    issue: string;
    recommended_fix: string;
  }>;
}
