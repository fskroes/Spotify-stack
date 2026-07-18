/**
 * Relevance ordering for the map. A file matters in proportion to how much of
 * the repo leans on it, so rank flows along references toward definitions.
 */
import type { FileSymbols } from "./types.js";

const DAMPING = 0.85;
const ITERATIONS = 40;

/**
 * PageRank over the file dependency graph, aider-style: an edge runs from the
 * file that names a symbol to the file that defines it, so rank flows toward
 * the code everything else leans on.
 */
export function rankFiles(files: FileSymbols[]): Map<string, number> {
  if (files.length === 0) return new Map();

  const definers = new Map<string, string[]>();
  for (const f of files) {
    for (const d of f.definitions) {
      const list = definers.get(d.name) ?? [];
      if (!list.includes(f.file)) list.push(f.file);
      definers.set(d.name, list);
    }
  }

  // outbound[from][to] = weight. A reference resolving to several definers
  // splits its weight, so an ambiguous name cannot outvote a precise one.
  const outbound = new Map<string, Map<string, number>>();
  for (const f of files) {
    const edges = new Map<string, number>();
    for (const ref of f.references) {
      const targets = (definers.get(ref) ?? []).filter((t) => t !== f.file);
      for (const t of targets) {
        edges.set(t, (edges.get(t) ?? 0) + 1 / targets.length);
      }
    }
    outbound.set(f.file, edges);
  }

  const names = files.map((f) => f.file);
  const n = names.length;
  let rank = new Map(names.map((name) => [name, 1 / n]));

  for (let i = 0; i < ITERATIONS; i++) {
    const next = new Map(names.map((name) => [name, (1 - DAMPING) / n]));
    let dangling = 0;

    for (const from of names) {
      const edges = outbound.get(from)!;
      const total = [...edges.values()].reduce((a, b) => a + b, 0);
      const share = rank.get(from)!;
      if (total === 0) {
        dangling += share;
        continue;
      }
      for (const [to, weight] of edges) {
        next.set(to, next.get(to)! + (DAMPING * share * weight) / total);
      }
    }

    // A file that references nothing spreads its rank evenly rather than
    // leaking it out of the graph.
    const spill = (DAMPING * dangling) / n;
    for (const name of names) next.set(name, next.get(name)! + spill);

    rank = next;
  }

  const sum = [...rank.values()].reduce((a, b) => a + b, 0);
  return new Map([...rank].map(([file, score]) => [file, score / sum]));
}
