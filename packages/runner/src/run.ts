import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { type RunStatus, type VerifyState } from "./wire.js";
import { runVerify } from "@fleet/mcp-verify";
import { defaultArtifactsRoot, prepareRunArtifactsDir, REVIEW_ARTIFACTS } from "./artifacts.js";
import { killRetentionLog, retainKill } from "./kill-retention.js";
import { claudeEngine, mockEngine, type Engine, type EngineResult } from "./engine.js";
import { createUsageCollector, unavailableProducerUsage, writeModelUsageEvidence, type ProducerUsage, type UsageCollector } from "./model-usage.js";
import { decideGateInputs, gateInputNote, noGateInputs, type GateInputDecision } from "./gate-inputs.js";
import { findRepo, type FleetRepo } from "./fleet.js";
import { beginInflight, sweepInflight, type InflightHandle } from "./inflight.js";
import { appendLedger, defaultLedgerPath, fleetRecord, readLedger } from "./ledger.js";
import { defaultLedgerHtmlPath, writeLedgerHtml } from "./ledger-html.js";
import { buildPrBody, type VerifyCheck } from "./pr.js";
import { buildRunPreamble } from "@fleet/knowledge";
import { loadTask, type Task } from "./task.js";
import { constructVerificationTree, TreeConstructionError, type VerificationTree } from "./verification-tree.js";
import { eligibleVerifiers, type VerifierCheck } from "./verifiers.js";
import { git, injectAgentConfig, injectKnowledge, pathsInBase, prepareWorkspace, RUN_KNOWLEDGE_FILE, stagedDiff, stagedFiles, stagedPaths } from "./workspace.js";

interface VerifyResult {
  /** Tri-state: `inconclusive` means no verifier ran, which is not a pass.
   *  Orthogonal to RunStatus — an inconclusive run still ships as `approved`. */
  state: VerifyState;
  checks: VerifyCheck[];
  summary: string;
}

/** The seven ways a run can end — owned by `wire.ts` (RUN_STATUSES),
 *  re-exported here so the runner's existing importers keep their entry point. */
export type { RunStatus };

export interface RunOptions {
  controlRepo: string;
  taskPath: string;
  repoName: string;
  /** Copy from demo-repos/ instead of git clone. */
  local?: boolean;
  /** Print/record the result instead of pushing a branch + opening a PR. */
  dryRun?: boolean;
  engine?: "claude" | "mock";
  /** Injectable engine seam for hermetic end-to-end protocol fixtures. */
  engineOverride?: Engine;
  /** Patch file for the mock engine ("NONE" = simulate NO_CHANGES_NEEDED). */
  mockPatch?: string;
  /** Ordered agent observations for the mock engine (initial, then resumes). */
  mockUsage?: ProducerUsage[];
  /** Override the committed ledger location (tests point this at a temp file). */
  ledgerPath?: string;
  /** Override where artifacts are written (tests point this at a temp dir).
   *  Without it a test run writes into the working checkout's `artifacts/`, and
   *  the per-run archive's keep-20 prune then evicts real runs' evidence in
   *  mtime order — measured on 2026-08-04 to have removed every one of them. */
  artifactsRoot?: string;
  log?: (line: string) => void;
}

export interface RunResult {
  status: RunStatus;
  runId: string;
  task: Task;
  repo: FleetRepo;
  workspace: string;
  artifactsDir: string;
  diff: string;
  verify?: VerifyResult;
  /** Gates `task.gates` mandated that no check executed. Empty when the task
   *  declared none or all were met; those two cases are deliberately
   *  indistinguishable downstream, since neither leaves anything outstanding. */
  unmetGates?: string[];
  /** What the verification tree did with this diff's gate inputs (ADR-0014).
   *  Absent when the run never built a tree — nothing was held or carried,
   *  because nothing was reconstituted. */
  gateInputs?: GateInputDecision;
  prUrl?: string;
  /** Short commit sha, set once a change is committed (non-dry-run approvals). */
  sha?: string;
  resultText: string;
}

const FLEET_COMMIT_AUTHOR = ["-c", "user.name=Honk Fleet Runner", "-c", "user.email=fleet@users.noreply.github.com"];

const HARNESS_RULES = `You are a background coding agent operating on this repository.
Complete the task below. Rules of engagement:
- You may only edit files in this repository. Do not use git; the harness owns
  branching, commits, and pull requests.
- Call the "verify" MCP tool after making changes; the task is complete only
  when it reports VERIFY PASSED — or VERIFY INCONCLUSIVE, which means this
  repository has no verifiers and nothing you do will turn it green.
- Never modify dependency manifests or lockfiles (package.json,
  package-lock.json, pnpm-lock.yaml, Package.resolved, …) unless the task
  explicitly asks for it. The runner kills any run whose diff leaves the task's
  scope, and a person reads every diff that reaches a pull request.
- If the task's preconditions are not met, make no changes and end your reply
  with exactly: NO_CHANGES_NEEDED
`;

export function buildPreamble(task: Task, knowledgePreamble?: string): string {
  const scopeRule = task.scope
    ? `- You may only modify files matching: ${task.scope.join(", ")}. The runner\n  mechanically kills any run whose diff touches other files — before verify\n  or review.\n`
    : "";
  // The knowledge block sits after the rules of engagement and before the task,
  // so the agent knows the injected file is available while reading what to do.
  const knowledgeBlock = knowledgePreamble ? `\n${knowledgePreamble}\n` : "";
  return `${HARNESS_RULES}${scopeRule}${knowledgeBlock}\n--- TASK ---\n${task.raw}`;
}

function makeEngine(opts: RunOptions, workspace: string, mcpConfigPath: string): Engine {
  if (opts.engineOverride) return opts.engineOverride;
  if ((opts.engine ?? "claude") === "mock") {
    if (!opts.mockPatch) throw new Error("--engine mock requires --mock-patch");
    return mockEngine({ workspace, mockPatch: opts.mockPatch, usage: opts.mockUsage });
  }
  return claudeEngine({ workspace, mcpConfigPath });
}

/** https URL of the control repo on GitHub, if a remote is configured. */
function controlRepoWebUrl(controlRepo: string): string | undefined {
  try {
    const url = execFileSync("git", ["-C", controlRepo, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return match ? `https://github.com/${match[1]}` : undefined;
  } catch {
    return undefined;
  }
}

/** The first violation/failure line — keeps a kill legible in the ledger. */
function killReason(result: Pick<RunResult, "status" | "verify" | "resultText">, scopeOffenders?: string[]): string | undefined {
  switch (result.status) {
    case "agent-failed":
      return "agent produced no diff without declaring NO_CHANGES_NEEDED";
    case "verify-failed": {
      const failed = result.verify?.checks.find((c) => c.status === "failed");
      const firstLine = failed?.summary.split("\n").find((l) => l.trim() !== "")?.trim();
      return failed ? `${failed.label} failed${firstLine ? `: ${firstLine}` : ""}` : "verification failed";
    }
    case "scope-violation":
      return `out-of-scope files: ${(scopeOffenders ?? []).slice(0, 5).join(", ")}${(scopeOffenders?.length ?? 0) > 5 ? ", …" : ""}`;
    case "engine-failed":
      return result.resultText.split("\n")[0];
    default:
      return undefined;
  }
}

/**
 * The gates a task mandated that nothing satisfied.
 *
 * A gate is **met** when a check of that name actually executed — reached
 * `passed` or `failed`. A `skipped` check does not meet a mandate: it was
 * detected and then never reached because an earlier check failed, which is
 * precisely the "did not run" case the tri-state exists to name.
 *
 * Matching is by check name against an open vocabulary, so a gate naming a
 * check this host cannot run and a gate with a typo in it both come out unmet.
 * That is the design: neither can produce a false green, and no mechanism
 * exists whose function is to make one of them look acceptable.
 */
export function findUnmetGates(mandated: string[] | undefined, checks: VerifyCheck[]): string[] {
  if (!mandated || mandated.length === 0) return [];
  const executed = new Set(checks.filter((c) => c.status !== "skipped").map((c) => c.name));
  return mandated.filter((gate) => !executed.has(gate));
}

/**
 * The verification state a run *records* — a composition of what verification
 * found and what the task demanded, which is not the same thing as
 * `VerifyResult.state`. Deterministic verification answers "what does this repo
 * offer, and did it pass"; it never learns about tasks. Only the runner holds
 * both halves, so only the runner can compose them.
 *
 * `failed` outranks an unmet mandate — a red check is a kill either way, and
 * this feature adds no new way for one to be reported. An unmet mandate over an
 * otherwise-passing verification is `inconclusive`: every check that ran was
 * green, and the one the task cared about was not among them.
 *
 * Returns `undefined` when the run died before verify — nothing is known, which
 * no surface may render as green.
 */
export function composedVerifyState(
  result: Pick<RunResult, "verify" | "unmetGates">,
): VerifyState | undefined {
  if (!result.verify) return undefined;
  if (result.verify.state === "failed") return "failed";
  return (result.unmetGates?.length ?? 0) > 0 ? "inconclusive" : result.verify.state;
}

/**
 * Where a co-signer can read the task this PR claims to satisfy, or nothing.
 *
 * **Tracked, not merely present.** `tasks/private/` is git-ignored, so a private
 * task's file resolves to a path inside the control repo and its blob URL 404s
 * on every run, forever. The header exists so a reviewer can check the claim
 * against what was asked for; a citation that cannot resolve is worse than the
 * bare id, because it looks checkable and isn't
 * ([ADR-0012](../../../docs/adr/0012-a-pass-reports-only-what-it-observed.md) —
 * a pass reports only what it observed, and it never observed that page).
 */
export function taskFileUrl(
  controlRepo: string,
  taskPath: string,
  webUrl: string | undefined,
): string | undefined {
  if (!webUrl) return undefined;
  const rel = path.relative(controlRepo, taskPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  try {
    // stderr piped: not-tracked is this probe's answer, not a fault. Inherited,
    // git's "did you forget to 'git add'?" prints mid-run and reads as a run
    // that went wrong — on most runs, since private tasks are the common case.
    execFileSync("git", ["ls-files", "--error-unmatch", "--", rel], {
      cwd: controlRepo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
  return `${webUrl}/blob/main/${rel}`;
}

/**
 * A short, capped slice of the evidence that decided the run — the gate output
 * a reader would want when the one-line `reason` isn't enough. Kept small on
 * purpose: this lives inline in the append-only, version-controlled ledger, so
 * it must not carry multi-KB diffs or full logs (those stay in artifacts/).
 */
export function evidenceFor(
  result: Pick<RunResult, "status" | "verify" | "resultText" | "unmetGates" | "gateInputs">,
  scopeOffenders?: string[],
): string[] | undefined {
  const cap = (lines: string[]): string[] =>
    lines
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.trim() !== "")
      .slice(0, 8)
      .map((l) => (l.length > 200 ? `${l.slice(0, 197)}…` : l));

  switch (result.status) {
    case "verify-failed": {
      const failed = result.verify?.checks.find((c) => c.status === "failed");
      if (!failed) return undefined;
      return cap([`✗ ${failed.label} failed`, ...failed.summary.split("\n")]);
    }
    case "scope-violation":
      return cap([
        "✗ diff touched files outside the declared scope",
        ...(scopeOffenders ?? []).map((f) => `  ${f}`),
      ]);
    case "engine-failed":
      return cap(result.resultText.split("\n"));
    case "agent-failed":
      return cap(["agent produced no diff and did not declare NO_CHANGES_NEEDED", ...result.resultText.split("\n")]);
    case "approved": {
      // Read the headline off the composed state, never off its prose: an
      // approved run whose verifiers never ran — or whose task demanded a check
      // that did not — is not "all green".
      const unmet = result.unmetGates ?? [];
      // A run that held a gate input at the base is green about *less than the
      // whole diff*, and "all green" would say otherwise. Not a change to the
      // verification state (ADR-0014 changes neither that nor the status) — a
      // change to what this line is allowed to claim about it.
      const held = result.gateInputs?.held ?? [];
      const headline =
        unmet.length > 0
          ? `⚠ scope · judge green — verify INCONCLUSIVE (mandated gate never ran: ${unmet.join(", ")})`
          : result.verify?.state === "inconclusive"
            ? "⚠ scope · judge green — verify INCONCLUSIVE (no verifiers ran)"
            : held.length > 0
              ? `⚠ scope · verify · judge green — but held at the base, so unverified: ${held.join(", ")}`
              : "✓ scope · verify · judge all green";
      return cap([headline, ...(result.verify?.summary.split("\n") ?? [])]);
    }
    default:
      return undefined;
  }
}

function openPullRequest(opts: {
  workspace: string;
  repo: FleetRepo;
  task: Task;
  bodyFor: (sha: string) => string;
}): { url: string; sha: string } {
  const branch = `agent/${opts.task.id}`;
  // Every workspace that reaches here was cloned from the target — local runs
  // included, since a run that opens a PR is based on what it opens the PR
  // against (prepareWorkspace). So origin is already set and the history
  // already descends from the default branch.
  //
  // What used to live here was a `fetch` + `reset --soft FETCH_HEAD`, because
  // local mode git-init'd an unrelated history and GitHub rejects a PR with no
  // history in common. That re-parent was also the second base: it re-diffed
  // the workspace against upstream after verification had run against the
  // source's HEAD, so anything the two disagreed on shipped unauthored. There
  // is one base now, and nothing to re-parent.
  git(opts.workspace, ["checkout", "-b", branch]);
  // The commit is authored by the fleet, not a person — the -c overrides
  // beat the default runner identity because later -c flags win.
  git(opts.workspace, [...FLEET_COMMIT_AUTHOR, "commit", "-m", `${opts.task.id}: ${opts.task.title}`, "--quiet"]);
  const sha = git(opts.workspace, ["rev-parse", "HEAD"]).trim();
  git(opts.workspace, ["push", "--force", "-u", "origin", branch]);
  const body = opts.bodyFor(sha);
  let url: string;
  try {
    url = execFileSync(
      "gh",
      ["pr", "create", "--title", `[agent] ${opts.task.title}`, "--body", body, "--head", branch, "--base", opts.repo.default_branch],
      { cwd: opts.workspace, encoding: "utf8" },
    ).trim();
  } catch {
    // PR may already exist from a previous run of this task.
    url = execFileSync("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], {
      cwd: opts.workspace,
      encoding: "utf8",
    }).trim();
  }
  return { url, sha };
}

/** Phase timings, accumulated across every pass of one run. */
export interface PassTimings {
  agentMs: number;
  verifyMs: number;
  judgeMs: number;
}

/**
 * Everything a [pass](../../../CONTEXT.md#pass) needs, gathered once by `run()`.
 * Deliberately a value rather than a closure: the four-phase sequence is then
 * reachable from a test with fakes in place of the engine and the judge, which
 * is what it never had while it lived twice inside `run()`.
 */
export interface PassContext {
  task: Task;
  workspace: string;
  engine: Engine;
  registered: VerifierCheck[];
  /** First prompt only: the file persists on disk across passes and `resume`
   *  carries the session, so the agent keeps both without being re-told. */
  knowledgePreamble?: string;
  /** Absent when the task declares no `scope:` — unrestricted. */
  inScope?: (file: string) => boolean;
  artifact: (name: string, content: string) => void;
  timed: <T>(phase: keyof PassTimings, fn: () => T | Promise<T>) => Promise<T>;
  inflight: InflightHandle;
  usage: UsageCollector;
  log: (line: string) => void;
}

/** A pass that reached a fate of its own — no further pass can help. */
export interface EndedPass {
  outcome: "ended";
  status: RunStatus;
  diff: string;
  resultText: string;
  verify?: VerifyResult;
  unmetGates?: string[];
  /** Present only once a tree was actually built holding them — a pass that
   *  died at scope, or before the diff applied, held nothing. */
  gateInputs?: GateInputDecision;
  scopeOffenders?: string[];
}

/** A pass that reached green verify. The run may ship what it produced. */
export interface ApprovedPass {
  outcome: "approved";
  diff: string;
  resultText: string;
  verify: VerifyResult;
  unmetGates: string[];
  gateInputs: GateInputDecision;
}

export type PassOutcome = EndedPass | ApprovedPass;

/**
 * The task's mandate, checked against what actually executed. Verification
 * itself never learns about tasks — it is shared with the agent-facing MCP
 * tool, and handing the agent a mandate it cannot act on would leave it
 * chasing a pass it has no way to produce. Naming the unmet gates in the
 * summary is not redundancy with the wire field: it is what the agent reads, so
 * an unmet gate is visible to the thing that could still act on it.
 */
function applyGates(task: Task, result: VerifyResult): { verify: VerifyResult; unmetGates: string[] } {
  const unmet = findUnmetGates(task.gates, result.checks);
  if (unmet.length === 0) return { verify: result, unmetGates: unmet };
  return {
    verify: {
      ...result,
      summary:
        `${result.summary}\n\nGATES UNMET — this task mandated ${unmet.join(", ")}, which did not run here. ` +
        "What executed above is not the set the task required, so this change is unverified against its own mandate. This is not a pass.",
    },
    unmetGates: unmet,
  };
}

/**
 * The [pass](../../../CONTEXT.md#pass): agent → scope → verify. A run has
 * exactly one. The veto retry that could start a second died with the judge
 * (ADR-0025), and with it the resume path.
 *
 * A pass reports **only what it observed** ([ADR-0012](../../../docs/adr/0012-a-pass-reports-only-what-it-observed.md)).
 */
export async function runPass(ctx: PassContext): Promise<PassOutcome> {
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // Entered explicitly rather than assumed: `stageSince` marks the real start of
  // the agent call, so a cold clone stops consuming the agent stage's staleness
  // budget. Cloning stays bracketed into the phase it starts.
  ctx.inflight.enter("agent", 1);
  ctx.log("· running agent…");
  let engineResult: EngineResult;
  try {
    engineResult = await ctx.timed("agentMs", () => ctx.engine.run(buildPreamble(ctx.task, ctx.knowledgePreamble)));
    ctx.usage.recordAgent(engineResult.usage);
  } catch (error) {
    ctx.usage.recordAgent(unavailableProducerUsage("agent invocation failed before a usable final envelope"));
    return {
      outcome: "ended",
      status: "engine-failed",
      resultText: errorText(error),
      diff: "",
    };
  }
  ctx.artifact("transcript.json", engineResult.transcript);

  const diff = stagedDiff(ctx.workspace);
  const resultText = engineResult.resultText;

  if (diff.trim() === "") {
    // The task template requires the agent to END its reply with the sentinel —
    // a mere mention (e.g. while explaining a failure) must not count as a
    // benign no-op.
    const declared = resultText.trim().endsWith("NO_CHANGES_NEEDED");
    return { outcome: "ended", status: declared ? "no-changes" : "agent-failed", diff, resultText };
  }

  // The scope contract is enforced mechanically, not just promised: any diff
  // outside task.scope dies here — before verify, judge, or a human.
  ctx.inflight.enter("scope");
  const { inScope } = ctx;
  const offenders = inScope ? stagedFiles(ctx.workspace).filter((file) => !inScope(file)) : [];
  if (offenders.length > 0) {
    ctx.artifact("diff.patch", diff);
    ctx.artifact(
      "scope-violation.json",
      JSON.stringify({ scope: ctx.task.scope, offendingFiles: offenders }, null, 2),
    );
    ctx.log(`✖ scope violation: ${offenders.join(", ")}`);
    return { outcome: "ended", status: "scope-violation", diff, resultText, scopeOffenders: offenders };
  }

  // The verdict of record, on the tree that will actually ship: a clean base,
  // this diff applied, dependencies installed from the lockfile (ADR-0013). The
  // agent's workspace is not verified and never was the subject — the in-session
  // Stop hook that ran there is the retry loop, not this gate (ADR-0017 §1).
  //
  // What the tree does with the files that judge it is decided here, from the
  // diff's own paths and the task's `amends:` (ADR-0014). There is no detection
  // step and no trigger condition: `hold` is computed on every run, and is
  // simply empty on the ordinary one.
  // Both sides of a rename, unlike the scope check above: a test moved
  // elsewhere is a gate this diff took away, and only the path it came from
  // says so.
  const paths = stagedPaths(ctx.workspace);
  const inBase = pathsInBase(ctx.workspace, paths);
  const gateInputs = decideGateInputs(paths, {
    inBase: (file) => inBase.has(file),
    amends: ctx.task.amends,
  });
  if (!noGateInputs(gateInputs)) {
    const carried = gateInputs.carried.reduce((n, a) => n + a.files.length, 0);
    ctx.log(
      `· gate inputs: ${gateInputs.held.length} held at the base, ${carried} carried under an amendment, ` +
        `${gateInputs.introduced.length} added by this change`,
    );
  }
  ctx.log("· reconstituting the verification tree…");
  ctx.inflight.enter("verify");
  let tree: VerificationTree;
  try {
    tree = await ctx.timed("verifyMs", () =>
      constructVerificationTree({ workspace: ctx.workspace, diff, hold: gateInputs.held }),
    );
  } catch (error) {
    if (!(error instanceof TreeConstructionError)) throw error;
    ctx.artifact("diff.patch", diff);
    // ADR-0016 §3. The two cells differ in what they say about the change, so
    // they differ in status: an install that fails at the base leaves no
    // verdict on the change to record, while one that fails only after the diff
    // is applied is the change breaking its own dependency resolution.
    if (error.attribution === "change") {
      // The killing artefact for `diedAt: "verify"`, which is what the kill's
      // retention copies (ADR-0015). Not a check result — an install is not a
      // check (ADR-0016 §2) — but it is what the verify stage left behind.
      ctx.artifact("verify.log", error.message);
      ctx.log(`✖ verification tree failed to build: ${error.message.split("\n")[0]}`);
      // The hold ran before this install did, so it is part of what produced
      // this failure and belongs on the record. The infrastructure branch below
      // reports none: an install or an apply that failed never reached it.
      return { outcome: "ended", status: "verify-failed", diff, resultText: error.message, gateInputs };
    }
    ctx.log(`✖ ${error.message.split("\n")[0]}`);
    return { outcome: "ended", status: "engine-failed", diff, resultText: error.message };
  }
  ctx.log(`· verifying ${tree.base.slice(0, 7)} + this diff…`);
  const gated = applyGates(
    ctx.task,
    (await ctx.timed("verifyMs", () => runVerify(tree.path, { registered: ctx.registered }))) as VerifyResult,
  );
  // Folded into the summary the judge reads and the log the artifact keeps, for
  // the reason the gate note above is: this text is the judge's whole view of
  // what verification did, and a file held at the base is something it did.
  const unmetGates = gated.unmetGates;
  const noted = noGateInputs(gateInputs)
    ? gated.verify
    : { ...gated.verify, summary: `${gated.verify.summary}\n\n${gateInputNote(gateInputs)}` };
  // Every path was held, so the checks ran on the base commit itself and passed
  // on code containing no part of this change. That is ADR-0004's `inconclusive`
  // arriving by a third road — nothing proved anything — and calling it `passed`
  // would be the one output this system may not produce (ADR-0021).
  //
  // Only a pass is rewritten. A red on a tree that equals the base is a red
  // about the base, and reporting it as `failed` kills the run, which is the
  // direction that cannot manufacture a green.
  const verify =
    noted.state === "passed" && gateInputs.treeIsBase
      ? { ...noted, state: "inconclusive" as const }
      : noted;
  ctx.artifact("verify.log", verify.summary);
  if (verify.state === "failed") {
    ctx.artifact("diff.patch", diff);
    return { outcome: "ended", status: "verify-failed", diff, resultText, verify, unmetGates, gateInputs };
  }

  ctx.artifact("diff.patch", diff);
  // Green verify is now the last gate before review. Nothing else may reject a
  // change, so this returns approved or it has already returned ended.
  return { outcome: "approved", diff, resultText, verify, unmetGates, gateInputs };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const task = loadTask(opts.taskPath);
  const repo = findRepo(opts.controlRepo, opts.repoName);
  const dryRun = opts.dryRun ?? true;
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath(opts.controlRepo);
  const artifactsRoot = opts.artifactsRoot ?? defaultArtifactsRoot(opts.controlRepo);
  const runId = randomUUID();
  const usage = createUsageCollector();

  // Phase timings for the run's one pass. `finish` reads these by reference
  // after the phases have run.
  const startedAt = Date.now();
  const timings = { agentMs: 0, verifyMs: 0, judgeMs: 0 };
  const timed = async <T>(phase: keyof typeof timings, fn: () => T | Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timings[phase] += Date.now() - t;
    }
  };

  // Latest-run semantics: each run replaces this (task, repo) artifact set.
  const artifactsDir = path.join(artifactsRoot, task.id, repo.name);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });
  // Reviewable artifacts are additionally archived per run: a same-task rerun
  // replaces the flat set above, but must never destroy the evidence of a run
  // still awaiting review.
  const runDir = prepareRunArtifactsDir(artifactsRoot, runId);
  const artifact = (name: string, content: string) => {
    writeFileSync(path.join(artifactsDir, name), content);
    if (REVIEW_ARTIFACTS.has(name)) writeFileSync(path.join(runDir, name), content);
  };

  // Reap what SIGKILL (and only SIGKILL) can still orphan, before staking a
  // claim of our own. The report server never does this: a GET stays
  // side-effect-free and cannot race a runner mid-claim.
  sweepInflight(ledgerPath, log);

  // Claim a live slot before the workspace exists: a run is worth showing while
  // it clones its target, which on a cold cache is the longest it will ever sit
  // still without an explanation.
  const inflight = beginInflight({
    ledgerPath,
    runId,
    startedAt: new Date(startedAt),
    task: task.id,
    repo: repo.name,
    title: task.title,
    log,
  });

  try {
    log(`▶ task ${task.id} on ${repo.name} (${opts.local ? "local" : repo.url})`);
    const workspace = prepareWorkspace({
      controlRepo: opts.controlRepo,
      repo,
      taskId: task.id,
      local: opts.local ?? false,
      // A run that will open a PR is based on what it opens the PR against,
      // decided here because only the caller knows the run's intent.
      pr: !dryRun,
    });
    // Which of this target's registered verifiers actually run here (ADR-0009).
    // Composed by the runner because only the runner holds both halves: the
    // registry supplies the capability, the task's `gates:` says what must be
    // proven, and the environment decides what is even possible. `detect()`
    // stays target-blind. Computed per run, never cached — a verifier needing
    // an env var the Actions runner lacks is ineligible there and eligible here.
    const registered = eligibleVerifiers(repo.verifiers, { env: process.env, gates: task.gates });
    const { mcpConfigPath } = injectAgentConfig({
      controlRepo: opts.controlRepo,
      workspace,
      registered,
    });
    // Prime the run with the target's compiled knowledge, if any exists. Never
    // spends (renders the stored prose, flags drift); a missing artifact runs
    // cold. Archived to the run's evidence directly — not via REVIEW_ARTIFACTS,
    // which doubles as the operator's served set (Stage 6's concern, and would
    // expose private-target structure).
    const knowledge = await injectKnowledge({ controlRepo: opts.controlRepo, workspace, repo });
    if (knowledge.injected && knowledge.content) {
      writeFileSync(path.join(runDir, RUN_KNOWLEDGE_FILE), knowledge.content);
      log(`· injected knowledge → ${knowledge.relPath}${knowledge.drift?.recompileRequired ? " (stale — drift banner included)" : ""}`);
    } else {
      log("· no compiled knowledge for this target — running cold");
    }
    const engine = makeEngine(opts, workspace, mcpConfigPath);

    const finish = (result: Omit<RunResult, "runId">, scopeOffenders?: string[]): RunResult => {
      const full: RunResult = { ...result, runId };
      const modelUsageEvidence = usage.evidence(runId, new Date().toISOString());
      // A custom ledger is the runner's hermetic-test seam. Keep its durable
      // evidence beside that ledger instead of leaking test runs into the control
      // repo's committed fleet/evidence directory.
      const evidenceRoot = opts.ledgerPath ? path.dirname(ledgerPath) : opts.controlRepo;
      const persistedUsage = writeModelUsageEvidence({
        controlRepo: evidenceRoot,
        evidence: modelUsageEvidence,
      });
      const modelUsage = usage.projection(modelUsageEvidence, persistedUsage.sha256);
      artifact("model-usage.json", persistedUsage.content);
      artifact("result.json", JSON.stringify({ ...full, task: task.id, repo: repo.name, modelUsage }, null, 2));
      appendLedger(ledgerPath, {
        ts: new Date().toISOString(),
        runId,
        task: task.id,
        repo: repo.name,
        status: full.status,
        // Always local: the cloud entry point is deleted (ADR-0024), so no run
        // this code path writes can be a cloud run. `"cloud"` survives in the
        // contract and the readers because two archived ledger rows carry it.
        mode: "local",
        // Always 0. The judge is deleted (ADR-0025) and nothing can veto, but
        // the field stays on the wire because 48 archived rows carry it.
        vetoes: 0,
        reason: killReason(full, scopeOffenders),
        prUrl: full.prUrl,
        title: task.title,
        sha: full.sha?.slice(0, 7),
        elapsedMs: Date.now() - startedAt,
        timings: { ...timings },
        evidence: evidenceFor(full, scopeOffenders),
        // Recorded, so the operator reads the verification state as a fact
        // rather than string-matching the evidence lines. Absent when the run
        // died before verify — nothing is known, which is not the same as green.
        // This is the *composed* state, not a passthrough of verify.state: it
        // folds in whether the task's mandated gates actually ran.
        verifyState: composedVerifyState(full),
        modelUsage,
        // Only when something is outstanding. Omitted for a run that declared no
        // gates and for one whose gates were all met — neither has anything to
        // report, and an empty array would read as a positive all-clear.
        ...((full.unmetGates?.length ?? 0) > 0 ? { unmetGates: full.unmetGates } : {}),
        // The amendment and the hold, on the same terms as unmetGates: present
        // only when this run actually had one. A task that declared `amends:`
        // and produced a diff that touched nothing it names records neither —
        // the licence was never exercised, so there is nothing to report
        // (ADR-0014). The reason travels with the glob, because a licence
        // without its justification is the bare glob this design refuses.
        ...((full.gateInputs?.carried.length ?? 0) > 0
          ? { amendments: full.gateInputs?.carried.map(({ glob, reason }) => ({ glob, reason })) }
          : {}),
        ...((full.gateInputs?.held.length ?? 0) > 0 ? { heldGateInputs: full.gateInputs?.held } : {}),
      });
      // Strictly after the append: the run is now durable in the ledger, so
      // dropping the live claim can only ever lose a row that has a replacement.
      // A reader that catches the gap sees the run twice — once live, once
      // decided — and reconciles on runId.
      inflight.clear();
      // A kill's diff and the artefact that killed it are copied into the
      // evidence store, which nothing prunes (ADR-0015). Best-effort like the
      // render below — the run is already decided and durable, so nothing here
      // may fail it — but reported rather than swallowed.
      const retentionLine = killRetentionLog(
        retainKill({ evidenceRoot, runId, status: full.status, artifactsDir }),
      );
      if (retentionLine) log(retentionLine);
      // Keep the rendered report current: re-render from the whole ledger after
      // every run so artifacts/ledger.html never lags the data. Only for the real
      // committed ledger — a caller pointing at a custom ledger (tests) opts out,
      // keeping runs hermetic. A render hiccup must never fail an otherwise-good run.
      if (!opts.ledgerPath) {
        try {
          writeLedgerHtml(ledgerPath, defaultLedgerHtmlPath(opts.controlRepo));
        } catch (err) {
          log(`⚠ ledger report not regenerated: ${(err as Error).message}`);
        }
      }
      log(`■ ${full.status}${full.prUrl ? ` → ${full.prUrl}` : ""}`);
      return full;
    };

    // The knowledge preamble need only be in the first prompt: the file
    // persists on disk across passes (the workspace is not recreated) and
    // engine.resume carries the session, so the agent keeps both.
    const knowledgePreamble =
      knowledge.injected && knowledge.relPath && knowledge.artifactSha
        ? buildRunPreamble(knowledge.relPath, knowledge.artifactSha, knowledge.drift?.recompileRequired ?? false)
        : undefined;

    const ctx: PassContext = {
      task,
      workspace,
      engine,
      registered,
      knowledgePreamble,
      // Absent when the task declares no scope, which leaves the judge as the
      // only scope police.
      inScope: task.scope ? picomatch(task.scope, { dot: true }) : undefined,
      artifact,
      timed,
      inflight,
      usage,
      log,
    };

    /** A pass that reached a fate of its own: record it and stop. */
    const settle = (pass: EndedPass): RunResult =>
      finish(
        {
          task,
          repo,
          workspace,
          artifactsDir,
          diff: pass.diff,
          resultText: pass.resultText,
          verify: pass.verify,
          unmetGates: pass.unmetGates,
          gateInputs: pass.gateInputs,
          status: pass.status,
        },
        pass.scopeOffenders,
      );

    // One pass, always. The veto retry loop lived here and was the only thing
    // that could start a second one (ADR-0025).
    const pass = await runPass(ctx);
    if (pass.outcome === "ended") return settle(pass);

    const { diff, resultText, verify, unmetGates, gateInputs } = pass;

    // Assemble the reviewer-facing PR body (previewed as an artifact in
    // dry-run). The fleet record deliberately reads the ledger *before* this
    // run's own line is appended in finish().
    const webUrl = controlRepoWebUrl(opts.controlRepo);
    const bodyInput = {
      task,
      diff,
      verifyChecks: verify.checks,
      // The composed state, so the co-sign banner and "What actually ran" agree
      // with the ledger rather than with verification's own narrower answer.
      verifyState: composedVerifyState({ verify, unmetGates }) ?? verify.state,
      unmetGates,
      // What the tree held and what the task licensed, with the reason. A
      // co-signer is being asked to merge a diff part of which may not have
      // been verified, and that is not a fact the body may leave to the log.
      gateInputs,
      verifySummary: verify.summary,
      record: fleetRecord(readLedger(ledgerPath)),
      taskFileUrl: taskFileUrl(opts.controlRepo, opts.taskPath, webUrl),
      newIssueUrl: webUrl ? `${webUrl}/issues/new` : undefined,
    };

    let prUrl: string | undefined;
    let sha: string | undefined;
    if (dryRun) {
      artifact("pr-preview.md", buildPrBody(bodyInput));
    } else {
      log("· opening pull request…");
      inflight.enter("shipping");
      ({ url: prUrl, sha } = openPullRequest({
        workspace,
        repo,
        task,
        bodyFor: (s) => buildPrBody({ ...bodyInput, sha: s }),
      }));
    }

    return finish({
      task,
      repo,
      workspace,
      artifactsDir,
      diff,
      resultText,
      verify,
      unmetGates,
      gateInputs,
      prUrl,
      sha,
      status: "approved",
    });
  } finally {
    // The throw path: prepareWorkspace fails on a bad clone or a missing
    // local_path, and finish() never runs. Clearing is idempotent, so the
    // successful path clearing first inside finish() costs nothing here.
    inflight.clear();
  }
}
