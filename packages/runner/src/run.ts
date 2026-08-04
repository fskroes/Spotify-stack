import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { knownJudgeCapability, type JudgeIdentity, type RunStatus, type VerdictEvidence, type VerifyState } from "@fleet/contract";
import { runVerify } from "@fleet/mcp-verify";
import { createCliJudgeClient, createJudgeClient, judgeWithEvidence, type JudgeClient, type JudgeInput, type JudgeResult, type Verdict } from "@fleet/judge";
import { defaultArtifactsRoot, prepareRunArtifactsDir, REVIEW_ARTIFACTS } from "./artifacts.js";
import { assertJudgeReadStartupMarker, preflightJudgeRead } from "./judge-read-check.js";
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
import { git, injectAgentConfig, injectKnowledge, prepareWorkspace, RUN_KNOWLEDGE_FILE, stagedDiff, stagedFiles, stagedPaths } from "./workspace.js";

interface VerifyResult {
  /** Tri-state: `inconclusive` means no verifier ran, which is not a pass.
   *  Orthogonal to RunStatus — an inconclusive run still ships as `approved`. */
  state: VerifyState;
  checks: VerifyCheck[];
  summary: string;
}

/** The seven ways a run can end — owned by `@fleet/contract` (RUN_STATUSES),
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
  judgeMode?: "claude" | "cli" | "approve" | "veto" | "veto-once";
  judgeClient?: JudgeClient;
  maxJudgeRetries?: number;
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
  verdict?: Verdict;
  /** Veto verdicts absorbed along the way (includes a final fatal one). */
  vetoes: Verdict[];
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
  explicitly asks for it. Judges veto out-of-scope changes; every veto costs a
  full retry loop.
- If the task's preconditions are not met, make no changes and end your reply
  with exactly: NO_CHANGES_NEEDED
`;

export function buildPreamble(task: Task, knowledgePreamble?: string): string {
  const scopeRule = task.scope
    ? `- You may only modify files matching: ${task.scope.join(", ")}. The runner\n  mechanically kills any run whose diff touches other files — before verify,\n  judge, or review.\n`
    : "";
  // The knowledge block sits after the rules of engagement and before the task,
  // so the agent knows the injected file is available while reading what to do.
  const knowledgeBlock = knowledgePreamble ? `\n${knowledgePreamble}\n` : "";
  return `${HARNESS_RULES}${scopeRule}${knowledgeBlock}\n--- TASK ---\n${task.raw}`;
}

/**
 * Judge mode when the caller didn't pass one. In CI (`GITHUB_ACTIONS`, the same
 * cloud signal used below) the SDK judge runs against the ANTHROPIC_API_KEY
 * secret. Locally we default to `cli` — judges via the local `claude` CLI on the
 * user's subscription, so a local run needs no API key and burns no credits.
 */
export function defaultJudgeMode(): NonNullable<RunOptions["judgeMode"]> {
  return process.env.GITHUB_ACTIONS ? "claude" : "cli";
}

/**
 * Whether this run's judge will start a read server of its own — the only case
 * with a subprocess to prove anything about.
 *
 * The SDK transport calls the reader in-process, and an injected client
 * replaces the transport wholesale, subprocess and all: handshaking a server
 * neither will ever start proves nothing, and asserting a marker neither can
 * write would fail every run that used one.
 */
function judgeStartsAReadServer(opts: RunOptions): boolean {
  return (opts.judgeMode ?? defaultJudgeMode()) === "cli" && !opts.judgeClient;
}

/**
 * @param artifactsDir  Where the CLI judge's read server writes the startup
 *   marker this runner asserts afterwards — one file per invocation, so a
 *   retry's judge is proven to have had a reader of its own rather than
 *   inheriting the first attempt's proof.
 */
function makeJudge(
  opts: RunOptions,
  { artifactsDir }: { artifactsDir: string },
): (input: Omit<JudgeInput, "client" | "model">) => Promise<JudgeResult> {
  const mode = opts.judgeMode ?? defaultJudgeMode();
  const stub = (verdict: Verdict): JudgeResult => ({
    verdict,
    usage: unavailableProducerUsage("stub judge does not produce model usage evidence"),
    // Named on the record, because a run judged by nothing must not be readable
    // as a run judged by something. `readPaths` stays absent rather than empty:
    // a stub had no reader, and empty would claim one that chose not to read.
    judge: { model: `stub judge (${mode})`, capability: "stub" },
  });
  let calls = 0;
  return async (input) => {
    calls += 1;
    switch (mode) {
      case "approve":
        return stub({ verdict: "approve", violations: [], guidance: "", rationale: "stub judge: auto-approved (no review performed)" });
      case "veto":
        return stub({
          verdict: "veto",
          violations: ["stub: change rejected"],
          guidance: "stub guidance: correct the diff",
          rationale: "stub judge: auto-vetoed",
        });
      case "veto-once":
        return stub(calls === 1
          ? {
              verdict: "veto",
              violations: ["stub: first attempt rejected"],
              guidance: "stub guidance: try again",
              rationale: "stub judge: auto-vetoed first attempt",
            }
          : { verdict: "approve", violations: [], guidance: "", rationale: "stub judge: auto-approved after retry" });
      // One client per invocation, rooted at this run's workspace: the read
      // capability the judge is handed is scoped to the thing under review, and
      // cannot outlive it (ADR-0011). Which transport carries a verdict is a
      // billing question and not a capability one, and these are the two call
      // sites where that would silently stop being true.
      //
      // Their *launch* paths are not symmetric, though, and the marker below
      // belongs on `cli` alone: that transport starts the read server as a
      // subprocess, which can fail to come up and leave a judge reviewing
      // blind. `claude` calls the reader in-process — an unavailable one
      // throws, and a throwing judge is already a failed run. A check on that
      // path could not fail, and a check that cannot fail reads like a
      // guarantee.
      case "cli": {
        // The other half of `judgeStartsAReadServer`, which the mode has
        // already settled by the time control reaches this case.
        if (opts.judgeClient) return judgeWithEvidence({ ...input, client: opts.judgeClient });
        const markerPath = path.join(artifactsDir, `judge-read-startup.${calls}.json`);
        // Per invocation, like the marker and for the same reason: a retry's
        // verdict must say what *its* judge read, not what the attempt before
        // it did.
        const journalPath = path.join(artifactsDir, `judge-read-paths.${calls}.txt`);
        const result = await judgeWithEvidence({
          ...input,
          client: createCliJudgeClient({ workspace: input.workspace, markerPath, journalPath }),
        });
        // After the verdict, and fatal to it. A verdict reached without the
        // ability to read is not a cheaper verdict — it is the one this whole
        // cage exists to stop being recorded as a review (ADR-0011).
        assertJudgeReadStartupMarker(markerPath);
        return result;
      }
      case "claude":
        return judgeWithEvidence({ ...input, client: opts.judgeClient ?? createJudgeClient({ workspace: input.workspace }) });
    }
  };
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
function killReason(result: Pick<RunResult, "status" | "verify" | "verdict" | "resultText">, scopeOffenders?: string[]): string | undefined {
  switch (result.status) {
    case "agent-failed":
      return "agent produced no diff without declaring NO_CHANGES_NEEDED";
    case "verify-failed": {
      const failed = result.verify?.checks.find((c) => c.status === "failed");
      const firstLine = failed?.summary.split("\n").find((l) => l.trim() !== "")?.trim();
      return failed ? `${failed.label} failed${firstLine ? `: ${firstLine}` : ""}` : "verification failed";
    }
    case "vetoed":
      return result.verdict?.violations[0] ?? result.verdict?.rationale;
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
 * The verdict as it is *recorded*: what the model returned, plus what the runner
 * observed about the judge that returned it (cage spec §7.1).
 *
 * Two authors, one file, and the split matters. The verdict fields are the
 * model's answer; `readPaths` and `judge` are the runner's account of the
 * reviewer — which is why neither appears on the schema the model fills in. A
 * judge asked to list its own reads can list files it never opened, and telling
 * that apart from a grounded veto is the entire purpose of recording them.
 *
 * Absent stays absent: `JSON.stringify` drops an undefined field, so a judgement
 * that observed nothing writes a record with no such key rather than one
 * claiming a judge that read nothing.
 */
export function verdictRecord(verdict: Verdict, result: Pick<JudgeResult, "readPaths" | "judge">): string {
  const evidence: VerdictEvidence = { readPaths: result.readPaths, judge: result.judge };
  return JSON.stringify({ ...verdict, ...evidence }, null, 2);
}

/**
 * The one line of prose the PR body names the reviewer with.
 *
 * Composed from the structured pair rather than replacing it: a human at
 * co-sign reads a sentence, and a model name alone cannot tell two reviewers
 * with different powers apart, which is the condition ADR-0011 ends. The pair
 * is recorded beside this in `verdict.json`, for readers that are not people.
 *
 * A stub names no capability. "stub judge (approve) + stub" says the same thing
 * twice, and the model half already says the only thing that matters about it.
 */
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

export function judgeLine(judge: JudgeIdentity | undefined): string {
  if (!judge) return "an unrecorded judge";
  return knownJudgeCapability(judge.capability) === "stub" ? judge.model : `${judge.model} + ${judge.capability}`;
}

/**
 * A short, capped slice of the evidence that decided the run — the gate output
 * a reader would want when the one-line `reason` isn't enough. Kept small on
 * purpose: this lives inline in the append-only, version-controlled ledger, so
 * it must not carry multi-KB diffs or full logs (those stay in artifacts/).
 */
export function evidenceFor(
  result: Pick<RunResult, "status" | "verify" | "verdict" | "resultText" | "unmetGates" | "gateInputs">,
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
    case "vetoed": {
      const v = result.verdict;
      if (!v) return undefined;
      return cap([...v.violations.map((line) => `veto: ${line}`), ...(v.rationale ? [v.rationale] : [])]);
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
  judgeOnce: (input: Omit<JudgeInput, "client" | "model">) => Promise<JudgeResult>;
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
  /** Only ever the *prior* pass's, and only when this pass never reached the
   *  workspace — see the agent-failure path in `runPass`. */
  verdict?: Verdict;
}

/**
 * A pass the judge rejected. The only outcome that may seed another pass, which
 * is why it alone carries the session and the ordinal: `runPass`'s second
 * parameter accepts this type and no other, so "only a veto starts another
 * pass" is a compile error rather than a convention.
 */
export interface VetoedPass {
  outcome: "vetoed";
  ordinal: number;
  sessionId: string;
  diff: string;
  resultText: string;
  verify: VerifyResult;
  unmetGates: string[];
  gateInputs: GateInputDecision;
  judgeResult: JudgeResult;
}

/** A pass the judge approved. The run may ship what it produced. */
export interface ApprovedPass {
  outcome: "approved";
  diff: string;
  resultText: string;
  verify: VerifyResult;
  unmetGates: string[];
  gateInputs: GateInputDecision;
  judgeResult: JudgeResult;
}

export type PassOutcome = EndedPass | VetoedPass | ApprovedPass;

/**
 * The task's mandate, checked against what actually executed. Verification
 * itself never learns about tasks — it is shared with the agent-facing MCP
 * tool, and handing the agent a mandate it cannot act on would leave it
 * chasing a pass it has no way to produce. Naming the unmet gates in the
 * summary is not redundancy with the wire field: the judge's whole input is
 * the task markdown, the diff, and this text, so this is what lets it
 * decline to approve a change on the strength of checks the task never asked for.
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

/** The veto, handed back to the agent that produced the change. */
function resumeGuidance(verdict: Verdict): string {
  return (
    `A reviewer rejected your change:\n${verdict.violations.map((v) => `- ${v}`).join("\n")}\n\n` +
    `${verdict.guidance}\nCorrect the change, then call the verify tool again.`
  );
}

/**
 * One [pass](../../../CONTEXT.md#pass): agent → scope → verify → judge. A run
 * has at least one; a judge veto starts another.
 *
 * The veto retry used to be a second copy of this sequence, and the two copies
 * drifted — the copy never classified an empty diff, so an agent that reverted
 * its vetoed change reached `approved` beside a zero-byte `diff.patch`. One
 * implementation, looped, cannot drift.
 *
 * A pass reports **only what it observed** ([ADR-0012](../../../docs/adr/0012-a-pass-reports-only-what-it-observed.md)).
 * It never pairs this pass's diff with an earlier pass's verification or
 * verdict: that green belongs to a change this pass replaced, and a verdict on
 * a diff nobody reviewed is the one output the system may not produce
 * (ADR-0004). The single exception is documented at the agent-failure path,
 * where this pass never reached the workspace at all.
 */
export async function runPass(ctx: PassContext, prior?: VetoedPass): Promise<PassOutcome> {
  const ordinal = (prior?.ordinal ?? 0) + 1;
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // Every pass, not only the retries: stage alone cannot tell a second trip
  // through Agent from a run that never left it. Re-entering on the first pass
  // too means `stageSince` marks the real start of the agent call, so a cold
  // clone stops consuming the agent stage's staleness budget. The stage label is
  // unchanged either way — cloning stays bracketed into the phase it starts.
  ctx.inflight.enter("agent", ordinal);
  ctx.log(prior ? "· resuming agent…" : "· running agent…");
  let engineResult: EngineResult;
  try {
    engineResult = await ctx.timed("agentMs", () =>
      prior
        ? ctx.engine.resume(prior.sessionId, resumeGuidance(prior.judgeResult.verdict))
        : ctx.engine.run(buildPreamble(ctx.task, ctx.knowledgePreamble)),
    );
    ctx.usage.recordAgent(engineResult.usage);
  } catch (error) {
    ctx.usage.recordAgent(
      unavailableProducerUsage(
        prior
          ? "agent resume failed before a usable final envelope"
          : "agent invocation failed before a usable final envelope",
      ),
    );
    // The one place a pass may report an earlier pass's facts, and it is not the
    // stale-green hazard: this pass never reached the workspace, so the change
    // `prior` verified and judged is still exactly what is staged there. Diff,
    // verification and verdict continue to describe the same change, and
    // reporting nothing would misreport a dirty workspace as clean. Every path
    // below has staged something of its own, where an earlier green would
    // describe a change that no longer exists.
    if (prior) ctx.artifact("diff.patch", prior.diff);
    return {
      outcome: "ended",
      status: "engine-failed",
      resultText: errorText(error),
      diff: prior?.diff ?? "",
      verify: prior?.verify,
      unmetGates: prior?.unmetGates,
      gateInputs: prior?.gateInputs,
      verdict: prior?.judgeResult.verdict,
    };
  }
  ctx.artifact(prior ? `transcript.retry-${prior.ordinal}.json` : "transcript.json", engineResult.transcript);

  const diff = stagedDiff(ctx.workspace);
  const resultText = engineResult.resultText;

  if (diff.trim() === "") {
    // The task template requires the agent to END its reply with the sentinel —
    // a mere mention (e.g. while explaining a failure) must not count as a
    // benign no-op. Applied on every pass, not just the first: an agent that
    // reverts its vetoed change has produced nothing to review, and the run has
    // to say so rather than record an approval of a change that no longer exists.
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
  const gateInputs = decideGateInputs(stagedPaths(ctx.workspace), ctx.task.amends);
  if (!noGateInputs(gateInputs)) {
    const carried = gateInputs.carried.reduce((n, a) => n + a.files.length, 0);
    ctx.log(`· gate inputs: ${gateInputs.held.length} held at the base, ${carried} carried under an amendment`);
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
  const verify = noGateInputs(gateInputs)
    ? gated.verify
    : { ...gated.verify, summary: `${gated.verify.summary}\n\n${gateInputNote(gateInputs)}` };
  ctx.artifact("verify.log", verify.summary);
  if (verify.state === "failed") {
    ctx.artifact("diff.patch", diff);
    return { outcome: "ended", status: "verify-failed", diff, resultText, verify, unmetGates, gateInputs };
  }

  ctx.inflight.enter("judge");
  let judgeResult: JudgeResult;
  try {
    judgeResult = await ctx.timed("judgeMs", () =>
      ctx.judgeOnce({ taskMarkdown: ctx.task.raw, diff, verifySummary: verify.summary, workspace: ctx.workspace }),
    );
    ctx.usage.recordJudge(judgeResult.usage);
  } catch (error) {
    ctx.usage.recordJudge(unavailableProducerUsage("judge invocation failed before a usable producer response"));
    ctx.artifact("diff.patch", diff);
    // No verdict, deliberately: this pass never got one. An earlier pass's veto
    // judged a *different* diff, and recording it beside this one would pair a
    // verdict with a change its judge never saw.
    return { outcome: "ended", status: "engine-failed", diff, resultText: errorText(error), verify, unmetGates, gateInputs };
  }

  ctx.artifact("diff.patch", diff);
  const facts = { diff, resultText, verify, unmetGates, gateInputs, judgeResult };
  return judgeResult.verdict.verdict === "veto"
    ? { outcome: "vetoed", ordinal, sessionId: engineResult.sessionId, ...facts }
    : { outcome: "approved", ...facts };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const task = loadTask(opts.taskPath);
  const repo = findRepo(opts.controlRepo, opts.repoName);
  const dryRun = opts.dryRun ?? true;
  const maxRetries = opts.maxJudgeRetries ?? 2;
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath(opts.controlRepo);
  const artifactsRoot = opts.artifactsRoot ?? defaultArtifactsRoot(opts.controlRepo);
  const vetoes: Verdict[] = [];
  const runId = randomUUID();
  const usage = createUsageCollector();

  // Phase timings, accumulated across the (possibly repeated) agent→verify→judge
  // loop. `finish` reads these by reference after the phases have run.
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
    const judgeOnce = makeJudge(opts, { artifactsDir });

    const finish = (result: Omit<RunResult, "vetoes" | "runId">, scopeOffenders?: string[]): RunResult => {
      const full: RunResult = { ...result, vetoes, runId };
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
        mode: process.env.GITHUB_ACTIONS ? "cloud" : "local",
        vetoes: vetoes.length,
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
        // Cloud provenance: only in Actions, where the review set is uploaded as
        // an artifact named `<task>-<repo>` (the exact expression agent-task.yml
        // uses). Lets the operator pull this run's evidence on demand later.
        ...(process.env.GITHUB_ACTIONS
          ? { actionsRunId: process.env.GITHUB_RUN_ID, actionsArtifact: `${task.id}-${repo.name}` }
          : {}),
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

    // Before the agent, not merely before the judge. The handshake costs no
    // tokens and the agent's are model spend too, so a run whose judge could
    // never have read this workspace dies before anything is billed to it
    // (ADR-0011: a judge that cannot read fails the run). Once per run — the
    // workspace does not change between veto-retries, so neither can the
    // answer, and only the per-invocation marker is worth re-proving.
    if (judgeStartsAReadServer(opts)) {
      try {
        await preflightJudgeRead({ workspace, log });
      } catch (error) {
        return finish({
          task,
          repo,
          workspace,
          artifactsDir,
          diff: "",
          resultText: error instanceof Error ? error.message : String(error),
          status: "engine-failed",
        });
      }
    }

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
      judgeOnce,
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
          verdict: pass.verdict,
          status: pass.status,
        },
        pass.scopeOffenders,
      );

    // The loop — and the only place retry policy lives. A pass knows nothing
    // about how many are allowed; it produces an outcome, and only a veto can
    // seed the next one, which is why `runPass` accepts no other kind.
    let pass = await runPass(ctx);
    while (pass.outcome === "vetoed" && vetoes.length < maxRetries) {
      vetoes.push(pass.judgeResult.verdict);
      // This veto's own evidence, not the run's: each pass was a separate
      // judgement with its own reads, and folding them together would credit
      // one pass's grounding to another's. The filename records whether the veto
      // was retried — this loop's decision, which the pass cannot know.
      artifact(`verdict.veto-${vetoes.length}.json`, verdictRecord(pass.judgeResult.verdict, pass.judgeResult));
      log(`· judge vetoed (retry ${vetoes.length}/${maxRetries}) — resuming agent with guidance`);
      pass = await runPass(ctx, pass);
    }

    if (pass.outcome === "ended") return settle(pass);

    const { diff, resultText, verify, unmetGates, gateInputs, judgeResult } = pass;
    const verdict = judgeResult.verdict;
    artifact("verdict.json", verdictRecord(verdict, judgeResult));

    if (pass.outcome === "vetoed") {
      vetoes.push(verdict);
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
        verdict,
        status: "vetoed",
      });
    }

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
      verdict,
      vetoes,
      // Both taken from the judgement that actually produced this verdict,
      // rather than from the mode the run asked for. The mode says which
      // transport was requested; these say what answered and what it opened —
      // and an injected client is exactly the case where those differ.
      judgeName: judgeLine(judgeResult.judge),
      readPaths: judgeResult.readPaths,
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
      // Push + `gh pr create` takes seconds and has always rendered as "judge".
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
      verdict,
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
