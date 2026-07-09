/**
 * Print a fleet repo's language — used by agent-task.yml to decide whether
 * to install Swift. Usage: tsx scripts/repo-language.ts <repo_name>
 */
import { findRepo } from "@fleet/runner/fleet";

const name = process.argv[2];
if (!name) {
  console.error("usage: tsx scripts/repo-language.ts <repo_name>");
  process.exit(1);
}
console.log(findRepo(process.cwd(), name).language);
