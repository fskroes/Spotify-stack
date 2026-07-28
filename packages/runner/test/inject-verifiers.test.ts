import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectAgentConfig } from "../src/workspace.js";
import type { VerifierCheck } from "../src/verifiers.js";

const CONTROL_REPO = path.resolve(__dirname, "..", "..", "..");

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "inject-verifiers-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * A registered verifier reaches the agent's session as a JSON env var
 * substituted into two templates at once — a JSON file and a JS file. The
 * payload is double-encoded so one substitution is valid in both, which is
 * exactly the kind of thing that silently produces an unparseable config.
 * These tests parse the real injected artifacts rather than trusting the shape.
 */
const probe: VerifierCheck = {
  name: "ai-contract",
  label: "contract probe",
  command: "scripts/probe.sh",
  args: ["--strict"],
};

const inject = (registered?: VerifierCheck[]) =>
  injectAgentConfig({ controlRepo: CONTROL_REPO, workspace, registered });

const mcpConfig = () =>
  JSON.parse(readFileSync(path.join(workspace, ".claude", "mcp-config.json"), "utf8"));

const hookSource = () =>
  readFileSync(path.join(workspace, ".claude", "hooks", "stop-verify.mjs"), "utf8");

describe("injecting registered verifiers into the agent session", () => {
  it("writes a valid MCP config carrying the checks as a JSON string", () => {
    inject([probe]);

    const env = mcpConfig().mcpServers.verify.env;
    expect(typeof env.VERIFY_REGISTERED).toBe("string");
    expect(JSON.parse(env.VERIFY_REGISTERED)).toEqual([probe]);
  });

  it("writes an empty list when the target registered nothing", () => {
    inject();

    expect(JSON.parse(mcpConfig().mcpServers.verify.env.VERIFY_REGISTERED)).toEqual([]);
  });

  it("leaves no unsubstituted placeholder in either template", () => {
    inject([probe]);

    expect(JSON.stringify(mcpConfig())).not.toContain("__REGISTERED_VERIFIERS__");
    expect(hookSource()).not.toContain("__REGISTERED_VERIFIERS__");
  });

  it("produces a Stop hook that is still syntactically valid JavaScript", () => {
    inject([probe]);

    // The hook is injected, not imported, so nothing else would catch a syntax
    // error from a badly-escaped payload until a real run failed to stop.
    expect(() =>
      execFileSync(process.execPath, ["--check", path.join(workspace, ".claude", "hooks", "stop-verify.mjs")]),
    ).not.toThrow();
  });

  it("survives a command containing quotes and backslashes", () => {
    // A bespoke check's command is hand-written prose in a YAML file; it will
    // eventually contain something that breaks naive string substitution.
    const awkward: VerifierCheck = {
      name: "awkward",
      label: 'say "hi"',
      command: "sh",
      args: ["-c", 'echo "a\\b" \'c\''],
    };
    inject([awkward]);

    expect(JSON.parse(mcpConfig().mcpServers.verify.env.VERIFY_REGISTERED)).toEqual([awkward]);
    expect(() =>
      execFileSync(process.execPath, ["--check", path.join(workspace, ".claude", "hooks", "stop-verify.mjs")]),
    ).not.toThrow();
  });

  it("hands the Stop hook the same payload it gives the MCP server", () => {
    // The in-session gate and the tool the agent calls must agree; a hook that
    // ran a smaller set would let the agent stop on an unproven change.
    inject([probe]);

    expect(hookSource()).toContain(JSON.stringify(JSON.stringify([probe])));
  });
});
