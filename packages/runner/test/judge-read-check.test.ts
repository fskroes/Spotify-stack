import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JUDGE_READ_MARKER_ENV, JUDGE_READ_TOOLS, JUDGE_READ_WORKSPACE_ENV, judgeReadServerLaunch } from "@fleet/judge-read";
import { assertJudgeReadStartupMarker, assertJudgeReadSurface, preflightJudgeRead } from "../src/judge-read-check.js";

/**
 * The two checks that stop a judge reviewing blind (ADR-0011).
 *
 * The case they exist for is the one no test can assert by counting reads: a
 * broken read tool and a diff that genuinely needed no reads both record zero
 * reads. So the run below that reads nothing has to *pass*, the one whose
 * server cannot start has to fail, and the difference between them has to come
 * from somewhere other than the verdict.
 *
 * The handshake here spawns the real server — the same launch the judge is
 * handed — rather than a stand-in. A pre-flight check against a process the
 * judge never runs proves nothing about the run it is clearing.
 */
let tmp: string;
let workspace: string;
let markerPath: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "judge-read-check-"));
  workspace = path.join(tmp, "ws");
  markerPath = path.join(tmp, "judge-read-startup.0.json");
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, "app.js"), "export const answer = 42;\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("the pre-flight handshake", () => {
  it("clears a workspace whose read server launches and serves the declared surface", async () => {
    await expect(preflightJudgeRead({ workspace })).resolves.toBeUndefined();
  });

  it("fails the run when the read server cannot start, before a token is spent", async () => {
    // The workspace is gone, so the reader throws at construction and the
    // server dies before any client connects. Detection has to happen here:
    // afterwards, this run is indistinguishable from one that read nothing.
    await expect(preflightJudgeRead({ workspace: path.join(tmp, "never-created") })).rejects.toThrow(
      /did not complete a pre-flight handshake/,
    );
  });

  it("keeps the server's own diagnosis out of the record and in the log", async () => {
    // A crashing server reports paths. The thrown message is what reaches the
    // ledger and the co-sign surface; stderr goes to the operator's console.
    const lines: string[] = [];
    const gone = path.join(tmp, "never-created");

    await expect(preflightJudgeRead({ workspace: gone, log: (line) => lines.push(line) })).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(gone) }),
    );
    expect(lines.join("\n")).toContain("judge read server stderr");
  });

  it("does not satisfy the marker check it exists alongside", async () => {
    // The gap the marker closes: a handshake proves the server *can* launch,
    // not that the judge's process wired it. A handshake writing the run's
    // marker would collapse the two checks into one and reopen that gap
    // silently — so it writes to a throwaway of its own.
    await preflightJudgeRead({ workspace });

    expect(existsSync(markerPath)).toBe(false);
    expect(() => assertJudgeReadStartupMarker(markerPath)).toThrow(/never ran/);
  });
});

describe("the declared surface, held against what a server offers", () => {
  /** The declaration as a live server would put it on the wire. */
  const advertised = () => JUDGE_READ_TOOLS.map((tool) => ({ ...tool }));

  it("accepts the declaration itself, so the check cannot pass by refusing everything", () => {
    expect(() => assertJudgeReadSurface(advertised())).not.toThrow();
  });

  it("accepts it in any order, because order on the wire is not the surface", () => {
    expect(() => assertJudgeReadSurface(advertised().reverse())).not.toThrow();
  });

  it("accepts the fields MCP adds of its own, which the declaration does not own", () => {
    expect(() => assertJudgeReadSurface(advertised().map((tool) => ({ ...tool, annotations: {} })))).not.toThrow();
  });

  it.each([
    ["a missing tool", () => advertised().slice(1)],
    ["an undeclared extra", () => [...advertised(), { name: "write_file", description: "", inputSchema: {} }]],
    ["a renamed tool", () => [{ ...advertised()[0], name: "read_files" }, ...advertised().slice(1)]],
    ["a duplicate standing in for a missing one", () => [advertised()[0], { ...advertised()[0] }]],
    ["nothing at all", () => []],
    // The case names alone would miss, and the one a stale second copy of the
    // module most plausibly produces: a judge told something different about
    // the same tool is a different reviewer (ADR-0011).
    ["a reworded description", () => advertised().map((tool, at) => (at === 0 ? { ...tool, description: "Read a file." } : tool))],
    ["a widened schema", () => advertised().map((tool, at) => (at === 0 ? { ...tool, inputSchema: { type: "object" } } : tool))],
  ])("refuses %s", (_case, build) => {
    expect(() => assertJudgeReadSurface(build())).toThrow(/different tool surface/);
  });
});

describe("the startup marker, asserted after the verdict", () => {
  /** What the server writes at launch — the shape, not a paraphrase of it. */
  const marker = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ server: "judge", version: "0.1.0", tools: JUDGE_READ_TOOLS.map((tool) => tool.name), ...over });

  it("passes for a server that came up, whether or not the judge read anything", () => {
    // Written by the server at launch, not by the model: a session that served
    // no reads leaves exactly the same file as one that served forty.
    writeFileSync(markerPath, marker());

    expect(() => assertJudgeReadStartupMarker(markerPath)).not.toThrow();
  });

  it("fails the run when no marker exists, rather than accepting a blind review", () => {
    expect(() => assertJudgeReadStartupMarker(markerPath)).toThrow(/never ran/);
  });

  it("fails on an empty marker, which attests to nothing", () => {
    writeFileSync(markerPath, "");

    expect(() => assertJudgeReadStartupMarker(markerPath)).toThrow(/never ran/);
  });

  it("fails on a file that merely exists, which says only that something wrote the path", () => {
    // The difference between "a byte landed here" and "a process holding this
    // build's read surface came up". Only the second is what the run is
    // entitled to assume once the judge has answered.
    writeFileSync(markerPath, "ok");

    expect(() => assertJudgeReadStartupMarker(markerPath)).toThrow(/never ran/);
  });

  it("fails when something other than the read server wrote it", () => {
    writeFileSync(markerPath, marker({ server: "some-other-mcp-server" }));

    expect(() => assertJudgeReadStartupMarker(markerPath)).toThrow(/not written by the judge's read server/);
  });

  it("fails when the server came up holding a surface this build does not declare", () => {
    // A second copy of `@fleet/judge-read` resolved from somewhere else is the
    // way this happens, and it is the same divergence the handshake watches
    // for — caught here on the server the judge actually got.
    writeFileSync(markerPath, marker({ tools: ["read_file"] }));

    expect(() => assertJudgeReadStartupMarker(markerPath)).toThrow(/started with \[read_file\]/);
  });

  it("names no path, since its message becomes the run's recorded result", () => {
    expect(() => assertJudgeReadStartupMarker(markerPath)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(markerPath) }),
    );
  });
});

describe("what the judge and the handshake are launched with", () => {
  it("is one declaration, so the handshake clears the server the judge will get", () => {
    // A handshake against a differently-configured server would prove something
    // about a process the judge never runs. Both callers take this object whole.
    const launch = judgeReadServerLaunch({ workspace, markerPath });

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(1);
    expect(launch.args[0].endsWith(path.join("judge-read", "src", "server.js"))).toBe(true);
    expect(launch.env[JUDGE_READ_WORKSPACE_ENV]).toBe(workspace);
    expect(launch.env[JUDGE_READ_MARKER_ENV]).toBe(markerPath);
  });
});
