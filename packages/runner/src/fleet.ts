import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import YAML from "yaml";

export type FleetRepoVisibility = "public" | "private";

export interface FleetRepo {
  name: string;
  url: string;
  language: string;
  default_branch: string;
  /** The registry file that supplied this target after the local overlay merged. */
  visibility: FleetRepoVisibility;
  /**
   * Optional source directory for `--local` runs. When set, local mode copies
   * from here instead of `demo-repos/<name>`. After load this holds a resolved
   * absolute path (see resolveLocalPath); undefined falls back to demo-repos/.
   */
  local_path?: string;
}

export interface FleetLoadOptions {
  /** Preserve the default owner lookup for run/dispatch while offline commands opt out. */
  resolveOwner?: boolean;
}

/**
 * Resolve a repos.yaml `local_path` to an absolute directory: interpolate any
 * `${ENV_VAR}` (mirrors the `${GH_OWNER}` convention on `url`), expand a leading
 * `~`, then resolve relative paths against the control repo.
 */
export function resolveLocalPath(raw: string, controlRepo: string): string {
  const expanded = raw
    .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
    .replace(/^~(?=\/|$)/, homedir());
  return path.resolve(controlRepo, expanded);
}

/** The local source a registry target maps to, without preparing or mutating it. */
export function resolveLocalSource(repo: FleetRepo, controlRepo: string): string {
  return repo.local_path ?? path.join(controlRepo, "demo-repos", repo.name);
}

/**
 * The GitHub owner used to expand `${GH_OWNER}` in repos.yaml. Prefer the
 * environment (set by the shell, or CI's `github.repository_owner`); when unset,
 * derive it from the logged-in `gh` CLI so local `--pr` runs work with no manual
 * `export`. The derived value is cached back into `process.env.GH_OWNER` so every
 * consumer (repo urls, resolveLocalPath's `${GH_OWNER}`, status) agrees.
 */
export function resolveOwner(): string {
  if (process.env.GH_OWNER) return process.env.GH_OWNER;
  try {
    const login = execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" }).trim();
    if (login) process.env.GH_OWNER = login;
    return login;
  } catch {
    return "";
  }
}

type FleetRepoDefinition = Omit<FleetRepo, "visibility">;

function readRepos(file: string): FleetRepoDefinition[] {
  return (YAML.parse(readFileSync(file, "utf8")) as { repos?: FleetRepoDefinition[] }).repos ?? [];
}

/**
 * Load fleet/repos.yaml, resolving `${GH_OWNER}`. An optional git-ignored
 * `fleet/repos.local.yaml` is merged on top (entries with the same name
 * override), so you can keep private targets local instead of committing them —
 * the parallel of `tasks/private/` (see the repos.yaml header).
 */
export function loadFleet(controlRepo: string, options: FleetLoadOptions = {}): FleetRepo[] {
  const owner = options.resolveOwner === false ? (process.env.GH_OWNER ?? "") : resolveOwner();
  const merged = new Map<string, FleetRepoDefinition & { visibility: FleetRepoVisibility }>();
  for (const r of readRepos(path.join(controlRepo, "fleet", "repos.yaml"))) {
    merged.set(r.name, { ...r, visibility: "public" });
  }
  const overlay = path.join(controlRepo, "fleet", "repos.local.yaml");
  if (existsSync(overlay)) {
    for (const r of readRepos(overlay)) merged.set(r.name, { ...r, visibility: "private" });
  }
  return [...merged.values()].map((r) => ({
    ...r,
    url: r.url.replaceAll("${GH_OWNER}", owner),
    local_path: r.local_path ? resolveLocalPath(r.local_path, controlRepo) : undefined,
  }));
}

export function findRepo(controlRepo: string, name: string, options?: FleetLoadOptions): FleetRepo {
  const repo = loadFleet(controlRepo, options).find((r) => r.name === name);
  if (!repo) {
    throw new Error(`repo "${name}" not found in fleet/repos.yaml`);
  }
  return repo;
}

/** Resolve one target and its storage visibility without shelling out to GitHub. */
export function resolveFleetRepo(controlRepo: string, name: string): { repo: FleetRepo; visibility: FleetRepoVisibility } {
  const repo = findRepo(controlRepo, name, { resolveOwner: false });
  return { repo, visibility: repo.visibility };
}

/** Repos a task applies to ("all" targets every repo in the fleet). */
export function targetRepos(controlRepo: string, targets: string[]): FleetRepo[] {
  const fleet = loadFleet(controlRepo);
  if (targets.includes("all")) return fleet;
  return fleet.filter((r) => targets.includes(r.name));
}
