import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { type RunStatus, type VerifyState } from "@fleet/contract";
import { runVerify } from "@fleet/mcp-verify";
import { createCliJudgeClient, judgeWithEvidence, type JudgeClient, type JudgeResult, type Verdict } from "@fleet/judge";
import { prepareRunArtifactsDir, REVIEW_ARTIFACTS } from "./artifacts.js";
import { claudeEngine, mockEngine, type Engine, type EngineResult } from "./engine.js";
import { createUsageCollector, unavailableProducerUsage, writeModelUsageEvidence, type ProducerUsage } from "./model-usage.js";
import { findRepo, type FleetRepo } from "./fleet.js";
import { beginInflight, sweepInflight } from "./inflight.js";
import { appendLedger, defaultLedgerPath, fleetRecord, readLedger } from "./ledger.js";
import { defaultLedgerHtmlPath, writeLedgerHtml } from "./ledger-html.js";
import { buildPrBody, type VerifyCheck } from "./pr.js";
import { buildRunPreamble } from "@fleet/knowledge";
import { loadTask, type Task } from "./task.js";
import { git, injectAgentConfig, injectKnowledge, prepareWorkspace, RUN_KNOWLEDGE_FILE, stagedDiff, stagedFiles } from "./workspace.js";

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

function makeJudge(opts: RunOptions): (input: { taskMarkdown: string; diff: string; verifySummary: string }) => Promise<JudgeResult> {
  const mode = opts.judgeMode ?? defaultJudgeMode();
  const stub = (verdict: Verdict): JudgeResult => ({
    verdict,
    usage: unavailableProducerUsage("stub judge does not produce model usage evidence"),
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
      case "cli":
        return judgeWithEvidence({ ...input, client: opts.judgeClient ?? createCliJudgeClient() });
      case "claude":
        return judgeWithEvidence({ ...input, client: opts.judgeClient });
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
 * A short, capped slice of the evidence that decided the run — the gate output
 * a reader would want when the one-line `reason` isn't enough. Kept small on
 * purpose: this lives inline in the append-only, version-controlled ledger, so
 * it must not carry multi-KB diffs or full logs (those stay in artifacts/).
 */
export function evidenceFor(
  result: Pick<RunResult, "status" | "verify" | "verdict" | "resultText" | "unmetGates">,
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
      const headline =
        unmet.length > 0
          ? `⚠ scope · judge green — verify INCONCLUSIVE (mandated gate never ran: ${unmet.join(", ")})`
          : result.verify?.state === "inconclusive"
            ? "⚠ scope · judge green — verify INCONCLUSIVE (no verifiers ran)"
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
  local: boolean;
  bodyFor: (sha: string) => string;
}): { url: string; sha: string } {
  const branch = `agent/${opts.task.id}`;
  // Cloud mode clones (origin set, history descends from the default branch);
  // local mode git-inits a fresh, unrelated history with no remote. Wire origin,
  // and for local re-parent the change onto the real default branch — otherwise
  // GitHub rejects the PR ("no history in common with <base>").
  const hasOrigin = git(opts.workspace, ["remote"]).split("\n").map((r) => r.trim()).includes("origin");
  if (!hasOrigin) git(opts.workspace, ["remote", "add", "origin", opts.repo.url]);
  git(opts.workspace, ["checkout", "-b", branch]);
  if (opts.local) {
    git(opts.workspace, ["fetch", "--depth=1", "origin", opts.repo.default_branch]);
    // reset --soft keeps the staged tree but moves the branch onto the fetched
    // base, so the single commit's diff is exactly the agent's change vs. it.
    git(opts.workspace, ["reset", "--soft", "FETCH_HEAD"]);
  }
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

export async function run(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const task = loadTask(opts.taskPath);
  const repo = findRepo(opts.controlRepo, opts.repoName);
  const dryRun = opts.dryRun ?? true;
  const maxRetries = opts.maxJudgeRetries ?? 2;
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath(opts.controlRepo);
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
  const artifactsDir = path.join(opts.controlRepo, "artifacts", task.id, repo.name);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });
  // Reviewable artifacts are additionally archived per run: a same-task rerun
  // replaces the flat set above, but must never destroy the evidence of a run
  // still awaiting review.
  const runDir = prepareRunArtifactsDir(opts.controlRepo, runId);
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
    });
    const { mcpConfigPath } = injectAgentConfig({ controlRepo: opts.controlRepo, workspace });
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
    const judgeOnce = makeJudge(opts);

    const finish = (result: Omit<RunResult, "vetoes" | "runId">, scopeOffenders?: string[]): RunResult => {
      const full: RunResult = { ...result, vetoes, runId };
      const modelUsageEvidence = usage.evidence(runId, new Date().toISOString());
      // A custom ledger is the runner's hermetic-test seam. Keep its durable
      // evidence beside that ledger instead of leaking test runs into the control
      // repo's committed fleet/evidence directory.
      const persistedUsage = writeModelUsageEvidence({
        controlRepo: opts.ledgerPath ? path.dirname(ledgerPath) : opts.controlRepo,
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

    // The scope contract is enforced mechanically, not just promised: any diff
    // outside task.scope dies here — before verify, judge, or a human.
    const inScope = task.scope ? picomatch(task.scope, { dot: true }) : undefined;
    const scopeOffenders = (): string[] =>
      inScope ? stagedFiles(workspace).filter((file) => !inScope(file)) : [];

    log("· running agent…");
    let engineResult: EngineResult;
    try {
      // The knowledge preamble need only be in the first prompt: the file
      // persists on disk across veto-retries (the workspace is not recreated)
      // and engine.resume carries the session, so the agent keeps both.
      const knowledgePreamble =
        knowledge.injected && knowledge.relPath && knowledge.artifactSha
          ? buildRunPreamble(knowledge.relPath, knowledge.artifactSha, knowledge.drift?.recompileRequired ?? false)
          : undefined;
      engineResult = await timed("agentMs", () => engine.run(buildPreamble(task, knowledgePreamble)));
      usage.recordAgent(engineResult.usage);
    } catch (error) {
      usage.recordAgent(unavailableProducerUsage("agent invocation failed before a usable final envelope"));
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
    artifact("transcript.json", engineResult.transcript);

    let diff = stagedDiff(workspace);
    const base: Omit<RunResult, "status" | "vetoes" | "runId"> = {
      task,
      repo,
      workspace,
      artifactsDir,
      diff,
      resultText: engineResult.resultText,
    };

    if (diff.trim() === "") {
      // The task template requires the agent to END its reply with the
      // sentinel — a mere mention (e.g. while explaining a failure) must not
      // count as a benign no-op.
      const declared = engineResult.resultText.trim().endsWith("NO_CHANGES_NEEDED");
      return finish({ ...base, status: declared ? "no-changes" : "agent-failed" });
    }

    const enforceScope = (): string[] => {
      inflight.enter("scope");
      const offenders = scopeOffenders();
      if (offenders.length > 0) {
        artifact("diff.patch", diff);
        artifact(
          "scope-violation.json",
          JSON.stringify({ scope: task.scope, offendingFiles: offenders }, null, 2),
        );
        log(`✖ scope violation: ${offenders.join(", ")}`);
      }
      return offenders;
    };

    let offenders = enforceScope();
    if (offenders.length > 0) {
      return finish({ ...base, diff, status: "scope-violation" }, offenders);
    }

    // The task's mandate, checked against what actually executed. Verification
    // itself never learns about tasks — it is shared with the agent-facing MCP
    // tool, and handing the agent a mandate it cannot act on would leave it
    // chasing a pass it has no way to produce. Naming the unmet gates in the
    // summary is not redundancy with the wire field: the judge's whole input is
    // the task markdown, the diff, and this text, so this is what lets it
    // decline to approve a change on the strength of checks the task never asked for.
    const applyGates = (result: VerifyResult): { verify: VerifyResult; unmetGates: string[] } => {
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
    };

    // Belt-and-braces deterministic verification (the Stop hook already ran it
    // inside the session for the real engine, but nothing green goes unproven).
    log("· verifying…");
    inflight.enter("verify");
    let gated = applyGates((await timed("verifyMs", () => runVerify(workspace))) as VerifyResult);
    let verify = gated.verify;
    let unmetGates = gated.unmetGates;
    artifact("verify.log", verify.summary);
    if (verify.state === "failed") {
      artifact("diff.patch", diff);
      return finish({ ...base, diff, verify, unmetGates, status: "verify-failed" });
    }

    // Judge loop — veto feeds guidance back into the same session (part 3).
    inflight.enter("judge");
    let judgeResult: JudgeResult;
    try {
      judgeResult = await timed("judgeMs", () => judgeOnce({ taskMarkdown: task.raw, diff, verifySummary: verify.summary }));
      usage.recordJudge(judgeResult.usage);
    } catch (error) {
      usage.recordJudge(unavailableProducerUsage("judge invocation failed before a usable producer response"));
      artifact("diff.patch", diff);
      return finish({
        ...base,
        diff,
        verify,
        unmetGates,
        resultText: error instanceof Error ? error.message : String(error),
        status: "engine-failed",
      });
    }
    let verdict = judgeResult.verdict;
    let retries = 0;
    while (verdict.verdict === "veto" && retries < maxRetries) {
      retries += 1;
      vetoes.push(verdict);
      log(`· judge vetoed (attempt ${retries}/${maxRetries}) — resuming agent with guidance`);
      artifact(`verdict.veto-${retries}.json`, JSON.stringify(verdict, null, 2));
      // Back to the agent, on a later pass: stage alone cannot tell a second trip
      // through Agent from a run that never left it.
      inflight.enter("agent", retries + 1);
      try {
        engineResult = await timed("agentMs", () =>
          engine.resume(
            engineResult.sessionId,
            `A reviewer rejected your change:\n${verdict.violations.map((v) => `- ${v}`).join("\n")}\n\n${verdict.guidance}\nCorrect the change, then call the verify tool again.`,
          ),
        );
        usage.recordAgent(engineResult.usage);
      } catch (error) {
        usage.recordAgent(unavailableProducerUsage("agent resume failed before a usable final envelope"));
        artifact("diff.patch", diff);
        return finish({
          ...base,
          diff,
          verify,
          unmetGates,
          verdict,
          resultText: error instanceof Error ? error.message : String(error),
          status: "engine-failed",
        });
      }
      artifact(`transcript.retry-${retries}.json`, engineResult.transcript);
      diff = stagedDiff(workspace);
      offenders = enforceScope();
      if (offenders.length > 0) {
        return finish({ ...base, diff, status: "scope-violation" }, offenders);
      }
      inflight.enter("verify");
      gated = applyGates((await timed("verifyMs", () => runVerify(workspace))) as VerifyResult);
      verify = gated.verify;
      unmetGates = gated.unmetGates;
      artifact("verify.log", verify.summary);
      if (verify.state === "failed") {
        artifact("diff.patch", diff);
        return finish({ ...base, diff, verify, unmetGates, status: "verify-failed" });
      }
      inflight.enter("judge");
      try {
        judgeResult = await timed("judgeMs", () => judgeOnce({ taskMarkdown: task.raw, diff, verifySummary: verify.summary }));
        usage.recordJudge(judgeResult.usage);
      } catch (error) {
        usage.recordJudge(unavailableProducerUsage("judge invocation failed before a usable producer response"));
        artifact("diff.patch", diff);
        return finish({
          ...base,
          diff,
          verify,
          unmetGates,
          verdict,
          resultText: error instanceof Error ? error.message : String(error),
          status: "engine-failed",
        });
      }
      verdict = judgeResult.verdict;
    }

    artifact("diff.patch", diff);
    artifact("verdict.json", JSON.stringify(verdict, null, 2));

    if (verdict.verdict === "veto") {
      vetoes.push(verdict);
      return finish({ ...base, diff, verify, unmetGates, verdict, status: "vetoed" });
    }

    // Assemble the reviewer-facing PR body (previewed as an artifact in
    // dry-run). The fleet record deliberately reads the ledger *before* this
    // run's own line is appended in finish().
    const webUrl = controlRepoWebUrl(opts.controlRepo);
    const taskRelPath = path.relative(opts.controlRepo, opts.taskPath);
    const bodyInput = {
      task,
      diff,
      verifyChecks: verify.checks,
      // The composed state, so the co-sign banner and "What actually ran" agree
      // with the ledger rather than with verification's own narrower answer.
      verifyState: composedVerifyState({ verify, unmetGates }) ?? verify.state,
      unmetGates,
      verifySummary: verify.summary,
      verdict,
      vetoes,
      judgeName: ["claude", "cli"].includes(opts.judgeMode ?? defaultJudgeMode())
        ? "claude-opus-4-8"
        : `stub judge (${opts.judgeMode})`,
      record: fleetRecord(readLedger(ledgerPath)),
      taskFileUrl:
        webUrl && !taskRelPath.startsWith("..") ? `${webUrl}/blob/main/${taskRelPath}` : undefined,
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
        local: opts.local ?? false,
        bodyFor: (s) => buildPrBody({ ...bodyInput, sha: s }),
      }));
    }

    return finish({ ...base, diff, verify, unmetGates, verdict, prUrl, sha, status: "approved" });
  } finally {
    // The throw path: prepareWorkspace fails on a bad clone or a missing
    // local_path, and finish() never runs. Clearing is idempotent, so the
    // successful path clearing first inside finish() costs nothing here.
    inflight.clear();
  }
}
