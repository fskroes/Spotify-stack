import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JUDGE_READ_MARKER_ENV, JUDGE_READ_SERVER_NAME, JUDGE_READ_TOOLS, JUDGE_READ_WORKSPACE_ENV } from "@fleet/judge-read";
import { createCliJudgeClient, judge } from "../src/index.js";

/**
 * What the CLI judge is actually launched with.
 *
 * ADR-0011's cage is made of flags, and a flag is the kind of thing that stays
 * correct until someone reformats the array it lives in. These tests stand a
 * fake `claude` on PATH and read the argv it was handed, so the cage is
 * asserted rather than reviewed — no model, no network, no spend.
 */
let tmp: string;
let workspace: string;
let bin: string;
let argvFile: string;
let cwdFile: string;
let configCopy: string;
let markerPath: string;
let originalPath: string | undefined;

const VERDICT = {
  verdict: "approve",
  violations: [],
  guidance: "",
  rationale: "read src/app.js; the diff's claim holds.",
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cli-judge-"));
  workspace = path.join(tmp, "ws");
  bin = path.join(tmp, "bin");
  argvFile = path.join(tmp, "argv");
  cwdFile = path.join(tmp, "cwd");
  configCopy = path.join(tmp, "mcp-config.copy.json");
  markerPath = path.join(tmp, "judge-read-startup.json");
  mkdirSync(workspace);
  mkdirSync(bin);

  // A `claude` that records how it was called and prints a well-formed result
  // envelope. Paths are baked in rather than passed as env vars, so the harness
  // sees exactly the environment the judge client hands the real CLI.
  const fake = [
    "#!/bin/sh",
    `: > "${argvFile}"`,
    'previous=""',
    'for arg in "$@"; do',
    `  printf '%s\\0' "$arg" >> "${argvFile}"`,
    `  if [ "$previous" = "--mcp-config" ]; then cp "$arg" "${configCopy}"; fi`,
    "  previous=\"$arg\"",
    "done",
    `pwd > "${cwdFile}"`,
    `cat <<'ENVELOPE'`,
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(VERDICT) }),
    "ENVELOPE",
  ].join("\n");
  writeFileSync(path.join(bin, "claude"), `${fake}\n`);
  chmodSync(path.join(bin, "claude"), 0o755);

  originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(tmp, { recursive: true, force: true });
});

/** Run one judgement through the fake CLI and return how it was invoked. */
async function invoke(): Promise<{ argv: string[]; cwd: string; config: Record<string, any> }> {
  const verdict = await judge({
    taskMarkdown: "task",
    diff: "diff",
    verifySummary: "VERIFY PASSED",
    workspace,
    client: createCliJudgeClient({ workspace, markerPath }),
  });
  expect(verdict.verdict).toBe("approve");
  const argv = readFileSync(argvFile, "utf8").split("\0").slice(0, -1);
  return {
    argv,
    cwd: readFileSync(cwdFile, "utf8").trim(),
    config: JSON.parse(readFileSync(configCopy, "utf8")),
  };
}

/** The values a flag was given: everything up to the next `--flag`. */
function valuesOf(argv: string[], flag: string): string[] {
  const at = argv.indexOf(flag);
  expect(at, `${flag} was not passed`).toBeGreaterThanOrEqual(0);
  const rest = argv.slice(at + 1);
  const next = rest.findIndex((arg) => arg.startsWith("--"));
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the CLI judge's cage", () => {
  it("turns off every built-in tool, so the judge's only reach is what the runner handed it", async () => {
    // On its own this is the stopgap ADR-0011 rejected — symmetry bought by
    // giving up the catch class that matters. Alongside the read server below
    // it is the opposite: the flag that was the whole of the rejected option is
    // one component of the accepted one. Do not delete it after reading the ADR.
    const { argv } = await invoke();

    expect(valuesOf(argv, "--tools")).toEqual([""]);
  });

  it("points the judge at the read server, rooted at the workspace under review", async () => {
    const { config } = await invoke();

    const entry = config.mcpServers[JUDGE_READ_SERVER_NAME];
    expect(entry.env[JUDGE_READ_WORKSPACE_ENV]).toBe(workspace);
    expect(entry.args.some((arg: string) => arg.endsWith(path.join("judge-read", "src", "server.js")))).toBe(true);
  });

  it("tells the read server where to leave the startup marker the runner asserts", async () => {
    // This transport is the one that starts the server as a subprocess, and a
    // subprocess that never came up leaves a judge reviewing blind. The marker
    // is the only evidence that it did — a verdict cannot fake it, and a judge
    // whose diff needed no reads still leaves one behind (ADR-0011).
    const { config } = await invoke();

    expect(config.mcpServers[JUDGE_READ_SERVER_NAME].env[JUDGE_READ_MARKER_ENV]).toBe(markerPath);
  });

  it("keeps strict MCP config, which is what now holds the cage shut", async () => {
    // Decoration while no config was passed; the moment one is, it is what
    // keeps every other MCP server on the operator's machine out.
    const { argv } = await invoke();

    expect(argv).toContain("--strict-mcp-config");
  });

  it("allows exactly the read tools, derived from the shared surface", async () => {
    // The judge has no injected settings file the way the agent does, so
    // nothing else grants these. Derived, not typed out: a tool added to the
    // declaration is allowed without a second edit here.
    const { argv } = await invoke();

    expect(valuesOf(argv, "--allowedTools")).toEqual(
      JUDGE_READ_TOOLS.map((tool) => `mcp__${JUDGE_READ_SERVER_NAME}__${tool.name}`),
    );
  });

  it("runs in the workspace, not in the control repo", async () => {
    // A relative path in a tool argument must not be able to mean something in
    // the control repo — and the judge's own reads are rooted independently, so
    // this is the belt to that pair of braces.
    const { cwd } = await invoke();

    expect(realpathSync(cwd)).toBe(realpathSync(workspace));
  });

  it("loads no settings from the operator's machine or the workspace", async () => {
    // The workspace carries the *agent's* .claude/settings.json — an allowlist
    // written for a different actor and a Stop hook that runs the whole verify
    // suite. Inherited, the judge would run it again, on stop, on every verdict.
    const { argv } = await invoke();

    expect(valuesOf(argv, "--setting-sources")).toEqual([""]);
  });

  it("leaves no config behind once the verdict is in", async () => {
    const { argv } = await invoke();

    expect(existsSync(valuesOf(argv, "--mcp-config")[0])).toBe(false);
  });

  it("refuses to review one workspace through a client rooted at another", async () => {
    // The required field on JudgeInput proves a caller supplied a string. This
    // is what makes it mean the directory the judge actually reads: otherwise a
    // verdict could be recorded against a workspace the judge never opened.
    await expect(
      judge({
        taskMarkdown: "task",
        diff: "diff",
        verifySummary: "VERIFY PASSED",
        workspace: path.join(tmp, "some-other-workspace"),
        client: createCliJudgeClient({ workspace, markerPath }),
      }),
    ).rejects.toThrow(/rooted at a different directory/);
  });
});
