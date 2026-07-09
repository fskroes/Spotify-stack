/**
 * Mechanical gate on a task file — agent-plan.yml runs this on what the
 * planning agent wrote before any PR is opened, and it works just as well on
 * a hand-written task. Parses the frontmatter (loadTask throws on a bad one),
 * requires every target to resolve against fleet/repos.yaml, and requires the
 * NO_CHANGES_NEEDED sentinel every task prompt must carry.
 * Usage: tsx scripts/validate-task.ts <path/to/task.md>
 */
import { loadTask } from "@fleet/runner/task";
import { targetRepos } from "@fleet/runner/fleet";

const taskPath = process.argv[2];
if (!taskPath) {
  console.error("usage: tsx scripts/validate-task.ts <task-file>");
  process.exit(1);
}

const task = loadTask(taskPath);
const resolved = targetRepos(process.cwd(), task.targets).map((r) => r.name);
const unknown = task.targets.filter((t) => t !== "all" && !resolved.includes(t));
if (unknown.length > 0 || resolved.length === 0) {
  throw new Error(`task ${task.id}: targets not in fleet/repos.yaml: ${unknown.join(", ") || "(none resolved)"}`);
}
if (!task.body.includes("NO_CHANGES_NEEDED")) {
  throw new Error(`task ${task.id}: the prompt must state preconditions with the NO_CHANGES_NEEDED sentinel`);
}

console.log(`${task.id} — ${task.title}`);
console.log(
  `targets: ${resolved.join(", ")} · risk: ${task.risk}${task.scope ? ` · scope: ${task.scope.join(", ")}` : " · scope: unrestricted"}`,
);
