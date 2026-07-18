/**
 * The token budget: what fits in the map, and what the map costs to inject.
 * Aider's shape — rank decides the order, the budget decides the cut.
 */
export interface BudgetEntry {
  score: number;
  /** The rendered text whose size is charged against the budget. */
  text: string;
}

export interface BudgetResult<T extends BudgetEntry> {
  kept: T[];
  omitted: number;
  usedTokens: number;
}

/** Rough token count: four characters per token, the usual English/code approximation. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Greedy fill by score. Entries too large for the remaining room are skipped
 * rather than ending the scan, so a single huge file cannot starve the tail.
 */
export function fitToBudget<T extends BudgetEntry>(entries: T[], budgetTokens: number): BudgetResult<T> {
  const ordered = [...entries].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  let usedTokens = 0;

  for (const entry of ordered) {
    const cost = estimateTokens(entry.text);
    if (usedTokens + cost > budgetTokens) continue;
    kept.push(entry);
    usedTokens += cost;
  }

  return { kept, omitted: entries.length - kept.length, usedTokens };
}
