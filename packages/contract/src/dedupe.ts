import type { InflightRecord, LedgerEntry } from "./schemas.js";

/**
 * The dedupe-by-runId invariant, in one place.
 *
 * A run's ledger line is appended *before* its in-flight record is unlinked,
 * so for a moment a run is both live and decided. `runId` is on both sides
 * precisely so a reader scanning both can drop the live row instead of
 * drawing the run twice. Match against the whole ledger, not a windowed
 * slice: a run finishing right now is always inside any window anyway, and a
 * narrow window must not resurrect a ghost.
 */
export function dedupeInflight(entries: LedgerEntry[], inflight: InflightRecord[]): InflightRecord[] {
  const decided = new Set(entries.flatMap((entry) => (entry.runId ? [entry.runId] : [])));
  return inflight.filter((record) => !decided.has(record.runId));
}
