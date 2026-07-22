export interface BudgetEntry {
  file: string;
  score: number;
  text: string;
}

export interface BudgetResult<T extends BudgetEntry> {
  kept: T[];
  omitted: number;
  usedTokens: number;
}

/** Approximate code/context token use with a conservative four-character denominator. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Greedily fill a strict budget, skipping an oversized candidate without ending the scan. */
export function fitToBudget<T extends BudgetEntry>(entries: T[], budgetTokens: number): BudgetResult<T> {
  const ordered = [...entries].sort(
    (left, right) => right.score - left.score || left.file.localeCompare(right.file),
  );
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
