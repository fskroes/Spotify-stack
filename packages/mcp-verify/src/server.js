#!/usr/bin/env node
/**
 * MCP stdio server exposing a single `verify` tool.
 *
 * Spotify part 3: "the agent doesn't know what the verification does and how,
 * it just knows that it can call it." The workspace to verify is taken from
 * the VERIFY_CWD env var (set by the runner when it writes the MCP config),
 * falling back to the server's cwd.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runVerify } from "./verify.js";

const workspace = process.env.VERIFY_CWD ?? process.cwd();

const server = new McpServer({ name: "verify", version: "0.1.0" });

server.registerTool(
  "verify",
  {
    title: "Verify the workspace",
    description:
      "Run all formatting, build, and test verifiers for this repository and " +
      "return a summary. Call this after making changes; the task is only " +
      "complete when it reports VERIFY PASSED — or VERIFY INCONCLUSIVE, which " +
      "means this repository has no verifiers to run and there is nothing you " +
      "can do to turn it green.",
    inputSchema: {},
  },
  async () => {
    const result = await runVerify(workspace);
    return {
      content: [{ type: "text", text: result.summary }],
      isError: result.state === "failed",
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
