/**
 * Hermetic end-to-end tests: the full runner loop — workspace preparation,
 * agent-config injection, (mock) agent edit, REAL deterministic verification
 * (eslint + tsc + vitest execute inside the workspace), stubbed judge, and
 * dry-run artifacts — with zero network and no API key. The real Claude
 * engine is the same code path with a different spawn.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { JudgeClient, Verdict } from "@fleet/judge";
import type { InflightRecord } from "@fleet/contract";
import { inflightDir, readInflight } from "../src/inflight.js";
import { readLedger } from "../src/ledger.js";
import { run } from "../src/run.js";

const CONTROL_REPO = path.resolve(__dirname, "..", "..", "..");
const TASK_001 = path.join(CONTROL_REPO, "tasks", "examples", "001-ts-migrate-http-client.md");
const SCOPE_TASK = path.join(__dirname, "fixtures", "scope-task.md");
const GOOD_PATCH = path.join(__dirname, "fixtures", "001-good.patch");
const BAD_PATCH = path.join(__dirname, "fixtures", "001-bad.patch");

const quiet = () => {};

/** Every test run gets a throwaway ledger so the committed one stays clean. */
const tmpLedger = () =>
  path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-e2e-ledger-")), "ledger.jsonl");

beforeAll(() => {
  // The workspace symlinks the demo repo's node_modules so verify doesn't
  // reinstall per test; make sure it exists.
  const demo = path.join(CONTROL_REPO, "demo-repos", "demo-ts-service");
  if (!existsSync(path.join(demo, "node_modules"))) {
    execFileSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: demo });
  }
});

// Some tests stub GITHUB_ACTIONS to pin the recorded run mode; never leak it.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runner e2e (mock engine, hermetic)", () => {
  it("happy path: migration applied → verify green → approved → dry-run artifacts", async () => {
    const ledgerPath = tmpLedger();
    // This hermetic run simulates a local dispatch; keep the recorded mode
    // deterministic even when the suite itself runs inside GitHub Actions CI.
    vi.stubEnv("GITHUB_ACTIONS", "");
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: TASK_001,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: GOOD_PATCH,
      judgeMode: "approve",
      ledgerPath,
      log: quiet,
    });

    expect(result.status).toBe("approved");
    expect(result.prUrl).toBeUndefined();

    // The migration really happened in the workspace.
    expect(existsSync(path.join(result.workspace, "src/legacy/httpClient.ts"))).toBe(false);
    expect(readFileSync(path.join(result.workspace, "src/userService.ts"), "utf8")).toContain(
      "fetchJson",
    );

    // Agent config was injected.
    expect(existsSync(path.join(result.workspace, ".claude/settings.json"))).toBe(true);
    expect(existsSync(path.join(result.workspace, ".claude/hooks/stop-verify.mjs"))).toBe(true);
    const hook = readFileSync(path.join(result.workspace, ".claude/hooks/stop-verify.mjs"), "utf8");
    expect(hook).not.toContain("__CONTROL_REPO__"); // placeholders resolved

    // Real verification ran and passed.
    expect(result.verify?.ok).toBe(true);
    expect(result.verify?.summary).toContain("VERIFY PASSED");

    // Dry-run artifacts.
    for (const f of ["diff.patch", "verdict.json", "verify.log", "transcript.json", "result.json", "pr-preview.md"]) {
      expect(existsSync(path.join(result.artifactsDir, f)), f).toBe(true);
    }

    // The reviewable set is also archived per run — byte-identical to the flat
    // copy — so a same-task rerun can't destroy this run's evidence. The bulky
    // transcript stays out of the archive.
    const runDir = path.join(CONTROL_REPO, "artifacts", "runs", result.runId);
    for (const f of ["diff.patch", "verdict.json", "verify.log", "result.json", "pr-preview.md"]) {
      expect(readFileSync(path.join(runDir, f), "utf8"), f).toBe(
        readFileSync(path.join(result.artifactsDir, f), "utf8"),
      );
    }
    expect(existsSync(path.join(runDir, "transcript.json"))).toBe(false);
    // result.json names its run, so the archive is attributable on its own.
    expect(JSON.parse(readFileSync(path.join(runDir, "result.json"), "utf8")).runId).toBe(result.runId);
    const diffPatch = readFileSync(path.join(result.artifactsDir, "diff.patch"), "utf8");
    expect(diffPatch).toContain("deleted file mode");
    // demo-ts-service commits its own .claude/settings.json, which the
    // injected harness config overwrites — that must never reach the diff.
    expect(diffPatch).not.toContain(".claude");
    expect(result.diff).not.toContain(".claude");

    // The dry-run preview is the exact reviewer-facing PR body.
    const preview = readFileSync(path.join(result.artifactsDir, "pr-preview.md"), "utf8");
    expect(preview).toContain("co-signing a verified change");
    expect(preview).toContain("## What changed");
    expect(preview).toContain("## Undo");
    expect(preview).toContain("`git revert <sha>`");
    expect(preview).toContain("Last 30 days:");
    expect(preview).toContain("stub judge (approve): approved —");

    // The run recorded itself in the (test-scoped) ledger.
    const entries = readLedger(ledgerPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      task: "001-ts-migrate-http-client",
      repo: "demo-ts-service",
      status: "approved",
      mode: "local",
      vetoes: 0,
    });
    // Enriched fields the runner records for the ledger views.
    expect(entries[0].title).toBeTruthy();
    expect(typeof entries[0].elapsedMs).toBe("number");
    expect(entries[0].timings).toBeDefined();
    expect(entries[0].timings!.verifyMs).toBeGreaterThanOrEqual(0);
    expect(entries[0].evidence?.length).toBeGreaterThan(0);
    // The live claim is dropped once the run is durable in the ledger — but the
    // fleet-wide store itself survives, since concurrent runs live in it.
    expect(readInflight(ledgerPath)).toEqual([]);
    expect(existsSync(inflightDir(ledgerPath))).toBe(true);
  });

  it("records cloud provenance in the ledger when running under GitHub Actions", async () => {
    const ledgerPath = tmpLedger();
    // Pin the cloud signal: mode "cloud" plus the fields the operator later uses
    // to pull this run's evidence — the artifact name matches agent-task.yml's.
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_RUN_ID", "1234567890");
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: TASK_001,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: GOOD_PATCH,
      judgeMode: "approve",
      ledgerPath,
      log: quiet,
    });

    expect(result.status).toBe("approved");
    const [entry] = readLedger(ledgerPath);
    expect(entry.mode).toBe("cloud");
    expect(entry.actionsRunId).toBe("1234567890");
    expect(entry.actionsArtifact).toBe("001-ts-migrate-http-client-demo-ts-service");
  });

  it("live state: the run publishes its stage as it goes, and clears it when it lands", async () => {
    const ledgerPath = tmpLedger();
    // The judge is the one place a stub gets to look at the world mid-run.
    const seen: InflightRecord[] = [];
    const veto: Verdict = {
      verdict: "veto",
      violations: ["stub: first attempt rejected"],
      guidance: "try again",
      rationale: "stub",
    };
    const approve: Verdict = { verdict: "approve", violations: [], guidance: "", rationale: "stub" };
    let calls = 0;
    const judgeClient: JudgeClient = {
      messages: {
        parse: async () => {
          calls += 1;
          seen.push(...readInflight(ledgerPath));
          return { parsed_output: calls === 1 ? veto : approve };
        },
      },
    };

    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: TASK_001,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: GOOD_PATCH,
      judgeMode: "claude", // stubbed client: no network, no API key
      judgeClient,
      ledgerPath,
      log: quiet,
    });

    expect(result.status).toBe("approved");
    // Both times the judge looked, exactly one record was in flight — this
    // process's — and it said "judge". The second says which pass through the
    // agent→verify→judge loop it was on, which the stage alone cannot.
    expect(seen).toHaveLength(2);
    expect(seen.map((r) => [r.stage, r.attempt])).toEqual([
      ["judge", 1],
      ["judge", 2],
    ]);
    expect(seen[0]).toMatchObject({
      v: 1,
      pid: process.pid,
      task: "001-ts-migrate-http-client",
      repo: "demo-ts-service",
    });
    expect(seen[0].title).toBeTruthy();
    expect(Date.parse(seen[0].stageSince)).toBeGreaterThanOrEqual(Date.parse(seen[0].startedAt));

    // runId is the reconcile key: the same run, live and then decided.
    const [entry] = readLedger(ledgerPath);
    expect(entry.runId).toBe(seen[0].runId);
    expect(readInflight(ledgerPath)).toEqual([]);
  });

  it("scope gate: out-of-scope diff dies before verify/judge, recorded as a kill", async () => {
    const ledgerPath = tmpLedger();
    // scope-task.md confines the diff to test/**, but the good patch touches
    // src/** — the runner must kill the run before verify or judge see it.
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: SCOPE_TASK,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: GOOD_PATCH,
      judgeMode: "veto", // must never be consulted
      ledgerPath,
      log: quiet,
    });

    expect(result.status).toBe("scope-violation");
    expect(result.verify).toBeUndefined();
    expect(result.verdict).toBeUndefined();
    expect(result.prUrl).toBeUndefined();

    const violation = JSON.parse(
      readFileSync(path.join(result.artifactsDir, "scope-violation.json"), "utf8"),
    ) as { scope: string[]; offendingFiles: string[] };
    expect(violation.scope).toEqual(["test/**"]);
    expect(violation.offendingFiles).toContain("src/userService.ts");
    expect(existsSync(path.join(result.artifactsDir, "diff.patch"))).toBe(true);

    const entries = readLedger(ledgerPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("scope-violation");
    expect(entries[0].reason).toContain("out-of-scope files: src/");
    // A kill is a terminal path like any other: it must not leave a ghost in
    // the lane, claiming to be running forever.
    expect(readInflight(ledgerPath)).toEqual([]);
  });

  it("negative path: broken change → verify red → no PR, no verdict", async () => {
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: TASK_001,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: BAD_PATCH,
      judgeMode: "approve",
      ledgerPath: tmpLedger(),
      log: quiet,
    });

    expect(result.status).toBe("verify-failed");
    expect(result.verify?.ok).toBe(false);
    expect(result.verify?.summary).toContain("VERIFY FAILED");
    // Verification stops at the first failing check; the broken change trips
    // eslint (unused var) before tsc even runs — either error is fine.
    expect(result.verify?.summary).toMatch(/error/);
    expect(result.verify?.summary).toContain("userService.ts");
    expect(result.verdict).toBeUndefined();
    expect(existsSync(path.join(result.artifactsDir, "verdict.json"))).toBe(false);
  });

  it("judge veto with self-correction: veto once → resume → approved", async () => {
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: TASK_001,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: GOOD_PATCH,
      judgeMode: "veto-once",
      ledgerPath: tmpLedger(),
      log: quiet,
    });

    expect(result.status).toBe("approved");
    // The retry transcript proves the resume happened.
    expect(existsSync(path.join(result.artifactsDir, "transcript.retry-1.json"))).toBe(true);
    // The absorbed veto surfaces as the immune-system trace in the preview.
    expect(result.vetoes).toHaveLength(1);
    const preview = readFileSync(path.join(result.artifactsDir, "pr-preview.md"), "utf8");
    expect(preview).toContain("Attempt 1 vetoed (stub: first attempt rejected)");
  });

  it("judge veto exhausted: retries used up → vetoed, no PR", async () => {
    const vetoLedger = tmpLedger();
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: TASK_001,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: GOOD_PATCH,
      judgeMode: "veto",
      maxJudgeRetries: 1,
      ledgerPath: vetoLedger,
      log: quiet,
    });

    expect(result.status).toBe("vetoed");
    expect(result.verdict?.verdict).toBe("veto");
    expect(result.prUrl).toBeUndefined();

    const entries = readLedger(vetoLedger);
    expect(entries[0]).toMatchObject({ status: "vetoed", vetoes: 2, reason: "stub: change rejected" });
  });

  it("precondition path: agent makes no changes and declares NO_CHANGES_NEEDED", async () => {
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: TASK_001,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: "NONE",
      judgeMode: "approve",
      ledgerPath: tmpLedger(),
      log: quiet,
    });

    expect(result.status).toBe("no-changes");
    expect(result.diff.trim()).toBe("");
  });
});

describe("stop hook (unit-level, real verify)", () => {
  it("blocks (exit 2) on a red workspace and passes stderr guidance", async () => {
    // Run the happy path to get a green workspace with the hook injected,
    // then break it and invoke the hook the way Claude Code would.
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: TASK_001,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: GOOD_PATCH,
      judgeMode: "approve",
      ledgerPath: tmpLedger(),
      log: quiet,
    });
    const hookPath = path.join(result.workspace, ".claude/hooks/stop-verify.mjs");

    // Green workspace → hook allows the stop.
    execFileSync("node", [hookPath], { input: "{}", encoding: "utf8" });

    // Break a source file → hook must exit 2 with the verify summary.
    const svc = path.join(result.workspace, "src/userService.ts");
    const original = readFileSync(svc, "utf8");
    const broken = original.replace("return fetchJson", "return fetchJsonTypo");
    execFileSync("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(svc)}, ${JSON.stringify(broken)})`]);

    let exitCode = 0;
    let stderr = "";
    try {
      execFileSync("node", [hookPath], { input: "{}", encoding: "utf8" });
    } catch (err) {
      const e = err as { status: number; stderr: string };
      exitCode = e.status;
      stderr = e.stderr;
    }
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Verification is failing");
    expect(stderr).toContain("VERIFY FAILED");
    expect(stderr).toContain("userService.ts");
  });
});
