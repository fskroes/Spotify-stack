/**
 * The judge's read capability, checked at the seam where a run lives or dies.
 *
 * ADR-0011: a judge that cannot read fails the run rather than degrading to a
 * text-only review, because that degradation is undetectable afterwards — a
 * broken read tool and a diff that genuinely needed no reads both record zero
 * reads. The two runs below are exactly that pair. Both reach the judge, both
 * get back a clean `approve`, and neither reads anything; the only difference
 * is whether the read server ever started. One must ship and one must die.
 *
 * Hermetic: the engine is mocked, verification is real, and `claude` is a shell
 * script on PATH that prints a verdict envelope. It does not speak MCP — but it
 * does start the real read server out of the config it was handed, so the
 * marker under test is one the server itself wrote rather than a fixture
 * standing in for one.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readLedger } from "../src/ledger.js";
import { run } from "../src/run.js";

const CONTROL_REPO = path.resolve(__dirname, "..", "..", "..");
// Its own task, not the suite's shared one: a run's workspace and artifact
// directory are both named after the task, and vitest runs these files
// concurrently with the other end-to-end suites.
const TASK = path.join(__dirname, "fixtures", "judge-read-task.md");
const GOOD_PATCH = path.join(__dirname, "fixtures", "001-good.patch");

const VERDICT = {
  verdict: "approve",
  violations: [],
  guidance: "",
  rationale: "nothing in this diff needed a second opinion from the source.",
};

let tmp: string;
let originalPath: string | undefined;

beforeAll(() => {
  const demo = path.join(CONTROL_REPO, "demo-repos", "demo-ts-service");
  if (!existsSync(path.join(demo, "node_modules"))) {
    execFileSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: demo });
  }
});

/**
 * Stand a fake `claude` on PATH.
 *
 * @param wiresReadServer  Whether it acts like a CLI that starts the MCP server
 *   it was configured with. It does so by actually starting it — reading the
 *   launch out of the very config the judge client handed it, and running the
 *   real server to EOF, which is enough for the server to write its marker. The
 *   fake never speaks MCP; what it stands in for is the wiring, and the thing
 *   under test is what the *server's own* startup leaves behind. A `false` here
 *   is the failure this ticket exists for: a judge process that answers
 *   perfectly well while its reader never came up.
 */
function fakeClaude(wiresReadServer: boolean): void {
  const bin = path.join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  const launchReadServer =
    "const { spawnSync } = require('child_process');" +
    "const server = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).mcpServers.judge;" +
    // stdin closed: the stdio transport sees EOF and the server shuts itself
    // down, having already written the marker at startup.
    "spawnSync(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['ignore', 'ignore', 'inherit'], timeout: 30000 });";
  const script = [
    "#!/bin/sh",
    'previous=""',
    'for arg in "$@"; do',
    '  if [ "$previous" = "--mcp-config" ]; then config="$arg"; fi',
    '  previous="$arg"',
    "done",
    ...(wiresReadServer ? [`${JSON.stringify(process.execPath)} -e ${JSON.stringify(launchReadServer)} "$config"`] : []),
    "cat <<'ENVELOPE'",
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(VERDICT) }),
    "ENVELOPE",
  ].join("\n");
  writeFileSync(path.join(bin, "claude"), `${script}\n`);
  chmodSync(path.join(bin, "claude"), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
}

/** One dry run against the demo target, judged over the CLI transport. */
const judgedRun = () =>
  run({
    controlRepo: CONTROL_REPO,
    taskPath: TASK,
    repoName: "demo-ts-service",
    local: true,
    dryRun: true,
    engine: "mock",
    mockPatch: GOOD_PATCH,
    judgeMode: "cli",
    ledgerPath: path.join(tmp, "ledger.jsonl"),
    // Beside the ledger, and for the same reason: without it this run archives
    // into the control repo's `artifacts/runs/`, whose keep-20 prune then
    // evicts real runs' evidence in mtime order.
    artifactsRoot: path.join(tmp, "artifacts"),
    log: () => {},
  });

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "judge-read-e2e-"));
  originalPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(tmp, { recursive: true, force: true });
});

afterAll(() => {
  process.env.PATH = originalPath;
});

describe("a run whose judge could not read", () => {
  it("dies as an engine failure instead of shipping the verdict it was handed", async () => {
    fakeClaude(false);

    const result = await judgedRun();

    expect(result.status).toBe("engine-failed");
    expect(result.resultText).toMatch(/never ran/);
    // Not the unmet-gate treatment, which ships and shouts: a gate is an
    // author's assertion about a target, and the judge's read capability is a
    // system invariant nobody declares (ADR-0011).
    expect(result.unmetGates ?? []).toEqual([]);
  });

  it("keeps the clean-looking verdict out of the record entirely", async () => {
    fakeClaude(false);

    const result = await judgedRun();

    // The judge said `approve` and meant it. What it could not do is read the
    // workspace, which makes this an unreviewed change and not an approved one.
    expect(result.verdict).toBeUndefined();
    expect(existsSync(path.join(result.artifactsDir, "verdict.json"))).toBe(false);
  });

  it("gets that far on a green verification, so the read check is what killed it", async () => {
    fakeClaude(false);

    const result = await judgedRun();

    expect(result.verify?.state).toBe("passed");
  });

  it("names no path in the failure it records", async () => {
    fakeClaude(false);

    const result = await judgedRun();

    expect(result.resultText).not.toContain(result.workspace);
    expect(result.resultText).not.toContain(result.artifactsDir);
  });
});

describe("a run whose judge could read and had no reason to", () => {
  it("ships, on the same verdict the failing run above was refused", async () => {
    // The distinction the mechanism exists for. Same verdict, same zero reads,
    // same everything the archive would show — and this one is a review.
    fakeClaude(true);

    const result = await judgedRun();

    expect(result.status).toBe("approved");
    expect(result.verdict?.verdict).toBe("approve");
  });

  it("leaves the startup marker in the run's evidence", async () => {
    fakeClaude(true);

    const result = await judgedRun();

    const marker = path.join(result.artifactsDir, "judge-read-startup.1.json");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toContain("judge");
  });

  it("records what the judge could reach and what it opened, on the verdict itself", async () => {
    fakeClaude(true);

    const result = await judgedRun();

    const record = JSON.parse(readFileSync(path.join(result.artifactsDir, "verdict.json"), "utf8"));
    // The pair, beside the verdict the model returned: a model name alone
    // cannot tell two reviewers with different powers apart (ADR-0011).
    expect(record.judge).toEqual({ model: "claude-opus-4-8", capability: "rooted-read" });
    // Empty, because this judge's server came up and it opened nothing — the
    // claim the whole marker mechanism exists to make safe. The run above,
    // whose server never started, records no verdict at all.
    expect(record.readPaths).toEqual([]);
    expect(record.verdict).toBe("approve");
  });

  it("tells the reviewer, in the body they co-sign, what the judge could do", async () => {
    fakeClaude(true);

    const result = await judgedRun();

    const body = readFileSync(path.join(result.artifactsDir, "pr-preview.md"), "utf8");
    expect(body).toContain("claude-opus-4-8 + rooted-read: approved");
    expect(body).toContain("Read no files in the workspace");
    // Workspace-relative or nothing: this body is what a human reads, and an
    // absolute path in it would name a private target's directory layout.
    expect(body).not.toContain(result.workspace);
  });

  it("keeps the read paths off the ledger, which is the one tracked surface", async () => {
    // The scrub review behind this field (cage spec §7.1): a recorded path is
    // workspace-relative and so names no directory layout, but a *filename*
    // inside a private target is still that target's business. Every surface
    // the field reaches — `verdict.json`, the run archive, the PR body — is
    // either git-ignored here or lands in the target's own repository. The
    // ledger is the exception that would make it public-repo content, so the
    // ledger deliberately does not carry it, and this is that decision held to
    // a check rather than to a memory.
    fakeClaude(true);

    const result = await judgedRun();

    const line = readLedger(path.join(tmp, "ledger.jsonl")).find((entry) => entry.runId === result.runId);
    expect(line?.status).toBe("approved");
    expect((line as Record<string, unknown> | undefined)?.readPaths).toBeUndefined();
    expect((line as Record<string, unknown> | undefined)?.judge).toBeUndefined();
  });

  it("cannot lend its marker to the next run of the same task", async () => {
    // The marker is evidence about one invocation. A later run that finds a
    // predecessor's file and treats it as its own is the false green arriving
    // through the archive rather than through the judge.
    fakeClaude(true);
    await judgedRun();
    fakeClaude(false);

    expect((await judgedRun()).status).toBe("engine-failed");
  });
});
