/**
 * Parallel write safety.
 *
 * Two builders editing one working tree at the same time corrupts it. Massa
 * offers exactly two safe answers and refuses everything else:
 *   1. Disjoint declared scopes  -> run in the shared tree, in parallel.
 *   2. Overlapping scopes        -> either isolate in git worktrees, or serialize.
 * Correctness beats concurrency; when in doubt we serialize.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function git(cwd: string, args: string[], timeout = 60_000) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), code: r.status };
}

export function isGitRepo(dir: string): boolean {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]).stdout === "true";
}

/** Uncommitted work that existed *before* Massa ran. Never destroyed. */
export function preexistingChanges(dir: string): string[] {
  if (!isGitRepo(dir)) return [];
  const r = git(dir, ["status", "--porcelain"]);
  return r.stdout ? r.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean) : [];
}

/**
 * Glob -> RegExp for scope comparison. Supports the `**`, `*` and `?` forms
 * that appear in real scope declarations like `src/api/**`.
 */
export function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*/)*"; // "**/" - zero or more directory levels
          i += 2;
        } else if (i + 2 >= glob.length) {
          // Trailing "**" is the rest of the path. The preceding "/" is made
          // optional so "src/api/**" also matches the directory "src/api".
          re = re.endsWith("/") ? re.slice(0, -1) + "(?:/.*)?" : re + ".*";
          i += 1;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*"; // "*" - within one path segment
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Do two scope sets overlap? Exact when one side's literal paths are matched by
 * the other's patterns; conservative (assume overlap) when both sides are broad
 * patterns that could intersect. Erring toward "overlap" only costs concurrency.
 */
export function scopesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true; // undeclared scope = owns everything
  const aRe = a.map(globToRe);
  const bRe = b.map(globToRe);
  for (const pa of a) if (bRe.some((re) => re.test(pa))) return true;
  for (const pb of b) if (aRe.some((re) => re.test(pb))) return true;
  // Both sides broad: two wildcard patterns can still intersect even when
  // neither literally matches the other (e.g. "src/**/*.ts" vs "src/api/**").
  // Compare the fixed prefix before the first wildcard. Literal paths are
  // excluded here - they were already decided exactly above, and treating
  // "tests/a.ts" and "tests/b.ts" as overlapping would serialize needlessly.
  const wild = (g: string) => /[*?]/.test(g);
  const prefix = (g: string) => g.split(/[*?]/)[0].replace(/\/[^/]*$/, "/");
  for (const pa of a.filter(wild))
    for (const pb of b.filter(wild)) {
      const x = prefix(pa);
      const y = prefix(pb);
      if (x.startsWith(y) || y.startsWith(x)) return true;
    }
  return false;
}

export interface ScopePlan {
  parallel: boolean;
  reason: string;
  conflicts: Array<[string, string]>;
}

/** Decide whether a batch of writing tasks may run concurrently. */
export function planScopes(tasks: Array<{ id: string; write: boolean; scope?: string[] }>): ScopePlan {
  const writers = tasks.filter((t) => t.write);
  if (writers.length <= 1) return { parallel: true, reason: "at most one writer", conflicts: [] };

  const undeclared = writers.filter((t) => !t.scope || t.scope.length === 0);
  if (undeclared.length)
    return {
      parallel: false,
      reason:
        `writer(s) without a declared file scope: ${undeclared.map((t) => t.id).join(", ")} ` +
        `- cannot prove disjointness, serializing`,
      conflicts: [],
    };

  const conflicts: Array<[string, string]> = [];
  for (let i = 0; i < writers.length; i++)
    for (let j = i + 1; j < writers.length; j++)
      if (scopesOverlap(writers[i].scope!, writers[j].scope!)) conflicts.push([writers[i].id, writers[j].id]);

  return conflicts.length
    ? {
        parallel: false,
        reason: `overlapping write scopes: ${conflicts.map(([a, b]) => `${a} vs ${b}`).join(", ")} - serializing`,
        conflicts,
      }
    : { parallel: true, reason: "all write scopes are disjoint", conflicts: [] };
}

export interface Worktree {
  id: string;
  path: string;
  branch: string;
}

/** Isolate a writer in its own git worktree branched from HEAD. */
export function createWorktree(repo: string, runId: string, id: string): Worktree {
  if (!isGitRepo(repo)) throw new Error(`Cannot isolate: ${repo} is not a git repository.`);
  const branch = `massa/${runId}/${id}`;
  const path = join(repo, ".massa", "worktrees", `${runId}-${id}`);
  if (existsSync(path)) return { id, path, branch };
  const r = git(repo, ["worktree", "add", "-b", branch, path, "HEAD"], 120_000);
  if (!r.ok) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
  return { id, path, branch };
}

/**
 * Merge an isolated branch back. Commits the worktree's changes first (a
 * worktree branch with a dirty tree cannot be merged), then merges into the
 * repo's current branch. Conflicts are reported, never auto-resolved.
 */
export function mergeWorktree(repo: string, wt: Worktree): { ok: boolean; detail: string } {
  const status = git(wt.path, ["status", "--porcelain"]);
  if (status.stdout) {
    git(wt.path, ["add", "-A"]);
    const c = git(wt.path, [
      "-c", "user.email=massa@local",
      "-c", "user.name=Massa",
      "commit", "-m", `massa: ${wt.id}`,
    ]);
    if (!c.ok && !/nothing to commit/i.test(c.stdout + c.stderr))
      return { ok: false, detail: `commit in worktree failed: ${c.stderr || c.stdout}` };
  }
  const m = git(repo, ["merge", "--no-ff", "-m", `massa: merge ${wt.id}`, wt.branch], 120_000);
  if (!m.ok) {
    git(repo, ["merge", "--abort"]);
    return { ok: false, detail: `merge conflict on ${wt.branch} (aborted, repo left clean): ${m.stdout || m.stderr}` };
  }
  return { ok: true, detail: m.stdout || `merged ${wt.branch}` };
}

export function removeWorktree(repo: string, wt: Worktree) {
  git(repo, ["worktree", "remove", "--force", wt.path], 60_000);
  git(repo, ["branch", "-D", wt.branch]);
}

/**
 * Per-file fingerprint of the working tree relative to HEAD.
 *
 * Used to attribute changes to the worker that actually made them: comparing
 * two snapshots tells us what THIS worker touched, rather than reporting every
 * dirty file in the repo (which would wrongly credit a builder with the user's
 * pre-existing work, or with Massa's own .gitignore edit).
 */
export function fileFingerprints(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!isGitRepo(dir)) return out;
  for (const l of git(dir, ["diff", "HEAD", "--numstat"]).stdout.split("\n").filter(Boolean)) {
    const [add, del, file] = l.split("\t");
    if (file) out.set(file, `${add}/${del}`);
  }
  const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"]).stdout.split("\n").filter(Boolean);
  for (const f of untracked) {
    // Hash the content so a rewritten untracked file counts as a change.
    const h = git(dir, ["hash-object", f]).stdout || "untracked";
    out.set(f, `new:${h}`);
  }
  return out;
}

/** Files whose state differs between two fingerprint snapshots. */
export function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files].filter((f) => before.get(f) !== after.get(f)).sort();
}

/** Compact diffstat - what Claude sees instead of a full diff. */
export function diffStat(dir: string, base = "HEAD"): {
  files: string[];
  stat: string;
  insertions: number;
  deletions: number;
} {
  if (!isGitRepo(dir)) return { files: [], stat: "(not a git repository)", insertions: 0, deletions: 0 };
  const numstat = git(dir, ["diff", base, "--numstat"]).stdout;
  const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"]).stdout;
  const files = [
    ...numstat.split("\n").filter(Boolean).map((l) => l.split("\t")[2]),
    ...untracked.split("\n").filter(Boolean),
  ].filter(Boolean);
  let insertions = 0;
  let deletions = 0;
  for (const l of numstat.split("\n").filter(Boolean)) {
    const [a, d] = l.split("\t");
    insertions += Number(a) || 0;
    deletions += Number(d) || 0;
  }
  return { files, stat: git(dir, ["diff", base, "--stat"]).stdout, insertions, deletions };
}

/** Full textual diff, truncated. Untracked files are included as additions. */
export function fullDiff(dir: string, maxChars = 60_000): string {
  if (!isGitRepo(dir)) return "(not a git repository)";
  let out = git(dir, ["diff", "HEAD"], 60_000).stdout;
  const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"]).stdout.split("\n").filter(Boolean);
  for (const f of untracked) {
    const d = git(dir, ["diff", "--no-index", "/dev/null", f], 30_000);
    out += "\n" + (d.stdout || `(new file ${f})`);
  }
  return out.length > maxChars ? out.slice(0, maxChars) + `\n... [diff truncated at ${maxChars} chars]` : out;
}
