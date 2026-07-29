import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JUDGE_READ_SERVER_NAME, JUDGE_READ_TOOLS, JUDGE_READ_WORKSPACE_ENV } from "../src/read.js";

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

beforeEach(() => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "judge-read-server-"));
  workspace = path.join(tmp, "ws");
  elsewhere = path.join(tmp, "elsewhere");
  outside = path.join(tmp, "secret.txt");
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
    env: { [JUDGE_READ_WORKSPACE_ENV]: workspace, ...opts.env },
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

describe("the read server without a workspace", () => {
  it("exits rather than rooting itself anywhere", () => {
    // A default — cwd, or the control repo — is the ADR-0011 failure in
    // miniature: a reviewer reading somewhere the runner never chose, under a
    // name that says it read the workspace under review.
    expect(() =>
      execFileSync(process.execPath, [serverPath], {
        cwd: workspace,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
        stdio: "pipe",
        timeout: 15_000,
      }),
    ).toThrow(new RegExp(JUDGE_READ_WORKSPACE_ENV));
  });

  it("exits when the workspace it was given does not exist", () => {
    expect(() =>
      execFileSync(process.execPath, [serverPath], {
        cwd: workspace,
        env: { PATH: process.env.PATH ?? "", [JUDGE_READ_WORKSPACE_ENV]: path.join(workspace, "gone") },
        encoding: "utf8",
        stdio: "pipe",
        timeout: 15_000,
      }),
    ).toThrow();
  });
});
