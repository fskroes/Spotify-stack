import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVerify } from "../src/verify.js";

// Real temp workspaces. The passing/failing cases use a package.json whose
// scripts are `node -e …` one-liners, so a real child process runs a real
// check without depending on an installed toolchain.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "verify-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pkg(scripts: Record<string, string>): void {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", scripts }));
  // Present so detect() doesn't prepend an install check to the run.
  mkdirSync(path.join(dir, "node_modules"));
}

describe("runVerify", () => {
  it("reports inconclusive — not a pass — when nothing was executed", async () => {
    const result = await runVerify(dir);

    expect(result.state).toBe("inconclusive");
    expect(result.checks).toEqual([]);
    // The honesty fix: an empty check set used to claim VERIFY PASSED.
    expect(result.summary).not.toContain("VERIFY PASSED");
    expect(result.summary).toContain("VERIFY INCONCLUSIVE");
    expect(result.summary).toContain("Nothing was executed");
  });

  it("passes when every detected check passes", async () => {
    pkg({ test: "node -e \"process.exit(0)\"" });

    const result = await runVerify(dir);

    expect(result.state).toBe("passed");
    expect(result.summary.startsWith("VERIFY PASSED")).toBe(true);
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([["vitest", "passed"]]);
  });

  it("fails at the first red check and records the rest as skipped, not passed", async () => {
    pkg({
      lint: "node -e \"console.log('boom'); process.exit(1)\"",
      test: "node -e \"process.exit(0)\"",
    });

    const result = await runVerify(dir);

    expect(result.state).toBe("failed");
    expect(result.summary.startsWith("VERIFY FAILED")).toBe(true);
    // A check that never ran is `skipped` in the data, not merely a line of
    // prose in the summary — surfaces must be able to say so from the field.
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([
      ["eslint", "failed"],
      ["vitest", "skipped"],
    ]);
    expect(result.checks.find((c) => c.name === "vitest")?.durationMs).toBe(0);
  });
});
