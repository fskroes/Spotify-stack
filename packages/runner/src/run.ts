import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { runVerify } from "@fleet/mcp-verify";
import { createCliJudgeClient, judge, type JudgeClient, type Verdict } from "@fleet/judge";
import { prepareRunArtifactsDir, REVIEW_ARTIFACTS } from "./artifacts.js";
import { claudeEngine, mockEngine, type Engine } from "./engine.js";
import { findRepo, type FleetRepo } from "./fleet.js";
import { beginInflight, sweepInflight } from "./inflight.js";
import { appendLedger, defaultLedgerPath, fleetRecord, readLedger } from "./ledger.js";
import { defaultLedgerHtmlPath, writeLedgerHtml } from "./ledger-html.js";
import { buildPrBody, type VerifyCheck } from "./pr.js";
import { loadTask, type Task } from "./task.js";
import { git, injectAgentConfig, prepareWorkspace, stagedDiff, stagedFiles } from "./workspace.js";

interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  summary: string;
}

export type RunStatus =
  | "approved" // diff approved; PR created unless dry-run
  | "no-changes" // precondition not met — agent correctly did nothing
  | "agent-failed" // agent produced no diff without declaring NO_CHANGES_NEEDED
  | "verify-failed" // deterministic verification red after the agent finished
  | "vetoed" // judge vetoed and retries were exhausted
  | "scope-violation" // diff touched files outside the task's scope contract
  | "engine-failed"; // the engine process crashed mid-run (e.g. on a judge-retry resume)

export interface RunOptions {
  controlRepo: string;
  taskPath: string;
  repoName: string;
  /** Copy from demo-repos/ instead of git clone. */
  local?: boolean;
  /** Print/record the result instead of pushing a branch + opening a PR. */
  dryRun?: boolean;
  engine?: "claude" | "mock";
  /** Patch file for the mock engine ("NONE" = simulate NO_CHANGES_NEEDED). */
  mockPatch?: string;
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
  when it reports VERIFY PASSED.
- Never modify dependency manifests or lockfiles (package.json,
  package-lock.json, pnpm-lock.yaml, Package.resolved, …) unless the task
  explicitly asks for it. Judges veto out-of-scope changes; every veto costs a
  full retry loop.
- If the task's preconditions are not met, make no changes and end your reply
  with exactly: NO_CHANGES_NEEDED
`;

export function buildPreamble(task: Task): string {
  const scopeRule = task.scope
    ? `- You may only modify files matching: ${task.scope.join(", ")}. The runner\n  mechanically kills any run whose diff touches other files — before verify,\n  judge, or review.\n`
    : "";
  return `${HARNESS_RULES}${scopeRule}\n--- TASK ---\n${task.raw}`;
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

function makeJudge(opts: RunOptions): (input: { taskMarkdown: string; diff: string; verifySummary: string }) => Promise<Verdict> {
  const mode = opts.judgeMode ?? defaultJudgeMode();
  let calls = 0;
  return async (input) => {
    calls += 1;
    switch (mode) {
      case "approve":
        return { verdict: "approve", violations: [], guidance: "", rationale: "stub judge: auto-approved (no review performed)" };
      case "veto":
        return {
          verdict: "veto",
          violations: ["stub: change rejected"],
          guidance: "stub guidance: correct the diff",
          rationale: "stub judge: auto-vetoed",
        };
      case "veto-once":
        return calls === 1
          ? {
              verdict: "veto",
              violations: ["stub: first attempt rejected"],
              guidance: "stub guidance: try again",
              rationale: "stub judge: auto-vetoed first attempt",
            }
          : { verdict: "approve", violations: [], guidance: "", rationale: "stub judge: auto-approved after retry" };
      case "cli":
        return judge({ ...input, client: opts.judgeClient ?? createCliJudgeClient() });
      case "claude":
        return judge({ ...input, client: opts.judgeClient });
    }
  };
}

function makeEngine(opts: RunOptions, workspace: string, mcpConfigPath: string): Engine {
  if ((opts.engine ?? "claude") === "mock") {
    if (!opts.mockPatch) throw new Error("--engine mock requires --mock-patch");
    return mockEngine({ workspace, mockPatch: opts.mockPatch });
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
      const failed = result.verify?.checks.find((c) => !c.ok);
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
 * A short, capped slice of the evidence that decided the run — the gate output
 * a reader would want when the one-line `reason` isn't enough. Kept small on
 * purpose: this lives inline in the append-only, version-controlled ledger, so
 * it must not carry multi-KB diffs or full logs (those stay in artifacts/).
 */
function evidenceFor(
  result: Pick<RunResult, "status" | "verify" | "verdict" | "resultText">,
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
      const failed = result.verify?.checks.find((c) => !c.ok);
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
    case "approved":
      return cap(["✓ scope · verify · judge all green", ...(result.verify?.summary.split("\n") ?? [])]);
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
    const engine = makeEngine(opts, workspace, mcpConfigPath);
    const judgeOnce = makeJudge(opts);

    const finish = (result: Omit<RunResult, "vetoes" | "runId">, scopeOffenders?: string[]): RunResult => {
      const full: RunResult = { ...result, vetoes, runId };
      artifact("result.json", JSON.stringify({ ...full, task: task.id, repo: repo.name }, null, 2));
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
    let engineResult = await timed("agentMs", () => engine.run(buildPreamble(task)));
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

    // Belt-and-braces deterministic verification (the Stop hook already ran it
    // inside the session for the real engine, but nothing green goes unproven).
    log("· verifying…");
    inflight.enter("verify");
    let verify = (await timed("verifyMs", () => runVerify(workspace))) as VerifyResult;
    artifact("verify.log", verify.summary);
    if (!verify.ok) {
      artifact("diff.patch", diff);
      return finish({ ...base, diff, verify, status: "verify-failed" });
    }

    // Judge loop — veto feeds guidance back into the same session (part 3).
    inflight.enter("judge");
    let verdict = await timed("judgeMs", () => judgeOnce({ taskMarkdown: task.raw, diff, verifySummary: verify.summary }));
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
      } catch (error) {
        artifact("diff.patch", diff);
        return finish({
          ...base,
          diff,
          verify,
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
      verify = (await timed("verifyMs", () => runVerify(workspace))) as VerifyResult;
      artifact("verify.log", verify.summary);
      if (!verify.ok) {
        artifact("diff.patch", diff);
        return finish({ ...base, diff, verify, status: "verify-failed" });
      }
      inflight.enter("judge");
      verdict = await timed("judgeMs", () => judgeOnce({ taskMarkdown: task.raw, diff, verifySummary: verify.summary }));
    }

    artifact("diff.patch", diff);
    artifact("verdict.json", JSON.stringify(verdict, null, 2));

    if (verdict.verdict === "veto") {
      vetoes.push(verdict);
      return finish({ ...base, diff, verify, verdict, status: "vetoed" });
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

    return finish({ ...base, diff, verify, verdict, prUrl, sha, status: "approved" });
  } finally {
    // The throw path: prepareWorkspace fails on a bad clone or a missing
    // local_path, and finish() never runs. Clearing is idempotent, so the
    // successful path clearing first inside finish() costs nothing here.
    inflight.clear();
  }
}
