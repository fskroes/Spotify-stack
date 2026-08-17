/**
 * The end of a run's workspace lifecycle, through `run()` on the *real-run*
 * path — the branch the CLI takes, which no other suite reaches. Every other
 * hermetic test passes a `ledgerPath`, and that is exactly the seam
 * releaseWorkspace reads to recognise a test run, so those tests all take the
 * other branch.
 *
 * The control repo is a throwaway that symlinks the shared directories, so a run
 * with no `ledgerPath` writes its ledger, evidence, and artifacts inside the temp
 * dir instead of into the checkout. That is what makes it safe to exercise a run
 * that believes it is real.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { FleetRepo } from "../src/fleet.js";
import { run } from "../src/run.js";
import { constructVerificationTree } from "../src/verification-tree.js";
import { git, prepareWorkspace, stagedDiff } from "../src/workspace.js";
import { runVerify } from "@fleet/mcp-verify";

const REAL_CONTROL_REPO = path.resolve(__dirname, "..", "..", "..");
const GOOD_PATCH = path.join(__dirname, "fixtures", "001-good.patch");
const BAD_PATCH = path.join(__dirname, "fixtures", "001-bad.patch");
const quiet = () => {};

beforeAll(() => {
  const demo = path.join(REAL_CONTROL_REPO, "demo-repos", "demo-ts-service");
  if (!existsSync(path.join(demo, "node_modules"))) {
    execFileSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: demo });
  }
});

/** A control repo that is real everywhere except that it is disposable. */
function throwawayControlRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-release-e2e-"));
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
      "    default_branch: main\n",
  );
  const task = path.join(dir, "task.md");
  writeFileSync(
    task,
    "---\nid: 001-ts-migrate-http-client\ntitle: Migrate to the shared http client\n" +
      "targets: [demo-ts-service]\nrisk: drudgery\n---\n\nMigrate the service to the shared client.\n",
  );
  return dir;
}

/** A real run: no `ledgerPath`, so nothing marks it as a test. */
const realRun = (controlRepo: string, mockPatch: string) =>
  run({
    controlRepo,
    taskPath: path.join(controlRepo, "task.md"),
    repoName: "demo-ts-service",
    local: true,
    dryRun: true,
    engine: "mock",
    mockPatch,
    log: quiet,
  });

describe("a real run's workspace lifecycle", () => {
  it("releases the workspace and its tree once the verdict is green", async () => {
    const result = await realRun(throwawayControlRepo(), GOOD_PATCH);

    expect(result.status).toBe("approved");
    expect(result.verify?.state).toBe("passed");
    // The verdict is durable in the artifacts the run wrote, and the tree is a
    // pure function of the base and the diff it kept there. So neither directory
    // is evidence of anything, and neither survives.
    expect(existsSync(result.workspace)).toBe(false);
    expect(existsSync(`${result.workspace}.verify`)).toBe(false);
    expect(existsSync(path.join(result.artifactsDir, "diff.patch"))).toBe(true);
  });

  it("keeps both when verification goes red, because that tree is re-runnable", async () => {
    const lines: string[] = [];
    const controlRepo = throwawayControlRepo();
    const result = await run({
      controlRepo,
      taskPath: path.join(controlRepo, "task.md"),
      repoName: "demo-ts-service",
      local: true,
      dryRun: true,
      engine: "mock",
      mockPatch: BAD_PATCH,
      log: (line) => lines.push(line),
    });

    expect(result.verify?.state).toBe("failed");
    expect(existsSync(result.workspace)).toBe(true);
    expect(existsSync(`${result.workspace}.verify`)).toBe(true);
    // Named in the log, because a kept tree nobody can find is just disk. This
    // is the one line that tells the operator where to re-run the red verify.
    expect(lines.join("\n")).toContain(`kept the verification tree: ${result.workspace}.verify`);
  });
});

/**
 * The property the release policy rests on. Dropping a green tree is only safe
 * because the tree is a pure function of `(base commit, diff)` and a run keeps
 * both — so the verdict can be reproduced from what survives. If this ever fails,
 * the harness has a determinism defect and a green tree was evidence after all:
 * stop releasing them (releaseWorkspace) before chasing anything else.
 */
describe("a verification tree is a cache, not a record", () => {
  it("rebuilds from the same base and diff to the same verdict after deletion", async () => {
    const controlRepo = throwawayControlRepo();
    const workspace = prepareWorkspace({
      controlRepo,
      repo: {
        name: "demo-ts-service",
        url: "https://github.com/acme/demo-ts-service",
        language: "typescript",
        default_branch: "main",
      } as FleetRepo,
      taskId: "cache-proof",
      local: true,
    });

    // Stand in for the agent, leaving the run's two retained inputs behind.
    git(workspace, ["apply", "-"], readFileSync(GOOD_PATCH, "utf8"));
    const diff = stagedDiff(workspace);

    const verdict = async (tree: string): Promise<string> => {
      const result = (await runVerify(tree, { registered: [] })) as {
        state: string;
        checks: { name: string; status: string }[];
      };
      return JSON.stringify({
        state: result.state,
        checks: result.checks.map((c) => `${c.name}=${c.status}`).sort(),
      });
    };

    const first = constructVerificationTree({ workspace, diff, hold: [] });
    const before = await verdict(first.path);
    expect(before).toContain('"state":"passed"');

    rmSync(first.path, { recursive: true, force: true });
    expect(existsSync(first.path)).toBe(false);

    const second = constructVerificationTree({ workspace, diff, hold: [] });
    expect(second.base).toBe(first.base);
    expect(await verdict(second.path)).toBe(before);

    rmSync(workspace, { recursive: true, force: true });
    rmSync(second.path, { recursive: true, force: true });
  });
});
