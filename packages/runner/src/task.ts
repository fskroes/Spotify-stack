import { readFileSync } from "node:fs";
import YAML from "yaml";

export const TASK_RISKS = ["drudgery", "low", "medium"] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];

export interface Task {
  id: string;
  title: string;
  /** Repo names from fleet/repos.yaml, or ["all"]. */
  targets: string[];
  /**
   * Path globs the diff may touch. When set, the runner kills any run whose
   * diff falls outside these globs (status `scope-violation`) before verify,
   * judge, or PR. Absent = unrestricted.
   */
  scope?: string[];
  /** Blast-radius label surfaced in the PR header. Default: low. */
  risk: TaskRisk;
  /** One human sentence for the PR's "Why" section. Falls back to the title. */
  why: string;
  /** The prompt body (markdown after the frontmatter). */
  body: string;
  /** Full file contents (frontmatter + body) — given to the judge. */
  raw: string;
}

/** Parse a task file: YAML frontmatter between `---` fences, then markdown. */
export function loadTask(taskPath: string): Task {
  const raw = readFileSync(taskPath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`task file ${taskPath} has no YAML frontmatter`);
  }
  const meta = YAML.parse(match[1]) as Record<string, unknown>;
  const id = meta.id;
  const title = meta.title;
  const targets = meta.targets;
  if (typeof id !== "string" || typeof title !== "string" || !Array.isArray(targets)) {
    throw new Error(`task file ${taskPath} frontmatter must define id, title, and targets`);
  }
  let scope: string[] | undefined;
  if (meta.scope !== undefined) {
    if (!Array.isArray(meta.scope) || meta.scope.length === 0) {
      throw new Error(`task file ${taskPath}: scope must be a non-empty list of path globs`);
    }
    scope = meta.scope.map(String);
  }
  const risk = (meta.risk ?? "low") as TaskRisk;
  if (!TASK_RISKS.includes(risk)) {
    throw new Error(`task file ${taskPath}: risk must be one of ${TASK_RISKS.join(" | ")}`);
  }
  const why = typeof meta.why === "string" && meta.why.trim() !== "" ? meta.why.trim() : title;
  return { id, title, targets: targets.map(String), scope, risk, why, body: match[2].trim(), raw };
}
