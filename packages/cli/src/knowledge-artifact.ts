import path from "node:path";
import type { FleetRepoVisibility } from "@fleet/runner/fleet";

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
