/**
 * Independent verification.
 *
 * A worker saying "done" is a claim, not evidence. Massa re-runs the project's
 * own checks itself, in the project's own directory, and records exit codes.
 *
 * Commands are never invented: candidates are discovered from real manifests
 * and only offered if the script/target actually exists.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redact, scanDestructive } from "./guards.js";
import type { VerificationRun } from "./state.js";

export interface Candidate {
  command: string;
  kind: "test" | "build" | "lint" | "typecheck";
  source: string;
}

function pkgScripts(dir: string): Record<string, string> {
  const f = join(dir, "package.json");
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * Discover verification commands that demonstrably exist in this repository.
 * Returns [] rather than guessing when nothing is discoverable.
 */
export function discoverCommands(dir: string): Candidate[] {
  const out: Candidate[] = [];
  const add = (command: string, kind: Candidate["kind"], source: string) => out.push({ command, kind, source });

  // Node
  const scripts = pkgScripts(dir);
  const runner = existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))
    ? "bun run"
    : existsSync(join(dir, "pnpm-lock.yaml"))
      ? "pnpm run"
      : existsSync(join(dir, "yarn.lock"))
        ? "yarn"
        : "npm run";
  for (const [name, kind] of [
    ["test", "test"], ["typecheck", "typecheck"], ["type-check", "typecheck"],
    ["lint", "lint"], ["build", "build"], ["check", "lint"],
  ] as const) {
    if (scripts[name]) add(`${runner} ${name}`, kind, "package.json scripts");
  }

  // Python
  if (existsSync(join(dir, "pytest.ini")) || existsSync(join(dir, "tests")) || existsSync(join(dir, "pyproject.toml"))) {
    const py = join(dir, "pyproject.toml");
    const hasPytest = existsSync(py) && /pytest/.test(readFileSync(py, "utf8"));
    if (hasPytest || existsSync(join(dir, "pytest.ini"))) add("pytest -q", "test", "pytest config");
  }
  if (existsSync(join(dir, "manage.py"))) add("python manage.py test", "test", "django manage.py");

  // PHP
  if (existsSync(join(dir, "phpunit.xml")) || existsSync(join(dir, "phpunit.xml.dist"))) {
    const bin = existsSync(join(dir, "vendor/bin/phpunit")) ? "vendor/bin/phpunit" : "phpunit";
    add(bin, "test", "phpunit config");
  }
  if (existsSync(join(dir, "composer.json"))) {
    try {
      const c = JSON.parse(readFileSync(join(dir, "composer.json"), "utf8"));
      if (c.scripts?.test) add("composer test", "test", "composer scripts");
    } catch { /* malformed composer.json */ }
  }
  if (existsSync(join(dir, "selftest.php"))) add("php selftest.php", "test", "selftest.php");

  // Go / Rust / Make
  if (existsSync(join(dir, "go.mod"))) { add("go test ./...", "test", "go.mod"); add("go build ./...", "build", "go.mod"); }
  if (existsSync(join(dir, "Cargo.toml"))) { add("cargo test", "test", "Cargo.toml"); add("cargo build", "build", "Cargo.toml"); }
  if (existsSync(join(dir, "Makefile"))) {
    const mk = readFileSync(join(dir, "Makefile"), "utf8");
    if (/^test:/m.test(mk)) add("make test", "test", "Makefile");
    if (/^build:/m.test(mk)) add("make build", "build", "Makefile");
  }

  // tsc only when there is a tsconfig and no npm typecheck script already covering it
  if (existsSync(join(dir, "tsconfig.json")) && !out.some((c) => c.kind === "typecheck")) {
    add("npx tsc --noEmit", "typecheck", "tsconfig.json");
  }

  // De-duplicate, preserving discovery order.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.command) ? false : (seen.add(c.command), true)));
}

export interface ExecResult {
  command: string;
  exitCode: number;
  passed: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** Run one command in the project directory. Output is redacted and truncated. */
export function execCommand(command: string, cwd: string, timeoutMs = 600_000, tailChars = 4000): Promise<ExecResult> {
  const hits = scanDestructive(command);
  if (hits.length) {
    return Promise.resolve({
      command,
      exitCode: -1,
      passed: false,
      stdout: "",
      stderr: `Refused: verification command matched safety guard [${hits.map((h) => h.rule).join(", ")}]. Verification must not mutate anything outside the working tree.`,
      durationMs: 0,
      timedOut: false,
    });
  }

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("sh", ["-lc", command], { cwd, env: { ...process.env, CI: "1", NO_COLOR: "1" } });
    let out = "";
    let err = "";
    let timedOut = false;
    const cap = (s: string, chunk: string) => (s.length > 200_000 ? s : s + chunk);
    child.stdout.on("data", (d) => (out = cap(out, d.toString())));
    child.stderr.on("data", (d) => (err = cap(err, d.toString())));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = (s: string) => redact(s.length > tailChars ? "...\n" + s.slice(-tailChars) : s).text;
      resolve({
        command,
        exitCode: code ?? -1,
        passed: code === 0 && !timedOut,
        stdout: tail(out),
        stderr: tail(err),
        durationMs: Date.now() - started,
        timedOut,
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ command, exitCode: -1, passed: false, stdout: "", stderr: String(e), durationMs: Date.now() - started, timedOut });
    });
  });
}

export function toVerificationRun(r: ExecResult): VerificationRun {
  const tail = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  return {
    command: r.command,
    exitCode: r.exitCode,
    passed: r.passed,
    tail: r.timedOut ? `[TIMED OUT]\n${tail}` : tail,
    durationMs: r.durationMs,
    at: Date.now(),
  };
}

/** Run every command sequentially; a failure does not stop the rest. */
export async function runAll(commands: string[], cwd: string, timeoutMs?: number): Promise<VerificationRun[]> {
  const results: VerificationRun[] = [];
  for (const c of commands) results.push(toVerificationRun(await execCommand(c, cwd, timeoutMs)));
  return results;
}
