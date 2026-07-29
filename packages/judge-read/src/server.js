#!/usr/bin/env node
/**
 * MCP stdio server fronting the judge's rooted reader.
 *
 * The transport, and nothing else: it owns no path logic, no containment rule
 * and no tool of its own. Every tool it serves comes from iterating
 * {@link JUDGE_READ_TOOLS}, and every call it serves goes through the reader
 * that array is declared beside — so the surface the judge sees over MCP is the
 * surface, not a copy of it that starts out identical.
 *
 * The root arrives in the environment, read once here at launch. That is the
 * shape `@fleet/mcp-verify` already uses for `VERIFY_CWD`, and for the same
 * reason: a value read at launch cannot be changed by anything that happens
 * during the session it constrains. The server's working directory is
 * deliberately not consulted — a judge whose root depended on where its process
 * happened to start would be rooted somewhere the runner never decided.
 *
 * One process is one judge invocation, so the reader's call budget is spent
 * over the whole review rather than per tool call.
 *
 * It leaves one trace of itself on purpose: a marker file, written the moment
 * the root resolves. Nothing about serving reads needs it. The runner does —
 * it is the only evidence that this process ran, and without it a judge whose
 * server never launched is indistinguishable from one whose diff needed no
 * reads (ADR-0011).
 */
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { JUDGE_READ_MARKER_ENV, JUDGE_READ_SERVER_NAME, JUDGE_READ_TOOLS, JUDGE_READ_WORKSPACE_ENV, createRootedReader } from "./read.js";

const SERVER_VERSION = "0.1.0";

const workspace = process.env[JUDGE_READ_WORKSPACE_ENV];
if (!workspace) {
  // Exit rather than default to anything. ADR-0011's failure is a reviewer with
  // less reach than its name claims, and a server that quietly rooted itself at
  // its own cwd would serve reads of the control repo under the name of the
  // workspace under review.
  process.stderr.write(
    `${JUDGE_READ_WORKSPACE_ENV} is not set: the judge's read server takes the workspace under ` +
      "review from its environment, and will not guess one.\n",
  );
  process.exit(1);
}

const markerPath = process.env[JUDGE_READ_MARKER_ENV];
if (!markerPath) {
  // Required, exactly as the root is. The marker is how the runner learns this
  // process ran at all — a judge that read nothing and a judge whose server
  // never launched are otherwise the same record (ADR-0011) — so a server that
  // cannot attest to its own startup declines to serve rather than serving
  // reads nothing downstream can distinguish from an absence of them.
  process.stderr.write(
    `${JUDGE_READ_MARKER_ENV} is not set: the judge's read server writes a startup marker the runner ` +
      "asserts afterwards, and will not run unattested.\n",
  );
  process.exit(1);
}

// Throws — and so exits non-zero, before any client connects — when the
// workspace does not exist. The runner's pre-flight handshake is what turns
// that into a failed run rather than a silently text-only review.
const read = createRootedReader(workspace);

// Strictly after the reader: the marker attests that this server can serve
// reads, so writing it before the root resolved would attest to a process that
// is about to die. Synchronous, and fatal if it fails — an unattestable server
// is one the runner must not mistake for a healthy one, and dying here costs
// nothing because no model has been called yet.
try {
  writeFileSync(
    markerPath,
    // Paths stay out of it. This file is written into the run's artifacts and
    // is one more surface a private target's directory layout could reach; the
    // runner already knows the root it passed, so recording it back proves
    // nothing it does not hold.
    `${JSON.stringify({ server: JUDGE_READ_SERVER_NAME, version: SERVER_VERSION, tools: JUDGE_READ_TOOLS.map((tool) => tool.name), startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(`the judge's read server could not write its startup marker: ${(error instanceof Error ? error.message : String(error))}\n`);
  process.exit(1);
}

/**
 * The low-level server, deliberately, rather than the high-level one: the
 * high-level `registerTool` takes its input schema as a Zod shape, which would
 * mean translating the shared declaration into a second dialect on the way to
 * the wire. The whole point of the declaration is that neither transport
 * restates it. Here the JSON Schema in the array *is* what goes on the wire.
 */
const server = new Server(
  { name: JUDGE_READ_SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: JUDGE_READ_TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Dispatch by name into the reader, which owns the "no such tool" answer
  // too — a name check here would be a second opinion about what the surface
  // contains, and two opinions are how the surface stops being one.
  const result = await read(request.params.name, request.params.arguments ?? {});
  return { content: [{ type: "text", text: result.text }], isError: result.isError };
});

await server.connect(new StdioServerTransport());
