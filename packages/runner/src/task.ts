import { readFileSync } from "node:fs";
import YAML from "yaml";

export const TASK_RISKS = ["drudgery", "low", "medium"] as const;
export type TaskRisk = (typeof TASK_RISKS)[number];

/**
 * One `amends:` entry — a path glob and the reason this task may change the
 * [gate inputs](../../../CONTEXT.md#gate-input) it names.
 *
 * A licence, not a mandate: the exact mirror of `gates:`, which asserts that
 * evidence exists and never grants anything
 * ([ADR-0014](../../../docs/adr/0014-gate-inputs-are-carried-only-under-an-amendment.md)).
 */
export interface Amendment {
  glob: string;
  reason: string;
}

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
  /**
   * Verifier check names this task declares must have run for the verification
   * to count — a *mandate*, never an instruction: a gate asserts a check
   * executed, and never supplies one the fleet could not already run.
   *
   * Open vocabulary, deliberately unvalidated: the runnable set is a function
   * of (repo shape, host platform) and is only knowable at detection time, so
   * a typo and a deliberately unrunnable mandate are indistinguishable here.
   * Both come out as unmet gates and an `inconclusive` verification — loud,
   * never a false green. Flat and applied to every target, mirroring `scope`.
   */
  gates?: string[];
  /**
   * Gate inputs this task's diff may change, each with the reason it may — a
   * *licence*, never a mandate (ADR-0014). An amended file is carried into the
   * verification tree with the rest of the diff; an un-amended one is held at
   * the base, so its edit ships without being part of what proves it.
   *
   * Ordered, because declaration order decides which reason travels when two
   * globs name the same file. Absent = no licence, which is the ordinary case
   * and the one every task written before this had.
   */
  amends?: Amendment[];
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
  let gates: string[] | undefined;
  if (meta.gates !== undefined) {
    if (!Array.isArray(meta.gates) || meta.gates.length === 0) {
      throw new Error(`task file ${taskPath}: gates must be a non-empty list of verifier check names`);
    }
    gates = meta.gates.map(String);
  }
  const amends = parseAmends(taskPath, meta.amends);
  const risk = (meta.risk ?? "low") as TaskRisk;
  if (!TASK_RISKS.includes(risk)) {
    throw new Error(`task file ${taskPath}: risk must be one of ${TASK_RISKS.join(" | ")}`);
  }
  const why = typeof meta.why === "string" && meta.why.trim() !== "" ? meta.why.trim() : title;
  return { id, title, targets: targets.map(String), scope, gates, amends, risk, why, body: match[2].trim(), raw };
}

/**
 * Parse `amends:` — a mapping of path glob to reason.
 *
 * **The reason is required and must say something.** It is the one part of this
 * licence a reflexive operator cannot supply without thinking, and the failure
 * ADR-0014 cannot mechanically prevent is amendments declared to keep runs
 * moving. A glob can be added without thought; a justification cannot. So an
 * empty reason is a load error naming the glob, not a licence with a blank
 * beside it — the same "found at dispatch, not by a run that silently ignored
 * the field" rule `gates:` and `scope:` are held to above.
 *
 * A list is rejected rather than accommodated. `amends: [tests/**]` is exactly
 * the bare glob this design refuses, and reading it as "reason omitted" would
 * make the required half optional in practice.
 */
function parseAmends(taskPath: string, value: unknown): Amendment[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `task file ${taskPath}: amends must be a mapping of path glob to the reason this task may change it`,
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(`task file ${taskPath}: amends must name at least one path glob, or be omitted`);
  }
  return entries.map(([glob, reason]) => {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(
        `task file ${taskPath}: amends["${glob}"] needs a non-empty reason — an amendment licences the ` +
          "agent to change what judges it, and the justification is the whole friction",
      );
    }
    return { glob, reason: reason.trim() };
  });
}
