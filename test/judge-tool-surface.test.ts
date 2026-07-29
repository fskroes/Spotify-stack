/**
 * The first of ADR-0011's two invariants: both transports expose the same tool
 * surface (`docs/judge-cage-spec.md` §8).
 *
 * The capability fork ADR-0011 ends was two reviewers with materially different
 * powers recorded under one name. What let it survive was that nobody had
 * written this down anywhere: the MCP server's surface was checked against the
 * shared declaration inside `@fleet/judge-read`, the SDK client's against the
 * same declaration inside `@fleet/judge`, and no test had ever held the two
 * against *each other*.
 *
 * This file sits outside both packages because the invariant does. It belongs
 * to the pair, and a test living in either one would be deleted along with it.
 *
 * Two claims, and the second is the one that matters:
 *
 * 1. What the read server advertises over MCP and what the SDK client puts on
 *    its requests are the same surface — names, input schemas, **and
 *    descriptions**. Descriptions are not cosmetic here: a description is what
 *    tells the judge when to reach for a tool, so two judges told different
 *    things about the same tool believe they can do different things. That is
 *    the fork wearing a different hat.
 * 2. A tool added to the shared declaration reaches both sides with no further
 *    edit. Claim 1 on its own would pass a codebase where each adapter kept its
 *    own hand-maintained copy of the surface — and lockstep is precisely what
 *    decays. So the test puts a tool into the declaration that neither adapter
 *    has ever heard of and requires both to show it.
 *
 * The two claims are checked through the transports themselves rather than
 * through the constant they share: the MCP surface comes off an actual stdio
 * connection to a spawned server, and the SDK surface off the `tools` parameter
 * of a request the client really built. An adapter can only pass by putting the
 * declaration on its own wire.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JUDGE_READ_TOOLS, judgeReadServerLaunch } from "../packages/judge-read/src/read.js";
import { createJudgeClient } from "../packages/judge/src/index.js";

/**
 * The declaration module, as a path the substitution machinery below can name.
 *
 * By relative path, as `docs-drift.test.ts` reaches into `packages/` — the
 * adapters both say `@fleet/judge-read`, which the repo root cannot resolve.
 */
const declarationUrl = new URL("../packages/judge-read/src/read.js", import.meta.url).href;
const declarationPath = fileURLToPath(declarationUrl);

/**
 * A tool no adapter has ever named, used to prove that neither *can* name one.
 *
 * It is never registered anywhere: claim 2 substitutes a declaration carrying
 * it, and an adapter that restated its own list rather than iterating the
 * declaration simply will not have it to show.
 */
const SYNTHETIC_TOOL = {
  name: "surface_probe",
  description:
    "Exists only inside the invariant test that proves both transports derive " +
    "their surface from the shared declaration instead of restating it. No " +
    "adapter names this tool, and no judge is ever offered it.",
  inputSchema: {
    type: "object",
    properties: { probe: { type: "string", description: "Ignored; the tool is never called." } },
    required: ["probe"],
    additionalProperties: false,
  },
};

let scratch: string;
let workspace: string;
let markerPath: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "judge-surface-"));
  workspace = path.join(scratch, "ws");
  markerPath = path.join(scratch, "startup.json");
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  vi.doUnmock(declarationPath);
  vi.resetModules();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * One tool, reduced to the three fields the declaration owns — and asserted to
 * carry *only* those three, so a key added on one side cannot slip past a
 * comparison that reads just the keys it expected.
 *
 * The two transports spell the schema differently (`inputSchema` on the MCP
 * wire, `input_schema` on the Anthropic one), and that is the sole translation
 * this invariant permits. Everything else is compared as it travels.
 */
function surfaceOf(tools: unknown[], schemaKey: "inputSchema" | "input_schema"): unknown[] {
  return tools.map((tool) => {
    const fields = tool as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["description", schemaKey, "name"].sort());
    return { name: fields.name, description: fields.description, schema: fields[schemaKey] };
  });
}

/**
 * What the read server advertises, over a real stdio MCP connection.
 *
 * The server is the one `judgeReadServerLaunch` describes — the same command,
 * arguments and environment the CLI judge's MCP config hands to `claude` and
 * the runner's pre-flight handshake spawns. A server assembled here instead
 * would prove something about a process no transport runs.
 *
 * @param prefixArgs  Node flags inserted ahead of the entry point. Claim 2 uses
 *   this to install a module hook; claim 1 passes nothing.
 */
async function advertisedOverMcp(prefixArgs: string[] = []): Promise<unknown[]> {
  const launch = judgeReadServerLaunch({ workspace, markerPath, journalPath: path.join(workspace, "..", "reads.txt") });
  const transport = new StdioClientTransport({ ...launch, args: [...prefixArgs, ...launch.args] });
  const client = new Client({ name: "judge-surface-invariant", version: "0.1.0" });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

/**
 * The `tools` parameter of a request the SDK client actually built.
 *
 * Read off the wire rather than off the client, for the same reason the MCP
 * half spawns a server: the question is what the judge is shown, and the only
 * place that exists is a request. The scripted transport answers the first turn
 * with a verdict, so the loop ends immediately and one request is all it takes.
 *
 * @param create  The client factory, taken as an argument because claim 2 drives
 *   a re-imported copy of `@fleet/judge` whose declaration has been substituted.
 */
async function sentBySdk(create: typeof createJudgeClient): Promise<unknown[]> {
  const sent: Record<string, unknown>[] = [];
  const client = create({
    workspace,
    messages: {
      async create(params: Record<string, unknown>) {
        sent.push(params);
        return { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], model: "claude-opus-4-8", usage: {} };
      },
    },
  });

  await client.messages.parse({ messages: [{ role: "user", content: "surface probe" }] });

  expect(sent).toHaveLength(1);
  return sent[0].tools as unknown[];
}

/**
 * Substitute a declaration carrying one more tool, for a server spawned in a
 * subprocess — and hand back the node flags that install it.
 *
 * A module resolution hook rather than a copied server, because the point is
 * that the *shipped* `server.js` picks the extra tool up: a copy edited into
 * agreement would be the hand-maintained lockstep this claim exists to rule
 * out. The hook redirects only `server.js`'s own `./read.js`, so the shim below
 * still reaches the real declaration to extend it.
 */
function declarationWithOneMoreTool(extra: unknown): string[] {
  const shim = path.join(scratch, "extended-declaration.mjs");
  writeFileSync(
    shim,
    [
      `import { JUDGE_READ_TOOLS as DECLARED } from ${JSON.stringify(declarationUrl)};`,
      // A local export of the same name shadows the star re-export, so every
      // other thing `server.js` imports — the reader, the env keys, the server
      // name — is still the real module's.
      `export * from ${JSON.stringify(declarationUrl)};`,
      `export const JUDGE_READ_TOOLS = Object.freeze([...DECLARED, ${JSON.stringify(extra)}]);`,
      "",
    ].join("\n"),
  );

  const hooks = path.join(scratch, "hooks.mjs");
  writeFileSync(
    hooks,
    [
      `const SHIM = ${JSON.stringify(pathToFileURL(shim).href)};`,
      "export function resolve(specifier, context, nextResolve) {",
      '  if (specifier === "./read.js" && String(context.parentURL).endsWith("/src/server.js")) {',
      '    return { url: SHIM, format: "module", shortCircuit: true };',
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      "",
    ].join("\n"),
  );

  const register = path.join(scratch, "register.mjs");
  writeFileSync(
    register,
    [`import { register } from "node:module";`, `register(${JSON.stringify(pathToFileURL(hooks).href)});`, ""].join("\n"),
  );
  return ["--import", pathToFileURL(register).href];
}

describe("the judge's tool surface, across both transports", () => {
  it("is one surface: what MCP advertises is what the SDK client sends", async () => {
    const declared = surfaceOf([...JUDGE_READ_TOOLS], "inputSchema");
    const mcp = surfaceOf(await advertisedOverMcp(), "inputSchema");
    const sdk = surfaceOf(await sentBySdk(createJudgeClient), "input_schema");

    // Against the declaration and against each other, which spec §8 asks for in
    // that order: "each derived from JUDGE_READ_TOOLS and equal it". Both
    // packages already hold their own side to the declaration, and this line
    // deliberately repeats them — an invariant that only holds while two other
    // test files survive is not one this repo can rely on.
    expect(mcp).toEqual(declared);
    expect(sdk).toEqual(declared);
    // Whole values, in order. Order is not itself part of the capability, but
    // both sides get theirs by mapping one array — so a difference in order is
    // a sign that one of them stopped mapping it, which is the thing under test.
    expect(sdk).toEqual(mcp);
    // And not vacuously: a comparison of empty surfaces would pass every
    // assertion above while proving that neither transport can read anything.
    expect(declared.length).toBeGreaterThan(1);
  });

  it("shows a tool added to the shared declaration on both sides, with no adapter edit", async () => {
    // The claim that separates a derived surface from two hand-maintained ones.
    // Each transport gets the extended declaration through its own substitution
    // point — a module hook for the server, which is a subprocess, and the test
    // runner's module registry for the SDK client, which is in-process. That
    // asymmetry is the transports' own (cage spec §6), not a shortcut: there is
    // no subprocess on the SDK path to hook.
    const mcp = surfaceOf(await advertisedOverMcp(declarationWithOneMoreTool(SYNTHETIC_TOOL)), "inputSchema");

    vi.resetModules();
    vi.doMock(declarationPath, async (importOriginal) => {
      const real = await importOriginal<typeof import("../packages/judge-read/src/read.js")>();
      return { ...real, JUDGE_READ_TOOLS: Object.freeze([...real.JUDGE_READ_TOOLS, SYNTHETIC_TOOL]) };
    });
    const { createJudgeClient: rebuilt } = await import("../packages/judge/src/index.js");
    const sdk = surfaceOf(await sentBySdk(rebuilt), "input_schema");

    // Both sides carry it, whole — the description included, because a tool
    // that arrives on one transport with different words is the same fork as a
    // tool that arrives on only one.
    expect(mcp).toContainEqual({
      name: SYNTHETIC_TOOL.name,
      description: SYNTHETIC_TOOL.description,
      schema: SYNTHETIC_TOOL.inputSchema,
    });
    expect(sdk).toEqual(mcp);
  });
});
