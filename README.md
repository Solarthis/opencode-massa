# opencode-massa

Claude Code as engineering lead; [OpenCode](https://opencode.ai) agents as the workforce.

You type `/massa <task>` in Claude Code. Claude decides what needs doing, delegates the
token-heavy repository work to OpenCode workers, verifies the result itself, has it
independently reviewed, and only reports completion when the evidence supports it.

This is the OpenCode sibling of [codex-massa](https://github.com/Solarthis/codex-massa),
rebuilt around OpenCode's session API rather than ported from it.

---

## Why

Reading a repository into Claude's context is expensive. OpenCode workers can do that
reading, tracing and editing far more cheaply, against a catalog of free and low-cost
models. What Claude is uniquely good at — judging what the user actually wants, deciding
the topology, adjudicating a review, and refusing to declare victory — stays with Claude.

The design constraint throughout: **a worker's claim is never evidence.** Verification is
run by Massa, in the project directory, independently of whatever the worker reported.

---

## Architecture

```
  You
   |
   v
  Claude Code  --  /massa <task>
   |
   v
  Claude (engineering lead)
   |  route, criteria, delegation, adjudication
   v
  opencode-massa  (MCP server, 6 tools)
   |
   v
  opencode serve  (headless, 127.0.0.1, reused across runs)
   |
   +-- session (scout)      read-only, cheap+fast model
   +-- session (architect)  read-only, reasoning+context model
   +-- session (builder)    write, own git worktree or disjoint scope
   +-- session (builder)    write, own git worktree or disjoint scope
   +-- session (tester)     write
   +-- session (debugger)   write
   +-- session (reviewer)   read-only, different model family from builder
   |
   v
  Independent verification (real commands, real exit codes)
   |
   v
  Read-only review -> structured findings
   |
   v
  Correction loop (Claude adjudicates findings)
   |
   v
  Claude final assessment -> You
```

Roles are not just prompts. Each role's tool set **and** an OpenCode permission ruleset are
applied at session creation, so a reviewer is read-only by construction rather than by
request.

---

## Prerequisites

| | |
|---|---|
| OpenCode CLI | `npm i -g opencode-ai` (or `curl -fsSL https://opencode.ai/install \| bash`) |
| Node | >= 20 |
| git | required for diff review and worktree isolation |
| Claude Code | any recent version |

OpenCode's free `opencode/*` tier works with no credentials. Run `opencode auth login` to
add paid providers — Massa picks them up automatically, no config change needed.

## Installation

```bash
git clone <this-repo> ~/massa && cd ~/massa
npm install && npm run build
npm test          # 64 unit + integration tests (mocked OpenCode)
npm run smoke     # real end-to-end run against your OpenCode install
npm run mcp-e2e   # drives the MCP server over stdio, exactly as Claude Code does
```

Install the command and register the MCP server:

```bash
cp command/massa.md ~/.claude/commands/massa.md
```

Then add to `~/.claude.json` under `mcpServers`:

```json
"opencode-massa": {
  "type": "stdio",
  "command": "node",
  "args": ["/Users/you/massa/dist/src/mcp.js"]
}
```

Restart Claude Code. `/massa` and the `massa_*` tools should now be available.

---

## Usage

```
/massa fix the mobile reservations table
/massa build the reporting module described in PROJECT_GOAL.md
/massa find and fix why these tests are failing
/massa audit what the previous agent implemented
/massa continue
```

Plain `/massa <task>` is the normal interface. You never have to choose a model, a role, an
agent count or an iteration budget.

Optional modifiers: `--quick` (force the tiny route), `--deep` (force the complex route),
`--review` (review the current diff only), `--status`, `--stop`, `--models`.

---

## Execution routes

Claude picks one and tells you which.

| Route | For | Shape |
|---|---|---|
| **Tiny** | typo, one-line CSS, config value, single obvious bug | one builder → verify |
| **Normal** | ordinary bug, small feature, a few files | scout → builder → verify → review |
| **Complex** | new module, broad refactor, hard debugging, UI+backend+DB | scouts ‖ → architect → builders (isolated/disjoint) → tester → verify → review → fix loop |
| **Audit/Resume** | "continue", "what's left?", "audit this" | reconstruct state first, close only real gaps |

---

## Worker roles

| Role | Writes | Optimised for |
|---|---|---|
| `scout` | no | cheap, fast, adequate context — repository recon |
| `architect` | no | reasoning + large context — design and ordering |
| `builder` | yes | coding, tool use, large output budget |
| `debugger` | yes | reasoning + coding — root cause, not symptom |
| `tester` | yes | tests that would actually fail if the feature broke |
| `reviewer` | no | reasoning, **different model family from the builder** |

Read-only roles have `edit`, `write`, `apply_patch` and `bash` disabled at the tool layer
*and* denied in the session's permission ruleset. No role can spawn its own subagents
(`task` is off) or block a headless run on an interactive question.

---

## Model routing

**No model name is hard-coded as a routing mechanism.** At run time Massa reads OpenCode's
live catalog (`/api/model`, enriched from the models.dev cache) and scores every model
against the requesting role's profile:

```
score = w_reasoning * reasoning
      + w_context   * normalised(context)
      + w_output    * normalised(output limit)
      + w_cheap     * (1 - normalised(cost))
      + w_speed     * speed_proxy
```

Models without tool-calling are excluded from every role that needs tools. Weights per role
live in `PROFILES` in [`src/models.ts`](src/models.ts) — that is the only place routing
policy lives.

Preference order, per the design brief: **correctness > token efficiency > free/low-cost >
speed > context efficiency.** Exploration and repetitive work go to the cheapest adequate
model; difficult implementation, debugging, architecture and review get the strongest
appropriate one.

**Reviewer decorrelation.** The reviewer is routed to a different model *family* from the
builder whenever a competitive alternative exists (within 20% of the top score), so the
reviewer does not inherit the builder's blind spots. If only one capable model exists, it
is reused rather than picking a worse reviewer for the sake of difference.

**Fallback.** A failing model is excluded and the next-best is tried, up to three models per
task. When all are exhausted the worker fails loudly with the models attempted — Massa never
silently hands the work back to Claude.

Run `/massa --models` to see the current catalog and routing table.

---

## Parallel write safety

Two workers editing one working tree corrupts it. Massa allows exactly two safe shapes:

1. **Disjoint declared scopes** — writers whose `scope` globs provably do not intersect run
   concurrently in the shared tree.
2. **Isolation** — `isolate: true` gives each writer its own `git worktree` on a branch;
   work is merged back one at a time after each finishes. Merge conflicts are reported and
   aborted, never auto-resolved.

Anything else is **serialized**, and the reason is reported. A writer with no declared scope
is treated as owning everything. Correctness beats concurrency.

```
Builder A  owns  src/accounts/**  tests/accounts/**
Builder B  owns  src/reporting/** tests/reporting/**
                 -> disjoint, runs in parallel
```

---

## Verification

Massa never invents commands. It discovers them from real manifests — `package.json`
scripts, `pytest.ini`/`pyproject.toml`, `phpunit.xml`, `composer.json`, `go.mod`,
`Cargo.toml`, `Makefile`, `tsconfig.json` — and only offers ones that actually exist. If
nothing is discoverable it says so and refuses to certify rather than guessing.

Acceptance criteria carry a `check` (a command, exit 0 = pass). A criterion is decided by
its check and nothing else.

**A writing worker that changed no files is a failure**, not a success — that is the classic
weak-model behaviour of narrating a fix it never applied, and it must not mark a plan item
done.

`massa_status action:"finalize"` **refuses** while any completion blocker remains: failing
checks, unpassing criteria, a `changes_required` review, or a failed worker.

---

## State and resumption

```
<repo>/.massa/
  runs/<run-id>/
    state.json        goal, criteria, plan, workers, sessions, verifications, reviews
    events.jsonl      append-only audit log
    artifacts/        full worker transcripts and review JSON
    final-report.md
  worktrees/          transient isolation checkouts
```

`.massa/` is operational state, added to `.gitignore` automatically. OpenCode session IDs
are persisted, so `/massa continue` survives a Claude restart, a terminal restart, an
OpenCode restart, and a reboot.

Detail lives on disk; Claude receives compact summaries. Worker reports are truncated and
secret-redacted before they reach anyone's context.

---

## Safety boundaries

Massa may autonomously read files, edit project files, run tests and local builds, create
temporary branches and worktrees, and create fixtures.

It will **not** autonomously push, force-push, delete remote branches, deploy, publish a
release, run production migrations, destroy databases, rotate credentials, modify billing,
`chmod 777`, `curl | sh`, or `sudo`. These are detected in both task prompts and
verification commands and require explicit authorization from you.

Secret-shaped strings (AWS keys, GitHub/Slack tokens, `sk-`/`sk-ant-` keys, Google keys,
private key blocks, bearer tokens, `*_SECRET=` assignments) are redacted from every report
and log, with the variable name preserved so reports stay readable.

The OpenCode server is bound to `127.0.0.1` and is never exposed publicly.

Your uncommitted work is recorded before a run starts and is never reset, stashed or
overwritten.

---

## MCP tools

Six, deliberately — every schema costs Claude context on every turn.

| Tool | Purpose |
|---|---|
| `massa_env` | OpenCode health, live model catalog, role routing, git state, discovered commands |
| `massa_plan` | create a run with objective + criteria + plan, or resume/inspect prior runs |
| `massa_run` | delegate to one or more workers; handles routing, permissions, parallel safety |
| `massa_verify` | run the project's real checks independently; record against criteria |
| `massa_review` | read-only reviewer over the real diff, structured findings |
| `massa_status` | progress board, diff, stop, or the gated final report |

---

## Troubleshooting

**`/massa` not found** — confirm `~/.claude/commands/massa.md` exists and restart Claude Code.

**"No OpenCode models available"** — run `opencode models`. Empty means no provider is
reachable; `opencode auth login` adds one. The free `opencode/*` tier needs network access
to `opencode.ai`.

**"OpenCode CLI not found"** — `npm i -g opencode-ai`. If it is installed under a Node
version manager, make sure the MCP server entry's `PATH` env includes that bin directory.

**Server will not start** — check `~/.massa/server.log`, and that the port (default 4747,
override with `MASSA_OPENCODE_PORT`) is free. Point Massa at an existing server with
`MASSA_OPENCODE_URL`.

**Workers time out** — free models are slower and variable. Raise `timeout_ms` on the task,
or let the correction loop retry; a failing model is automatically swapped out.

**"Cannot review: not a git repository"** — run `git init` and commit a baseline. Diff
review and worktree isolation both need git.

**Merge conflict on an isolated builder** — the merge is aborted and the repo left clean.
The scopes overlapped; give the builders genuinely disjoint ownership or serialize them.

## Known limitations

- **Free models are variable.** A weak builder sometimes narrates a fix it never
  applied. Massa treats a writing worker that changed no files as a failure, and
  verification catches the rest — but expect the correction loop to run more often
  on the free tier than with a paid provider.
- **Speed is a proxy, not a measurement.** No catalog publishes latency, so the
  router infers speed from the output-token ceiling plus a name hint. It only ever
  breaks ties.
- **`toolsUsed` costs one extra local request.** OpenCode omits tool parts from the
  synchronous prompt response, so Massa reads the session message list afterwards.
- **Massa's own `.gitignore` edit appears in the reviewed diff** and reviewers
  occasionally flag it as scope creep. Hiding Massa's edits from the reviewer would
  be worse, so it is left visible.
- **Worktree isolation needs a clean-ish HEAD.** Branches are cut from `HEAD`, so an
  isolated builder does not see uncommitted changes in the main tree.
- **No cross-run scheduling.** Massa runs one plan at a time per repository; Claude
  drives the loop rather than a background daemon.

## Uninstall

```bash
rm ~/.claude/commands/massa.md                 # remove the command
# remove the "opencode-massa" entry from ~/.claude.json mcpServers
rm -rf ~/.massa                                # server portfile and logs
rm -rf ~/massa                                 # this repository
```

Per-project state lives in `<repo>/.massa/` and can be deleted at any time; it is
operational state only.

---

## Relationship to codex-massa

[codex-massa](https://github.com/Solarthis/codex-massa) is untouched and still works via
`/massa-codex`. The two share concepts — a machine-checkable goal, persisted run state,
independent verification, safety guards, quick-vs-build routing — but no code.

The genuinely generic parts (destructive-operation guards, secret redaction, verification
command discovery, completion gating) could eventually become a shared package. That is
noted rather than done: the duplication is small and a refactor of a working project to
avoid it would be a poor trade.
