import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import YAML from "yaml";

export interface FleetRepo {
  name: string;
  url: string;
  language: string;
  default_branch: string;
  /**
   * Optional source directory for `--local` runs. When set, local mode copies
   * from here instead of `demo-repos/<name>`. After load this holds a resolved
   * absolute path (see resolveLocalPath); undefined falls back to demo-repos/.
   */
  local_path?: string;
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

function readRepos(file: string): FleetRepo[] {
  return (YAML.parse(readFileSync(file, "utf8")) as { repos?: FleetRepo[] }).repos ?? [];
}

/**
 * Load fleet/repos.yaml, resolving `${GH_OWNER}`. An optional git-ignored
 * `fleet/repos.local.yaml` is merged on top (entries with the same name
 * override), so you can keep private targets local instead of committing them —
 * the parallel of `tasks/private/` (see the repos.yaml header).
 */
export function loadFleet(controlRepo: string): FleetRepo[] {
  const owner = resolveOwner();
  const merged = new Map<string, FleetRepo>();
  for (const r of readRepos(path.join(controlRepo, "fleet", "repos.yaml"))) merged.set(r.name, r);
  const overlay = path.join(controlRepo, "fleet", "repos.local.yaml");
  if (existsSync(overlay)) for (const r of readRepos(overlay)) merged.set(r.name, r);
  return [...merged.values()].map((r) => ({
    ...r,
    url: r.url.replaceAll("${GH_OWNER}", owner),
    local_path: r.local_path ? resolveLocalPath(r.local_path, controlRepo) : undefined,
  }));
}

export function findRepo(controlRepo: string, name: string): FleetRepo {
  const repo = loadFleet(controlRepo).find((r) => r.name === name);
  if (!repo) {
    throw new Error(`repo "${name}" not found in fleet/repos.yaml`);
  }
  return repo;
}

/** Repos a task applies to ("all" targets every repo in the fleet). */
export function targetRepos(controlRepo: string, targets: string[]): FleetRepo[] {
  const fleet = loadFleet(controlRepo);
  if (targets.includes("all")) return fleet;
  return fleet.filter((r) => targets.includes(r.name));
}
