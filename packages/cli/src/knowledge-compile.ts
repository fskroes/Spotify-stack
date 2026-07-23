import { execFileSync } from "node:child_process";
import { extractCliResult } from "@fleet/contract";

/** Invoke the logged-in local Claude CLI once, from the target repository. */
export function compileKnowledgeProse(repoDir: string, prompt: string): string {
  const stdout = execFileSync(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "plan",
      "--strict-mcp-config",
    ],
    { cwd: repoDir, encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
  );
  return extractCliResult(stdout);
}
