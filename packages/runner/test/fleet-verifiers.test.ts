import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFleet } from "../src/fleet.js";

const savedOwner = process.env.GH_OWNER;

beforeEach(() => {
  process.env.GH_OWNER = "acme";
});

afterEach(() => {
  if (savedOwner === undefined) delete process.env.GH_OWNER;
  else process.env.GH_OWNER = savedOwner;
});

function control(reposYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-verifiers-"));
  mkdirSync(join(dir, "fleet"));
  writeFileSync(join(dir, "fleet", "repos.yaml"), reposYaml);
  return dir;
}

const withVerifiers = (block: string) =>
  `repos:\n  - name: demo\n    url: https://github.com/\${GH_OWNER}/demo\n    language: swift\n    default_branch: main\n${block}`;

describe("loadFleet — registered verifiers (ADR-0009)", () => {
  it("carries a target's verifiers through the load", () => {
    const repos = loadFleet(
      control(
        withVerifiers(
          "    verifiers:\n" +
            "      - name: ai-contract\n" +
            "        label: scripts/validate-ai-cli.sh\n" +
            "        command: scripts/validate-ai-cli.sh\n" +
            "        requiresEnv: [CLAUDE_BIN]\n" +
            "        cost: billed\n",
        ),
      ),
    );

    expect(repos[0].verifiers).toEqual([
      {
        name: "ai-contract",
        label: "scripts/validate-ai-cli.sh",
        command: "scripts/validate-ai-cli.sh",
        requiresEnv: ["CLAUDE_BIN"],
        cost: "billed",
      },
    ]);
  });

  it("leaves verifiers undefined for a target that registered none", () => {
    expect(loadFleet(control(withVerifiers(""))).at(0)?.verifiers).toBeUndefined();
  });

  it("refuses to load a registry whose verifier shadows a detected check", () => {
    // Load-time, not verify-time: a registry that could produce a false green
    // must not be usable at all, including by commands that never verify.
    const dir = control(
      withVerifiers("    verifiers:\n      - name: test\n        command: 'true'\n"),
    );

    expect(() => loadFleet(dir)).toThrow(/shadow/i);
  });

  it("names the offending target, since the registry holds many", () => {
    const dir = control(
      withVerifiers("    verifiers:\n      - name: tsc\n        command: 'true'\n"),
    );

    expect(() => loadFleet(dir)).toThrow(/demo/);
  });

  it("refuses a verifier with no command", () => {
    const dir = control(withVerifiers("    verifiers:\n      - name: probe\n"));

    expect(() => loadFleet(dir)).toThrow(/command/i);
  });
});
