import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JUDGE_READ_TOOLS } from "../src/read.js";

/**
 * The module is consumed two ways and must need no build step for either:
 * `@fleet/judge` imports it as TypeScript, and the MCP server that fronts it
 * (ticket #105) is a node entry point started by the runner — where no
 * transpiler is in the loop. `@fleet/mcp-verify` already proves the shape
 * works in this workspace; this test is what keeps it true here.
 */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readModule = path.join(packageDir, "src", "read.js");

/** Load the module under plain node and print its surface as JSON. */
function surfaceUnderNode(specifier: string, cwd: string): unknown {
  const stdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { JUDGE_READ_TOOLS } from ${JSON.stringify(specifier)};
       process.stdout.write(JSON.stringify(JUDGE_READ_TOOLS));`,
    ],
    { encoding: "utf8", cwd },
  );
  return JSON.parse(stdout);
}

describe("the read module under plain node", () => {
  it("loads by path and exposes the same surface, with no transpiler in the loop", () => {
    expect(surfaceUnderNode(readModule, packageDir)).toEqual(JUDGE_READ_TOOLS);
  });

  it("resolves by package name, which is how a consumer will import it", () => {
    // The `exports` map is what makes `@fleet/judge-read` mean `src/read.js` —
    // untested, a consumer added in a later stage discovers it does not.
    expect(surfaceUnderNode("@fleet/judge-read", packageDir)).toEqual(JUDGE_READ_TOOLS);
  });
});
