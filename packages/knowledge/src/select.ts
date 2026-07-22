import type { ParsedSymbol, SymbolKind } from "./types.js";

const priority: Record<SymbolKind, number> = {
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
  kept: ParsedSymbol[];
  dropped: number;
}

/** Keep a readable structural cross-section of one file, capped for map density. */
export function selectDefinitions(definitions: ParsedSymbol[], limit: number): Selection {
  const sourceOrder = (left: ParsedSymbol, right: ParsedSymbol) =>
    left.line - right.line ||
    left.file.localeCompare(right.file) ||
    left.name.localeCompare(right.name);

  if (definitions.length <= limit) {
    return { kept: [...definitions].sort(sourceOrder), dropped: 0 };
  }

  const kept = [...definitions]
    .sort(
      (left, right) =>
        priority[left.kind] - priority[right.kind] ||
        left.file.localeCompare(right.file) ||
        left.name.localeCompare(right.name) ||
        left.line - right.line,
    )
    .slice(0, Math.max(0, limit))
    .sort(sourceOrder);

  return { kept, dropped: definitions.length - kept.length };
}
