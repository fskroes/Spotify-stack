import type { ParsedFile } from "./types.js";

const damping = 0.85;
const iterations = 40;

/**
 * Rank source files by references flowing toward the files that define them.
 * Name matches are deliberately approximate; ambiguous references share weight.
 */
export function rankFiles(files: ParsedFile[]): Map<string, number> {
  const orderedFiles = [...files].sort((left, right) => left.file.localeCompare(right.file));
  const filePaths = orderedFiles.map((file) => file.file);
  if (filePaths.length === 0) return new Map();

  const definers = new Map<string, string[]>();
  for (const file of orderedFiles) {
    for (const symbol of file.symbols) {
      const paths = definers.get(symbol.name) ?? [];
      if (!paths.includes(file.file)) paths.push(file.file);
      definers.set(symbol.name, paths);
    }
  }
  for (const paths of definers.values()) paths.sort((left, right) => left.localeCompare(right));

  const outbound = new Map<string, Map<string, number>>();
  for (const file of orderedFiles) {
    const edges = new Map<string, number>();
    for (const reference of file.references) {
      const targets = (definers.get(reference) ?? []).filter((target) => target !== file.file);
      for (const target of targets) {
        edges.set(target, (edges.get(target) ?? 0) + 1 / targets.length);
      }
    }
    outbound.set(file.file, edges);
  }

  const count = filePaths.length;
  let scores = new Map(filePaths.map((filePath) => [filePath, 1 / count]));
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Map(filePaths.map((filePath) => [filePath, (1 - damping) / count]));
    let dangling = 0;

    for (const source of filePaths) {
      const edges = outbound.get(source) ?? new Map<string, number>();
      const total = [...edges.values()].reduce((sum, weight) => sum + weight, 0);
      const score = scores.get(source) ?? 0;
      if (total === 0) {
        dangling += score;
        continue;
      }
      for (const [target, weight] of edges) {
        next.set(target, (next.get(target) ?? 0) + (damping * score * weight) / total);
      }
    }

    const danglingShare = (damping * dangling) / count;
    for (const filePath of filePaths) {
      next.set(filePath, (next.get(filePath) ?? 0) + danglingShare);
    }
    scores = next;
  }

  const total = [...scores.values()].reduce((sum, score) => sum + score, 0);
  return new Map(filePaths.map((filePath) => [filePath, (scores.get(filePath) ?? 0) / total]));
}
