import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRegisteredFromEnv, runVerify } from "../src/verify.js";

/**
 * Registered verifiers (ADR-0009) reach verification as ordinary Checks. This
 * package never learns about the fleet registry — the runner composes the list
 * and hands it over, which keeps `detect()` target-blind. These tests therefore
 * pass Checks directly, exactly as the runner does.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "registered-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pkg(scripts: Record<string, string>): void {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", scripts }));
  mkdirSync(path.join(dir, "node_modules"));
}

const passing = { name: "probe", label: "contract probe", command: "node", args: ["-e", "process.exit(0)"] };
const failing = { name: "probe", label: "contract probe", command: "node", args: ["-e", "process.exit(1)"] };

describe("runVerify with registered checks", () => {
  it("runs a registered check alongside the detected ones", async () => {
    pkg({ test: 'node -e "process.exit(0)"' });

    const result = await runVerify(dir, { registered: [passing] });

    expect(result.state).toBe("passed");
    expect(result.checks.map((c) => c.name)).toEqual(["test", "probe"]);
  });

  it("fails the run when a registered check fails", async () => {
    pkg({ test: 'node -e "process.exit(0)"' });

    const result = await runVerify(dir, { registered: [failing] });

    expect(result.state).toBe("failed");
    expect(result.checks.find((c) => c.name === "probe")?.status).toBe("failed");
  });

  it("is a real verification even when nothing was detected", async () => {
    // A target the detectors know nothing about is exactly the case ADR-0009
    // exists for: registration turns a permanently inconclusive repo into one
    // that can actually be proven.
    const result = await runVerify(dir, { registered: [passing] });

    expect(result.state).toBe("passed");
    expect(result.summary).not.toContain("VERIFY INCONCLUSIVE");
  });

  it("still reports inconclusive when neither detection nor registration supplied a check", async () => {
    const result = await runVerify(dir, { registered: [] });

    expect(result.state).toBe("inconclusive");
  });

  it("runs registered checks last, so a detected failure short-circuits a billed probe", async () => {
    // Ordering is load-bearing, not cosmetic: registered checks are the ones
    // that may cost money, so they must not run when a cheap detected check has
    // already condemned the diff.
    pkg({ test: 'node -e "process.exit(1)"' });

    const result = await runVerify(dir, { registered: [passing] });

    expect(result.state).toBe("failed");
    expect(result.checks.find((c) => c.name === "probe")?.status).toBe("skipped");
  });

  it("refuses a registered check that collides with a detected one", async () => {
    // The load-time rule in the runner already rejects this, but detection is
    // per-workspace: a nested workspace can produce a name the registry could
    // not have known about. Failing loudly here keeps the shadowing rule true
    // in the one place where both halves are actually present.
    pkg({ test: 'node -e "process.exit(0)"' });

    await expect(runVerify(dir, { registered: [{ ...passing, name: "test" }] })).rejects.toThrow(/shadow/i);
  });

  it("runs a registered check in its declared cwd, relative to the workspace", async () => {
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "marker"), "");

    const result = await runVerify(dir, {
      registered: [
        {
          name: "probe",
          label: "probe",
          command: "node",
          args: ["-e", 'process.exit(require("node:fs").existsSync("marker") ? 0 : 1)'],
          cwd: "sub",
        },
      ],
    });

    expect(result.state).toBe("passed");
  });

  it("behaves exactly as before when no registered checks are passed", async () => {
    pkg({ test: 'node -e "process.exit(0)"' });

    expect((await runVerify(dir)).checks.map((c) => c.name)).toEqual(["test"]);
  });
});

describe("readRegisteredFromEnv", () => {
  it("reads the runner's JSON payload", () => {
    expect(readRegisteredFromEnv({ VERIFY_REGISTERED: JSON.stringify([passing]) })).toEqual([passing]);
  });

  it("returns nothing when the variable is unset — the ordinary case", () => {
    expect(readRegisteredFromEnv({})).toEqual([]);
  });

  it("returns nothing for an empty value", () => {
    expect(readRegisteredFromEnv({ VERIFY_REGISTERED: "" })).toEqual([]);
  });

  it("throws on a malformed payload rather than silently verifying less", () => {
    // Quietly dropping the checks would turn a runner bug into a verification
    // that looks complete and is not. Loud is the only safe direction here.
    expect(() => readRegisteredFromEnv({ VERIFY_REGISTERED: "{not json" })).toThrow(/VERIFY_REGISTERED/);
  });

  it("throws when the payload is well-formed JSON of the wrong shape", () => {
    expect(() => readRegisteredFromEnv({ VERIFY_REGISTERED: '{"name":"probe"}' })).toThrow(/VERIFY_REGISTERED/);
  });
});
