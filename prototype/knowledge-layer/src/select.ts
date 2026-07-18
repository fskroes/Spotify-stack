/**
 * The per-file cut. Ranking decides which files make the map; this decides how
 * much of a file is worth showing once it is in.
 */
import type { Definition, SymbolKind } from "./types.js";

/** What a reader orienting in a file needs first: shapes, then behaviour, then state. */
const PRIORITY: Record<SymbolKind, number> = {
  struct: 0,
  class: 0,
  enum: 0,
  protocol: 0,
  interface: 0,
  type: 0,
  extension: 1,
  function: 2,
  property: 3,
};

export interface Selection {
  kept: Definition[];
  dropped: number;
}

/**
 * A per-file cap, so one 900-line service cannot eat the whole map budget.
 * Least important kinds go first; survivors are returned in source order.
 */
export function selectDefinitions(definitions: Definition[], maxLines: number): Selection {
  const inSourceOrder = (defs: Definition[]) => [...defs].sort((a, b) => a.line - b.line);

  if (definitions.length <= maxLines) return { kept: inSourceOrder(definitions), dropped: 0 };

  const kept = [...definitions]
    .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.line - b.line)
    .slice(0, Math.max(0, maxLines))
    .sort((a, b) => a.line - b.line);

  return { kept, dropped: definitions.length - kept.length };
}
