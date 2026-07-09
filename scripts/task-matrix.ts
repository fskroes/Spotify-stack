/**
 * Print the JSON matrix of repo names a task targets — used by the
 * fleet-run.yml "plan" job. Usage: tsx scripts/task-matrix.ts <task_id>
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { loadTask } from "@fleet/runner/task";
import { targetRepos } from "@fleet/runner/fleet";

const controlRepo = process.cwd();
const taskId = process.argv[2];
if (!taskId) {
  console.error("usage: tsx scripts/task-matrix.ts <task_id>");
  process.exit(1);
}

let taskPath = "";
for (const dir of ["tasks/examples", "tasks"]) {
  const candidate = path.join(controlRepo, dir, `${taskId}.md`);
  if (existsSync(candidate)) taskPath = candidate;
}
if (!taskPath) {
  console.error(`task not found: ${taskId}`);
  process.exit(1);
}

const task = loadTask(taskPath);
console.log(JSON.stringify(targetRepos(controlRepo, task.targets).map((r) => r.name)));
