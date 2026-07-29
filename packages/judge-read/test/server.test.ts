import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JUDGE_READ_JOURNAL_ENV,
  JUDGE_READ_MARKER_ENV,
  JUDGE_READ_SERVER_NAME,
  JUDGE_READ_TOOLS,
  JUDGE_READ_WORKSPACE_ENV,
  judgeReadJournalPaths,
} from "../src/read.js";

/**
 * The MCP transport, exercised over an actual stdio connection rather than by
 * calling its handlers directly. What this file is for is the two claims a unit
 * test of the module cannot make: that the surface the judge is offered on the
 * wire is the declared one, and that the root the server serves is the one the
 * runner put in its environment — not wherever the process happened to start.
 */
const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/server.js");

let workspace: string;
let elsewhere: string;
let outside: string;
let markerPath: string;
let journalPath: string;

beforeEach(() => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "judge-read-server-"));
  workspace = path.join(tmp, "ws");
  elsewhere = path.join(tmp, "elsewhere");
  outside = path.join(tmp, "secret.txt");
  markerPath = path.join(tmp, "startup.json");
  journalPath = path.join(tmp, "reads.txt");
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(workspace, "src", "app.js"), "export const answer = 42;\n");
  writeFileSync(path.join(workspace, "package.json"), '{"name":"target"}\n');
  writeFileSync(path.join(elsewhere, "app.js"), "this file is not in the workspace\n");
  writeFileSync(outside, "a private target's business\n");
});

afterEach(() => {
  rmSync(path.dirname(workspace), { recursive: true, force: true });
});

/**
 * Connect to a freshly spawned server, run one assertion against it, and shut
 * it down. `cwd` defaults to a directory that is *not* the workspace, so every
 * test in this file is also a test that the root came from the environment.
 */
async function withServer<T>(
  fn: (client: Client) => Promise<T>,
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      [JUDGE_READ_WORKSPACE_ENV]: workspace,
      [JUDGE_READ_MARKER_ENV]: markerPath,
      [JUDGE_READ_JOURNAL_ENV]: journalPath,
      ...opts.env,
    },
    cwd: opts.cwd ?? elsewhere,
  });
  const client = new Client({ name: "judge-read-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** The text of a tool call's single content block. */
function textOf(result: unknown): string {
  const blocks = ((result as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>;
  return blocks.map((block) => block.text ?? "").join("");
}

describe("the read server's advertised surface", () => {
  it("is the shared declaration itself — names, descriptions and schemas", async () => {
    // Whole values, not names: a description is what tells the judge when to
    // reach for a tool, so two transports describing one tool differently are
    // two reviewers again (ADR-0011). This also fails if the server ever grows
    // its own literal tool list, because the array is the only source of one.
    const listed = await withServer((client) => client.listTools());

    expect(listed.tools).toEqual(JUDGE_READ_TOOLS);
  });

  it("answers to the name the config key and the tool allowlist are built from", async () => {
    const version = await withServer(async (client) => client.getServerVersion());

    expect(version?.name).toBe(JUDGE_READ_SERVER_NAME);
  });
});

describe("the read server's root", () => {
  it("serves reads from the workspace in its environment, not from its working directory", async () => {
    // The server is started in `elsewhere`, which holds a decoy `app.js`. A
    // server rooted at its cwd would return that file's contents and look
    // perfectly healthy doing it.
    const result = await withServer((client) =>
      client.callTool({ name: JUDGE_READ_TOOLS[0].name, arguments: { path: "app.js" } }),
    );

    expect(textOf(result)).not.toContain("not in the workspace");
    expect(result.isError).toBe(true);
  });

  it("reads a file the caller could only reach through the workspace root", async () => {
    const result = await withServer((client) =>
      client.callTool({ name: JUDGE_READ_TOOLS[0].name, arguments: { path: "src/app.js" } }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("answer = 42");
  });

  it("refuses a path that leaves the workspace, over the wire as in the module", async () => {
    const result = await withServer((client) =>
      client.callTool({ name: JUDGE_READ_TOOLS[0].name, arguments: { path: "../secret.txt" } }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("private target's business");
  });

  it("lists workspace-relative paths for a search", async () => {
    const result = await withServer((client) =>
      client.callTool({ name: JUDGE_READ_TOOLS[1].name, arguments: { glob: "**/*.js" } }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("src/app.js");
  });

  it("hands an unknown tool the reader's refusal rather than a transport error", async () => {
    // The reader owns "no such tool": a name check in the transport would be a
    // second opinion about what the surface contains.
    const result = await withServer((client) =>
      client.callTool({ name: "write_file", arguments: { path: "src/app.js" } }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no such tool");
  });
});

describe("the read server's startup marker", () => {
  it("is written before the server will answer anything", async () => {
    // The marker is the runner's only positive evidence that this process ran
    // (ADR-0011): a broken read tool and a diff that needed no reads both
    // record zero reads, so "did it read anything" cannot be the check. By the
    // time a client has an answer out of the server, the file is on disk.
    await withServer(async (client) => client.listTools());

    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(marker.server).toBe(JUDGE_READ_SERVER_NAME);
    expect(marker.tools).toEqual(JUDGE_READ_TOOLS.map((tool) => tool.name));
  });

  it("is left behind by a session that read nothing at all", async () => {
    // The case the whole mechanism turns on. This server served no reads, which
    // is exactly what a broken one also serves — and the two must not look the
    // same to the runner afterwards.
    await withServer(async () => undefined);

    expect(existsSync(markerPath)).toBe(true);
  });

  it("names no path, so a private target's layout cannot reach the run's artifacts", () => {
    // The marker lands in the run's artifact directory. The runner already
    // knows the root it passed, so recording it back proves nothing and would
    // put a directory layout somewhere a human reads at co-sign.
    return withServer(async (client) => {
      await client.listTools();
      expect(readFileSync(markerPath, "utf8")).not.toContain(workspace);
    });
  });
});

describe("the read server's record of what it served", () => {
  /** The journal as the runner reads it back. */
  const journalled = () => judgeReadJournalPaths(journalPath);

  it("records the workspace-relative path of every file it opened", async () => {
    await withServer(async (client) => {
      await client.callTool({ name: JUDGE_READ_TOOLS[0].name, arguments: { path: "src/app.js" } });
      await client.callTool({ name: JUDGE_READ_TOOLS[0].name, arguments: { path: "package.json" } });
    });

    // The runner's account of what it handed over, written by the runner's own
    // server — not the judge's account of what it opened, which is the account
    // a judge can invent (cage spec §7.1).
    expect(journalled()).toEqual(["src/app.js", "package.json"]);
  });

  it("records nothing for a search or for a read it refused", async () => {
    await withServer(async (client) => {
      await client.callTool({ name: JUDGE_READ_TOOLS[1].name, arguments: { glob: "**/*.js" } });
      await client.callTool({ name: JUDGE_READ_TOOLS[0].name, arguments: { path: "../secret.txt" } });
      await client.callTool({ name: JUDGE_READ_TOOLS[0].name, arguments: { path: "nope.js" } });
    });

    expect(journalled()).toEqual([]);
    // And nothing outside the workspace reached the record by way of a refusal.
    expect(readFileSync(journalPath, "utf8")).not.toContain("secret");
  });

  it("leaves an empty record for a session that read nothing", async () => {
    await withServer(async (client) => client.listTools());

    // Read nothing, and said so. That this is distinguishable from a judge
    // whose server never launched is the marker's job, not this file's — but it
    // is why the empty file can be read as a claim at all.
    expect(existsSync(journalPath)).toBe(true);
    expect(journalled()).toEqual([]);
  });

  it("starts from nothing, so a previous run's reads are never a later verdict's", async () => {
    writeFileSync(journalPath, "src/leftover.js\n");

    await withServer(async (client) => {
      await client.callTool({ name: JUDGE_READ_TOOLS[0].name, arguments: { path: "src/app.js" } });
    });

    expect(journalled()).toEqual(["src/app.js"]);
  });
});

describe("the read server without its environment", () => {
  /** Start the server with exactly `env` and return what it wrote to stderr. */
  const startWith = (env: Record<string, string>): string => {
    try {
      execFileSync(process.execPath, [serverPath], {
        cwd: workspace,
        env: { PATH: process.env.PATH ?? "", ...env },
        encoding: "utf8",
        stdio: "pipe",
        timeout: 15_000,
      });
    } catch (error) {
      return String((error as { stderr?: string }).stderr ?? "") + String((error as Error).message ?? "");
    }
    throw new Error("the server was expected to exit rather than serve");
  };

  it("exits rather than rooting itself anywhere", () => {
    // A default — cwd, or the control repo — is the ADR-0011 failure in
    // miniature: a reviewer reading somewhere the runner never chose, under a
    // name that says it read the workspace under review.
    expect(startWith({ [JUDGE_READ_MARKER_ENV]: markerPath, [JUDGE_READ_JOURNAL_ENV]: journalPath })).toMatch(
      JUDGE_READ_WORKSPACE_ENV,
    );
  });

  it("exits rather than serving reads it cannot be proven to have served", () => {
    // Unattested is not a lesser state of the same thing: a server that runs
    // without leaving the marker produces a verdict the runner cannot tell from
    // one whose server never launched, which is the record ADR-0011 refuses.
    expect(startWith({ [JUDGE_READ_WORKSPACE_ENV]: workspace, [JUDGE_READ_JOURNAL_ENV]: journalPath })).toMatch(
      JUDGE_READ_MARKER_ENV,
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it("exits rather than serving reads it cannot account for", () => {
    // The same argument as the marker's, one step along: a server that served
    // reads without recording them would put a verdict on the record with no
    // way to tell a grounded veto from an invented one — and it would look
    // exactly like a judge that read nothing.
    expect(startWith({ [JUDGE_READ_WORKSPACE_ENV]: workspace, [JUDGE_READ_MARKER_ENV]: markerPath })).toMatch(
      JUDGE_READ_JOURNAL_ENV,
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  it("exits when the workspace it was given does not exist", () => {
    startWith({
      [JUDGE_READ_WORKSPACE_ENV]: path.join(workspace, "gone"),
      [JUDGE_READ_MARKER_ENV]: markerPath,
      [JUDGE_READ_JOURNAL_ENV]: journalPath,
    });

    // And leaves no marker: the file attests that reads are servable, so a
    // server that resolved no root must not have written one on the way down.
    expect(existsSync(markerPath)).toBe(false);
  });
});
