/**
 * The correction log: drafted scope versus approved scope, one row per draft,
 * appended the moment the draft is handed to `fleet run`. The first labelled
 * dataset this system produces about the operator's own judgement — and the
 * precondition for class-level co-sign, which cannot automate a judgement that
 * was never recorded.
 *
 * Three values, never two. An unread approval is indistinguishable from a
 * correct draft, so a log that only knew "changed" and "unchanged" would fill
 * with silence — and silence means either "the machine was right" or "nobody
 * looked". `unreviewed` is a first-class outcome, not the gap between the other
 * two; if it dominates, the instrument is broken and no conclusion may be drawn
 * from the rest.
 *
 * This module holds no I/O — it decides an outcome and shapes a row, so the
 * three-way rule is testable without a filesystem.
 */

import { scopeKey } from "./draft.js";

export const CORRECTION_OUTCOMES = ["narrowed", "reviewed-unchanged", "unreviewed"] as const;
export type CorrectionOutcome = (typeof CORRECTION_OUTCOMES)[number];

/** The sidecar `fleet draft` writes next to the task file: what was drafted. */
export interface DraftRecord {
  id: string;
  target: string;
  /** The scope exactly as drafted, before any human touched it. */
  draftedScope: string[];
  draftedAt: string;
}

/** One appended row. Both scopes travel so a reader can see the direction of an edit. */
export interface CorrectionRow {
  ts: string;
  id: string;
  target: string;
  draftedScope: string[];
  approvedScope: string[];
  outcome: CorrectionOutcome;
}

/**
 * The three-way rule. A scope edit in either direction is the human correcting
 * the drafter and records `narrowed` — the row carries both scopes, so widening
 * is visible in the data even though the label follows the instrument's
 * vocabulary. An untouched scope is only evidence if looking was recorded, and
 * the recording gesture is deleting the review marker from the draft file.
 */
export function decideOutcome(args: {
  draftedScope: readonly string[];
  approvedScope: readonly string[];
  markerPresent: boolean;
}): CorrectionOutcome {
  if (scopeKey(args.draftedScope) !== scopeKey(args.approvedScope)) return "narrowed";
  return args.markerPresent ? "unreviewed" : "reviewed-unchanged";
}

export function buildCorrectionRow(args: {
  ts: string;
  record: DraftRecord;
  approvedScope: readonly string[];
  markerPresent: boolean;
}): CorrectionRow {
  return {
    ts: args.ts,
    id: args.record.id,
    target: args.record.target,
    draftedScope: [...args.record.draftedScope],
    approvedScope: [...args.approvedScope],
    outcome: decideOutcome({
      draftedScope: args.record.draftedScope,
      approvedScope: args.approvedScope,
      markerPresent: args.markerPresent,
    }),
  };
}
