import { describe, expect, it } from "vitest";
import { eligibleVerifiers, validateVerifiers, type RegisteredVerifier } from "../src/verifiers.js";

const probe: RegisteredVerifier = {
  name: "ai-contract",
  label: "scripts/validate-ai-cli.sh",
  command: "scripts/validate-ai-cli.sh",
};

describe("validateVerifiers", () => {
  it("accepts a well-formed entry", () => {
    expect(() => validateVerifiers("target", [probe])).not.toThrow();
  });

  it("rejects a name that shadows a detected check", () => {
    // ADR-0009: allowing the override would make `test: {command: "true"}` a
    // one-line false green. A collision is a load-time error, never a silent win.
    expect(() => validateVerifiers("target", [{ ...probe, name: "test" }])).toThrow(/shadow/i);
  });

  it("rejects a name that shadows a nested-workspace check", () => {
    // Nested checks are suffixed (`test:web`); the suffix must not be an escape
    // hatch around the shadowing rule.
    expect(() => validateVerifiers("target", [{ ...probe, name: "test:web" }])).toThrow(/shadow/i);
  });

  it("rejects two entries with the same name", () => {
    expect(() => validateVerifiers("target", [probe, { ...probe, command: "other" }])).toThrow(/duplicate/i);
  });

  it("rejects an entry with no command", () => {
    expect(() => validateVerifiers("target", [{ name: "x" } as RegisteredVerifier])).toThrow(/command/i);
  });

  it("names the target in the error, since the registry holds many", () => {
    expect(() => validateVerifiers("some-repo", [{ ...probe, name: "tsc" }])).toThrow(/some-repo/);
  });
});

describe("eligibleVerifiers", () => {
  it("returns a Check the runner can hand to verification unchanged", () => {
    const [check] = eligibleVerifiers([{ ...probe, args: ["--fast"], cwd: "sub" }], { env: {}, gates: undefined });

    expect(check).toEqual({
      name: "ai-contract",
      label: "scripts/validate-ai-cli.sh",
      command: "scripts/validate-ai-cli.sh",
      args: ["--fast"],
      cwd: "sub",
    });
  });

  it("defaults label to the name and args to empty", () => {
    const [check] = eligibleVerifiers([{ name: "probe", command: "./probe" }], { env: {}, gates: undefined });

    expect(check).toMatchObject({ name: "probe", label: "probe", args: [] });
  });

  describe("a missing prerequisite makes a verifier ineligible, not failing", () => {
    const needsEnv: RegisteredVerifier = { ...probe, requiresEnv: ["CLAUDE_BIN"] };

    it("drops the verifier when a required variable is absent", () => {
      expect(eligibleVerifiers([needsEnv], { env: {}, gates: undefined })).toEqual([]);
    });

    it("keeps it when every required variable is present", () => {
      expect(eligibleVerifiers([needsEnv], { env: { CLAUDE_BIN: "/bin/claude" }, gates: undefined })).toHaveLength(1);
    });

    it("treats an empty string as absent — an exported-but-blank var proves nothing", () => {
      expect(eligibleVerifiers([needsEnv], { env: { CLAUDE_BIN: "" }, gates: undefined })).toEqual([]);
    });

    it("stays ineligible even when a task mandates it, so the gate reads unmet", () => {
      // The whole point: mandating a check may not conjure the credential.
      // Ineligible + mandated is exactly the unmet-gate/inconclusive path.
      expect(eligibleVerifiers([needsEnv], { env: {}, gates: ["ai-contract"] })).toEqual([]);
    });
  });

  describe("a billed verifier runs only when mandated", () => {
    const billed: RegisteredVerifier = { ...probe, cost: "billed" };

    it("does not run on an ordinary dispatch", () => {
      expect(eligibleVerifiers([billed], { env: {}, gates: undefined })).toEqual([]);
    });

    it("runs when the task's gates name it", () => {
      expect(eligibleVerifiers([billed], { env: {}, gates: ["ai-contract"] })).toHaveLength(1);
    });

    it("does not run when the gates name a different check", () => {
      expect(eligibleVerifiers([billed], { env: {}, gates: ["test"] })).toEqual([]);
    });

    it("runs a free verifier whether or not it is mandated", () => {
      expect(eligibleVerifiers([{ ...probe, cost: "free" }], { env: {}, gates: undefined })).toHaveLength(1);
      expect(eligibleVerifiers([probe], { env: {}, gates: ["something-else"] })).toHaveLength(1);
    });
  });

  it("applies both filters together — billed, mandated, but missing its env", () => {
    const both: RegisteredVerifier = { ...probe, cost: "billed", requiresEnv: ["CLAUDE_BIN"] };

    expect(eligibleVerifiers([both], { env: {}, gates: ["ai-contract"] })).toEqual([]);
    expect(eligibleVerifiers([both], { env: { CLAUDE_BIN: "/x" }, gates: ["ai-contract"] })).toHaveLength(1);
  });

  it("returns nothing for a target that registered none", () => {
    expect(eligibleVerifiers(undefined, { env: {}, gates: ["test"] })).toEqual([]);
  });
});
