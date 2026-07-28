/**
 * Hermetic end-to-end proof that a *registered* verifier (ADR-0009) is a real
 * gate: it executes inside the run, and a task mandating it comes out met.
 *
 * The unit tests cover eligibility and composition in isolation. This one
 * covers the claim that actually matters — that mandating a registered check
 * cannot yield a false green, and that an ineligible one degrades to
 * `inconclusive` rather than to a pass.
 *
 * It builds a throwaway control repo whose registry declares the verifier,
 * symlinking the real agent-config/, demo-repos/ and packages/ so the run is
 * the genuine code path with a different registry.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readLedger } from "../src/ledger.js";
import { run } from "../src/run.js";

const REAL_CONTROL_REPO = path.resolve(__dirname, "..", "..", "..");
const GOOD_PATCH = path.join(__dirname, "fixtures", "001-good.patch");
const quiet = () => {};

beforeAll(() => {
  const demo = path.join(REAL_CONTROL_REPO, "demo-repos", "demo-ts-service");
  if (!existsSync(path.join(demo, "node_modules"))) {
    execFileSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: demo });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A control repo that is real everywhere except its registry. */
function controlRepoWith(verifiersYaml: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-registered-"));
  for (const shared of ["agent-config", "demo-repos", "packages", "node_modules"]) {
    symlinkSync(path.join(REAL_CONTROL_REPO, shared), path.join(dir, shared));
  }
  mkdirSync(path.join(dir, "fleet"));
  writeFileSync(
    path.join(dir, "fleet", "repos.yaml"),
    "repos:\n" +
      "  - name: demo-ts-service\n" +
      "    url: https://github.com/acme/demo-ts-service\n" +
      "    language: typescript\n" +
      "    default_branch: main\n" +
      verifiersYaml,
  );
  return dir;
}

function taskFile(dir: string, gates: string): string {
  const file = path.join(dir, "task.md");
  writeFileSync(
    file,
    `---\nid: 001-ts-migrate-http-client\ntitle: Migrate to the shared http client\ntargets: [demo-ts-service]\ngates: [${gates}]\nrisk: drudgery\n---\n\nMigrate the service to the shared client.\n`,
  );
  return file;
}

const tmpLedger = () => path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-reg-ledger-")), "ledger.jsonl");

const runWith = (controlRepo: string, taskPath: string, ledgerPath: string) =>
  run({
    controlRepo,
    taskPath,
    repoName: "demo-ts-service",
    local: true,
    dryRun: true,
    engine: "mock",
    mockPatch: GOOD_PATCH,
    judgeMode: "approve",
    ledgerPath,
    log: quiet,
  });

describe("registered verifiers end-to-end", () => {
  it("runs a registered check and meets the gate that mandated it", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    const controlRepo = controlRepoWith(
      "    verifiers:\n" +
        "      - name: contract-probe\n" +
        "        label: contract probe\n" +
        "        command: node\n" +
        "        args: ['-e', 'process.exit(0)']\n",
    );
    const ledgerPath = tmpLedger();

    const result = await runWith(controlRepo, taskFile(controlRepo, "contract-probe"), ledgerPath);

    expect(result.status).toBe("approved");
    // The gate is met because the check actually ran — not because the runner
    // was told to treat the name as satisfied.
    expect(result.unmetGates).toEqual([]);
    expect(result.verify?.state).toBe("passed");
    expect(result.verify?.checks.map((c) => c.name)).toContain("contract-probe");
    expect(readLedger(ledgerPath)[0].verifyState).toBe("passed");
  });

  it("fails the run when the registered check fails, with no PR", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    const controlRepo = controlRepoWith(
      "    verifiers:\n" +
        "      - name: contract-probe\n" +
        "        label: contract probe\n" +
        "        command: node\n" +
        "        args: ['-e', 'process.exit(1)']\n",
    );

    const result = await runWith(controlRepo, taskFile(controlRepo, "contract-probe"), tmpLedger());

    expect(result.status).toBe("verify-failed");
    expect(result.prUrl).toBeUndefined();
  });

  it("records inconclusive — never a pass — when a required env var is absent", async () => {
    // The whole point of ineligibility: the operator's missing credential must
    // not redden a good diff, and must not green an unproven one either.
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("FLEET_TEST_PROBE_TOKEN", "");
    const controlRepo = controlRepoWith(
      "    verifiers:\n" +
        "      - name: contract-probe\n" +
        "        command: node\n" +
        "        args: ['-e', 'process.exit(0)']\n" +
        "        requiresEnv: [FLEET_TEST_PROBE_TOKEN]\n",
    );
    const ledgerPath = tmpLedger();

    const result = await runWith(controlRepo, taskFile(controlRepo, "contract-probe"), ledgerPath);

    expect(result.status).toBe("approved");
    expect(result.unmetGates).toEqual(["contract-probe"]);
    expect(result.verify?.checks.map((c) => c.name)).not.toContain("contract-probe");
    expect(readLedger(ledgerPath)[0].verifyState).toBe("inconclusive");
    expect(result.verify?.summary).toContain("GATES UNMET");
  });

  it("does not run a billed verifier the task never mandated", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    const controlRepo = controlRepoWith(
      "    verifiers:\n" +
        "      - name: contract-probe\n" +
        "        command: node\n" +
        "        args: ['-e', 'process.exit(1)']\n" +
        "        cost: billed\n",
    );

    // The probe would fail if it ran; mandating only `test` must leave it alone.
    const result = await runWith(controlRepo, taskFile(controlRepo, "test"), tmpLedger());

    expect(result.status).toBe("approved");
    expect(result.verify?.checks.map((c) => c.name)).not.toContain("contract-probe");
  });

  it("refuses to run at all when the registry shadows a detected check", async () => {
    const controlRepo = controlRepoWith(
      "    verifiers:\n      - name: test\n        command: 'true'\n",
    );

    await expect(runWith(controlRepo, taskFile(controlRepo, "test"), tmpLedger())).rejects.toThrow(/shadow/i);
  });
});
