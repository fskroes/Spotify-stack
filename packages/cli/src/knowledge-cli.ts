import { execFileSync } from "node:child_process";

/**
 * Invoke the logged-in local Claude CLI once from the target repository, in
 * read-only plan mode, and return raw stdout. The single seam both `knowledge
 * compile` and `ask` share so their invocation can never drift apart; each
 * caller extracts what it needs (the result string, or the usage envelope) from
 * the returned stdout.
 */
export function invokeClaudeCli(repoDir: string, prompt: string): string {
  return execFileSync(
    "claude",
    ["-p", prompt, "--output-format", "json", "--permission-mode", "plan", "--strict-mcp-config"],
    { cwd: repoDir, encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
  );
}
