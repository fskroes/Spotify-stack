import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Accept a path to a task file, or a bare task id looked up where authored
 * tasks live. `fleet draft` is the only authoring path, so ids resolve from
 * tasks/drafts and git-ignored tasks/private (already-shipped project tasks;
 * see tasks/private/README.md) — a fresh draft shadows a shipped task of the
 * same id. Fixture directories (tasks/examples, tasks/onramp) are teaching
 * material, reachable by explicit path only.
 */
export function resolveTaskPath(controlRepo: string, taskArg: string): string {
  if (existsSync(taskArg)) return path.resolve(taskArg);
  for (const dir of ["tasks/drafts", "tasks/private"]) {
    const candidate = path.join(controlRepo, dir, `${taskArg}.md`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`task not found: ${taskArg} (looked for a file, then under tasks/drafts and tasks/private)`);
}
