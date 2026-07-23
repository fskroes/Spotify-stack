import { existsSync } from "node:fs";
import path from "node:path";
import { resolveFleetRepo, resolveLocalSource, type FleetRepoVisibility } from "./fleet.js";

function artifactFileName(target: string): string {
  if (!target || target === "." || target === ".." || path.basename(target) !== target || target.includes("/") || target.includes("\\")) {
    throw new Error(`knowledge target name must be one path component: ${target}`);
  }
  return `${target}.md`;
}

/** Keep private target prose out of the public control-repository artifact path. */
export function knowledgeArtifactPath(controlRepo: string, target: string, visibility: FleetRepoVisibility): string {
  const fileName = artifactFileName(target);
  return visibility === "private"
    ? path.join(controlRepo, "knowledge", "private", fileName)
    : path.join(controlRepo, "knowledge", fileName);
}

/**
 * Resolve a target's local source directory and storage visibility. Composes the
 * runner's own `resolveFleetRepo` + `resolveLocalSource`, so this lives with the
 * `fleet` module it already depends on — the CLI imports it back from here.
 */
export function resolveKnowledgeRepo(controlRepo: string, target: string): { repoDir: string; visibility: FleetRepoVisibility } {
  const { repo, visibility } = resolveFleetRepo(controlRepo, target);
  const repoDir = resolveLocalSource(repo, controlRepo);
  if (!existsSync(repoDir)) {
    throw new Error(
      `target "${target}" has no local source at ${repoDir}; set local_path in fleet/repos.local.yaml or add demo-repos/${target}`,
    );
  }
  return { repoDir, visibility };
}
