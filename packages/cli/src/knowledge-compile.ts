import { extractCliResult } from "@fleet/contract";
import { invokeClaudeCli } from "./knowledge-cli.js";

/** Compile grounded prose: invoke the shared local Claude CLI seam and keep only its result string. */
export function compileKnowledgeProse(repoDir: string, prompt: string): string {
  return extractCliResult(invokeClaudeCli(repoDir, prompt));
}
