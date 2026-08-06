/**
 * Hermetic end-to-end tests: the full runner loop — workspace preparation,
 * agent-config injection, (mock) agent edit, REAL deterministic verification
 * (eslint + tsc + vitest execute inside the workspace), and dry-run artifacts — with zero network and no API key. The real Claude
 * engine is the same code path with a different spawn.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { InflightRecord } from "@fleet/contract";
import { inflightDir, readInflight } from "../src/inflight.js";
import { retainedKillDir } from "../src/kill-retention.js";
import { readLedger } from "../src/ledger.js";
import { unavailableProducerUsage } from "../src/model-usage.js";
import { run } from "../src/run.js";

const CONTROL_REPO = path.resolve(__dirname, "..", "..", "..");
const TASK_001 = path.join(CONTROL_REPO, "tasks", "examples", "001-ts-migrate-http-client.md");
const SCOPE_TASK = path.join(__dirname, "fixtures", "scope-task.md");
const GATES_UNMET_TASK = path.join(__dirname, "fixtures", "gates-unmet-task.md");
const GATES_MET_TASK = path.join(__dirname, "fixtures", "gates-met-task.md");
const AMENDS_TASK = path.join(__dirname, "fixtures", "amends-task.md");
const UNAMENDED_TASK = path.join(__dirname, "fixtures", "unamended-task.md");
const ADDED_GATE_INPUT_TASK = path.join(__dirname, "fixtures", "added-gate-input-task.md");
const GOOD_PATCH = path.join(__dirname, "fixtures", "001-good.patch");
/** Moves the scoreboard: it removes a behaviour from the source and rewrites
 *  the assertion that would have caught the removal, in one diff. */
const SCOREBOARD_PATCH = path.join(__dirname, "fixtures", "001-scoreboard.patch");
const NEW_TEST_PATCH = path.join(__dirname, "fixtures", "002-new-test.patch");
const BAD_PATCH = path.join(__dirname, "fixtures", "001-bad.patch");
/** A copy of the good patch whose `.retry.patch` reverses it, so a resume
 *  reverts the workspace instead of correcting it. Kept separate from
 *  GOOD_PATCH: adding a retry patch beside that one would change what every
 *  other resuming test does. */
const REVERT_PATCH = path.join(__dirname, "fixtures", "001-revert.patch");

const quiet = () => {};

/** Every test run gets a throwaway ledger so the committed one stays clean. */
const tmpLedger = () =>
  path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-e2e-ledger-")), "ledger.jsonl");

/** …and a throwaway artifacts root, for the same reason. Without it a test run
 *  writes its per-run archive into the control repo's `artifacts/runs/`, where
 *  the keep-20 prune then evicts real runs' evidence in mtime order — measured
 *  on 2026-08-04 to have removed every real run's archive from the checkout. */
const tmpArtifacts = () => mkdtempSync(path.join(os.tmpdir(), "fleet-e2e-artifacts-"));

/** Where this run's retained kill landed (ADR-0015). A custom ledger moves the
 *  whole evidence store beside it, so hermetic runs never write into the
 *  control repo's `fleet/evidence/`. */
const killStore = (ledgerPath: string, runId: string) =>
  retainedKillDir(path.dirname(ledgerPath), runId);

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
    const artifactsRoot = tmpArtifacts();
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
      ledgerPath,
      artifactsRoot,
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
    expect(result.verify?.state).toBe("passed");
    expect(result.verify?.summary).toContain("VERIFY PASSED");

    // Dry-run artifacts.
    for (const f of ["diff.patch", "verify.log", "transcript.json", "result.json", "pr-preview.md"]) {
      expect(existsSync(path.join(result.artifactsDir, f)), f).toBe(true);
    }

    // The reviewable set is also archived per run — byte-identical to the flat
    // copy — so a same-task rerun can't destroy this run's evidence. The bulky
    // transcript stays out of the archive.
    const runDir = path.join(artifactsRoot, "runs", result.runId);
    for (const f of ["diff.patch", "verify.log", "result.json", "pr-preview.md"]) {
      expect(readFileSync(path.join(runDir, f), "utf8"), f).toBe(
        readFileSync(path.join(result.artifactsDir, f), "utf8"),
      );
    }
    expect(existsSync(path.join(runDir, "transcript.json"))).toBe(false);
    // Nothing was killed, so nothing is awaiting re-adjudication: an approved
    // run's evidence is its PR, and the kill store stays empty (ADR-0015).
    expect(existsSync(killStore(ledgerPath, result.runId))).toBe(false);
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
    expect(preview).toContain("Nothing reviewed the change for intent");
    expect(preview).toContain("## What changed");
    expect(preview).toContain("## Undo");
    expect(preview).toContain("`git revert <sha>`");
    expect(preview).toContain("Last 30 days:");

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

  it("injects the target's compiled knowledge, archives it per run, and keeps it out of the diff", async () => {
    // Provision a compiled artifact for the target just for this run. The prose
    // references a real workspace file so it grounds cleanly (no stale banner).
    // knowledge/ is uncommitted, so it may not exist in a fresh CI checkout —
    // create it if needed and remove whatever we created in the finally.
    const knowledgeDir = path.join(CONTROL_REPO, "knowledge");
    const artifactPath = path.join(knowledgeDir, "demo-ts-service.md");
    if (existsSync(artifactPath)) throw new Error("unexpected pre-existing artifact — test would clobber it");
    const knowledgeDirPreexisted = existsSync(knowledgeDir);
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(
      artifactPath,
      ["---", "sha: " + "c".repeat(40), "grounding_ratio: 1", "---", "", "The service centers on src/userService.ts.", ""].join("\n"),
    );
    const artifactsRoot = tmpArtifacts();
    try {
      const result = await run({
        controlRepo: CONTROL_REPO,
        taskPath: TASK_001,
        repoName: "demo-ts-service",
        local: true,
        dryRun: true,
        engine: "mock",
        mockPatch: GOOD_PATCH,
        ledgerPath: tmpLedger(),
        artifactsRoot,
        log: quiet,
      });

      expect(result.status).toBe("approved");

      // The compiled artifact was injected into the workspace as a root dotfile...
      const injected = readFileSync(path.join(result.workspace, ".fleet-knowledge.md"), "utf8");
      expect(injected).toContain("# Target knowledge — demo-ts-service");
      expect(injected).toContain("The service centers on src/userService.ts.");

      // ...archived per run as its own evidence, byte-identical to what shipped...
      const runDir = path.join(artifactsRoot, "runs", result.runId);
      expect(readFileSync(path.join(runDir, ".fleet-knowledge.md"), "utf8")).toBe(injected);

      // ...and never reaches the reviewable diff, so a scoped run can't trip on it.
      expect(result.diff).not.toContain(".fleet-knowledge.md");
      expect(readFileSync(path.join(result.artifactsDir, "diff.patch"), "utf8")).not.toContain(".fleet-knowledge.md");
    } finally {
      rmSync(artifactPath, { force: true });
      // Only tear down knowledge/ if this test created it (CI); never touch a
      // developer's populated dir.
      if (!knowledgeDirPreexisted) rmSync(knowledgeDir, { recursive: true, force: true });
    }
  });

  it("records a run as local even under GitHub Actions — the cloud entry point is gone", async () => {
    const ledgerPath = tmpLedger();
    // ADR-0024 deleted the only way to start a cloud run, so nothing this code
    // path writes may claim cloud provenance. Actions still runs the test
    // suite, so the env var is present and must no longer mean anything.
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
      ledgerPath,
      artifactsRoot: tmpArtifacts(),
      log: quiet,
    });

    expect(result.status).toBe("approved");
    const [entry] = readLedger(ledgerPath);
    expect(entry.mode).toBe("local");
    expect(entry.actionsRunId).toBeUndefined();
    expect(entry.actionsArtifact).toBeUndefined();
  });

  it("live state: the run publishes its stage as it goes, and clears it when it lands", async () => {
    const ledgerPath = tmpLedger();
    // With the judge gone the engine is the only stub that gets to look at the
    // world mid-run, and it looks from inside the agent stage.
    const seen: InflightRecord[] = [];
    const engineOverride = {
      run: () => {
        seen.push(...readInflight(ledgerPath));
        return {
          resultText: "NO_CHANGES_NEEDED",
          sessionId: "stub",
          transcript: "{}",
          usage: unavailableProducerUsage("stub engine"),
        };
      },
    };

    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: TASK_001,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engineOverride,
      ledgerPath,
      artifactsRoot: tmpArtifacts(),
      log: quiet,
    });

    expect(result.status).toBe("no-changes");
    // When the engine looked, exactly one record was in flight — this
    // process's — and it said "agent", on the run's only pass.
    expect(seen).toHaveLength(1);
    expect(seen.map((r) => [r.stage, r.pass])).toEqual([["agent", 1]]);
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
      ledgerPath,
      artifactsRoot: tmpArtifacts(),
      log: quiet,
    });

    expect(result.status).toBe("scope-violation");
    expect(result.verify).toBeUndefined();
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

    // …and it leaves a retained kill behind, in the store nothing prunes: the
    // diff by itself, the artefact that killed it one directory down, and no
    // outcome — nobody has re-adjudicated this yet (ADR-0015). The ledger line
    // above keeps only the first five offenders; this keeps all of them.
    const kill = killStore(ledgerPath, result.runId);
    expect(readFileSync(path.join(kill, "diff.patch"), "utf8")).toBe(
      readFileSync(path.join(result.artifactsDir, "diff.patch"), "utf8"),
    );
    expect(JSON.parse(readFileSync(path.join(kill, "why", "scope-violation.json"), "utf8"))).toEqual(violation);
    expect(readdirSync(kill).sort()).toEqual(["diff.patch", "why"]);
  });

  // The whole gates path in one place: frontmatter parse, the mandated-vs-
  // executed comparison, the composed state, and the wire field — proven by
  // what a real run records rather than by reaching into the pieces.
  it("gate mandate unmet: ships approved, but records inconclusive and names the gate", async () => {
    const ledgerPath = tmpLedger();
    vi.stubEnv("GITHUB_ACTIONS", "");
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: GATES_UNMET_TASK,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: GOOD_PATCH,
      ledgerPath,
      artifactsRoot: tmpArtifacts(),
      log: quiet,
    });

    // Non-blocking: an unmet mandate must never turn a good diff into a
    // discarded run, or declaring a gate would be dangerous and authors would
    // stop. What is unproven is the verification, not the run.
    expect(result.status).toBe("approved");
    // Verification itself is untouched — it ran what this repo offers, and that
    // passed. The mandate is the runner's business, not verification's.
    expect(result.verify?.state).toBe("passed");
    expect(result.unmetGates).toEqual(["live-contract-check"]);

    // The composed state is what reaches the wire, and it is not a passthrough.
    const entries = readLedger(ledgerPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("approved");
    expect(entries[0].verifyState).toBe("inconclusive");
    expect(entries[0].unmetGates).toEqual(["live-contract-check"]);
    expect(entries[0].evidence?.[0]).not.toContain("all green");
    expect(entries[0].evidence?.[0]).toContain("live-contract-check");

    // The co-sign body may not claim a verified change, and must say which
    // gate is missing — it sits directly above the ask to sign.
    const preview = readFileSync(path.join(result.artifactsDir, "pr-preview.md"), "utf8");
    expect(preview).not.toContain("Nothing reviewed the change for intent");
    expect(preview).toContain("live-contract-check");

    // And the judge was told in prose, since its whole input is the task, the
    // diff, and this summary.
    expect(result.verify?.summary).toContain("GATES UNMET");
    expect(result.verify?.summary).toContain("live-contract-check");
  });

  // ADR-0014, end to end and on both sides of the licence. One patch does the
  // thing the rule exists for — it removes a behaviour from the source *and*
  // rewrites the assertion that would have caught it — and the two tasks differ
  // only in whether they amend the file that judges the change.
  it("un-amended gate input: the base assertion runs against the shipped source, and kills it", async () => {
    const ledgerPath = tmpLedger();
    vi.stubEnv("GITHUB_ACTIONS", "");
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: UNAMENDED_TASK,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: SCOREBOARD_PATCH,
      ledgerPath,
      artifactsRoot: tmpArtifacts(),
      log: quiet,
    });

    // The whole point: without the rule this run is green, because the weakened
    // test is the one that would have run. The verification tree took that file
    // from the base, so the question asked was whether the shipped source
    // satisfies the gate the agent inherited — and it does not.
    expect(result.status).toBe("verify-failed");
    expect(result.verify?.state).toBe("failed");
    // Named in the failure: the test that ran is the one this diff rewrote away.
    expect(result.verify?.summary).toContain("rejects on non-2xx responses");
    expect(result.gateInputs?.held).toEqual(["test/http.test.ts"]);
    expect(result.gateInputs?.carried).toEqual([]);

    // The edit still shipped in the diff. It simply was not part of what proved
    // the change — "stays in the diff" is a claim about the diff, never a
    // promise about the run.
    expect(result.diff).toContain("test/http.test.ts");
    expect(result.diff).toContain("returns the body whatever the status is");

    const entries = readLedger(ledgerPath);
    expect(entries[0].heldGateInputs).toEqual(["test/http.test.ts"]);
    expect(entries[0].amendments).toBeUndefined();

    // And the judge, whose whole view of verification is this summary, is told.
    expect(result.verify?.summary).toContain("GATE INPUTS HELD AT THE BASE");
  });

  // ADR-0021, end to end, on the case ADR-0014 got wrong: the diff is one new
  // test file and nothing else. Held, it would have been deleted from the tree,
  // the base suite would have gone green over none of the change, and the run
  // would have shipped a `passed` that proved nothing. Carried, the new test
  // actually runs.
  it("added gate input: a test the base never had is carried, and it runs", async () => {
    const ledgerPath = tmpLedger();
    vi.stubEnv("GITHUB_ACTIONS", "");
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: ADDED_GATE_INPUT_TASK,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: NEW_TEST_PATCH,
      ledgerPath,
      artifactsRoot: tmpArtifacts(),
      log: quiet,
    });

    expect(result.status).toBe("approved");
    // A real pass, not the vacuous one: the tree contains the change, so this
    // green is about the diff in front of the reviewer.
    expect(result.verify?.state).toBe("passed");
    expect(result.gateInputs?.introduced).toEqual(["test/timeout.test.ts"]);
    expect(result.gateInputs?.held).toEqual([]);
    expect(result.gateInputs?.treeIsBase).toBe(false);
    // No licence was needed and none was recorded — the ledger's gate-input
    // fields carry what went unproven and what was licensed, and this is
    // neither.
    const entries = readLedger(ledgerPath);
    expect(entries[0].heldGateInputs).toBeUndefined();
    expect(entries[0].amendments).toBeUndefined();

    // All three of the target's checks ran, over a tree that has the new file
    // in it. That the file is physically there is proved one level down, where
    // the tree can be read — `verification-tree.test.ts` opens it. The summary
    // names checks, not tests, so it cannot carry that claim and is not asked to.
    expect(result.verify?.summary).toContain("npm run test passed");

    // Reported to the judge and to the reviewer as a fact about the evidence,
    // not as a warning: the files ran, and what they prove is what they assert.
    expect(result.verify?.summary).toContain("GATE INPUTS THIS CHANGE ADDS");
    const preview = readFileSync(path.join(result.artifactsDir, "pr-preview.md"), "utf8");
    expect(preview).toContain("Gate input added by this change");
    expect(preview).toContain("`test/timeout.test.ts`");
    // The banner is the ordinary one: nothing here was left unverified.
    expect(preview).toContain("Nothing reviewed the change for intent");
    expect(preview).not.toContain("held at the base");
  });

  it("amended gate input: the licence carries it, and the reason reaches every surface", async () => {
    const ledgerPath = tmpLedger();
    vi.stubEnv("GITHUB_ACTIONS", "");
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: AMENDS_TASK,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: SCOREBOARD_PATCH,
      ledgerPath,
      artifactsRoot: tmpArtifacts(),
      log: quiet,
    });

    // Same patch, same target, opposite fate — because the control repo, which
    // the agent cannot write, licensed this one. A legitimate test-fixing task
    // is not a task class this rule deletes.
    expect(result.status).toBe("approved");
    expect(result.verify?.state).toBe("passed");
    expect(result.gateInputs?.held).toEqual([]);
    expect(result.gateInputs?.carried).toEqual([
      {
        glob: "test/**",
        reason: "the assertion pinned a behaviour this task deliberately removes",
        files: ["test/http.test.ts"],
      },
    ]);

    // The three surfaces ADR-0014 names, each carrying the reason rather than
    // only the glob.
    const entries = readLedger(ledgerPath);
    expect(entries[0].amendments).toEqual([
      { glob: "test/**", reason: "the assertion pinned a behaviour this task deliberately removes" },
    ]);
    expect(entries[0].heldGateInputs).toBeUndefined();

    const preview = readFileSync(path.join(result.artifactsDir, "pr-preview.md"), "utf8");
    expect(preview).toContain("**Gate inputs**");
    expect(preview).toContain("the assertion pinned a behaviour this task deliberately removes");

    expect(result.verify?.summary).toContain("GATE INPUTS CARRIED UNDER AN AMENDMENT");
    expect(result.verify?.summary).not.toContain("HELD AT THE BASE");
  });

  it("gate mandate met: the run keeps the green it earned, with nothing outstanding", async () => {
    const ledgerPath = tmpLedger();
    vi.stubEnv("GITHUB_ACTIONS", "");
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: GATES_MET_TASK,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: GOOD_PATCH,
      ledgerPath,
      artifactsRoot: tmpArtifacts(),
      log: quiet,
    });

    expect(result.status).toBe("approved");
    expect(result.unmetGates).toEqual([]);

    const entries = readLedger(ledgerPath);
    expect(entries[0].verifyState).toBe("passed");
    // Omitted, not empty: a met mandate leaves nothing outstanding, and no
    // surface should render an unmet-gate affordance for it.
    expect(entries[0].unmetGates).toBeUndefined();
    expect(entries[0].evidence?.[0]).toContain("all green");

    const preview = readFileSync(path.join(result.artifactsDir, "pr-preview.md"), "utf8");
    expect(preview).toContain("Nothing reviewed the change for intent");
    expect(result.verify?.summary).not.toContain("GATES UNMET");
  });

  it("negative path: broken change → verify red → no PR, no verdict", async () => {
    const ledgerPath = tmpLedger();
    const result = await run({
      controlRepo: CONTROL_REPO,
      taskPath: TASK_001,
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: BAD_PATCH,
      ledgerPath,
      artifactsRoot: tmpArtifacts(),
      log: quiet,
    });

    expect(result.status).toBe("verify-failed");
    expect(result.verify?.state).toBe("failed");
    expect(result.verify?.summary).toContain("VERIFY FAILED");
    // Verification stops at the first failing check; the broken change trips
    // eslint (unused var) before tsc even runs — either error is fine.
    expect(result.verify?.summary).toMatch(/error/);
    expect(result.verify?.summary).toContain("userService.ts");
    expect(existsSync(path.join(result.artifactsDir, "verdict.json"))).toBe(false);

    // Retained: the whole verify log, not the ledger's first-failed-check
    // projection capped at 8 lines (ADR-0015).
    const kill = killStore(ledgerPath, result.runId);
    expect(readFileSync(path.join(kill, "why", "verify.log"), "utf8")).toBe(result.verify?.summary);
    expect(readFileSync(path.join(kill, "diff.patch"), "utf8")).toContain("userService.ts");
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
      ledgerPath: tmpLedger(),
      artifactsRoot: tmpArtifacts(),
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
      ledgerPath: tmpLedger(),
      artifactsRoot: tmpArtifacts(),
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
