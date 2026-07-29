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
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { JUDGE_READ_SERVER_NAME, JUDGE_READ_TOOLS, JUDGE_READ_WORKSPACE_ENV, createRootedReader } from "./read.js";

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

// Throws — and so exits non-zero, before any client connects — when the
// workspace does not exist. The runner's launch check (#108) is what turns that
// into a failed run rather than a silently text-only review.
const read = createRootedReader(workspace);

/**
 * The low-level server, deliberately, rather than the high-level one: the
 * high-level `registerTool` takes its input schema as a Zod shape, which would
 * mean translating the shared declaration into a second dialect on the way to
 * the wire. The whole point of the declaration is that neither transport
 * restates it. Here the JSON Schema in the array *is* what goes on the wire.
 */
const server = new Server(
  { name: JUDGE_READ_SERVER_NAME, version: "0.1.0" },
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
