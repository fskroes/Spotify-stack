/**
 * The fleet ledger — the committed shipped/killed record (fleet/ledger.jsonl).
 *
 * Every run appends one line, kills included: the record a skeptical reviewer
 * reads to see what the system stopped before anyone looked at it. Unlike
 * artifacts/ (gitignored, latest-run-wins), the ledger is append-only and
 * version-controlled.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Cumulative wall-clock spent in each pipeline phase (summed across judge retries). */
export interface PhaseTimings {
  agentMs: number;
  verifyMs: number;
  judgeMs: number;
}

export interface LedgerEntry {
  /** ISO-8601 timestamp of the run's completion. */
  ts: string;
  task: string;
  repo: string;
  status: string;
  /** Where the run executed. */
  mode: "local" | "cloud";
  /** Number of judge vetoes the run absorbed (including a final fatal one). */
  vetoes: number;
  /** For kills: the first violation/failure line — keeps the kill legible. */
  reason?: string;
  prUrl?: string;

  // --- Enrichment (all optional; ledger lines written before this omit them,
  // and readers must degrade gracefully). Records what the runner already
  // computed so the ledger can be read on its own — no artifacts/ lookup, which
  // is gitignored and latest-run-wins. ---

  /** Human-readable task title, so ledger views need not resolve the task file. */
  title?: string;
  /** Short commit sha — present only when the run actually committed a change. */
  sha?: string;
  /** Total wall-clock duration of the run, in milliseconds. */
  elapsedMs?: number;
  /** Per-phase durations, in milliseconds. */
  timings?: PhaseTimings;
  /** A few capped lines of the evidence that decided the run (the gate output). */
  evidence?: string[];
}

/** Statuses that count as the immune system killing a change before review. */
export const KILL_STATUSES = ["agent-failed", "verify-failed", "vetoed", "scope-violation"] as const;

export interface FleetRecord {
  days: number;
  shipped: number;
  killed: number;
  judgeVetoes: number;
  verifyFailures: number;
  scopeViolations: number;
  agentFailures: number;
  /** engine-failed runs — infrastructure, not a verdict on the change. */
  infra: number;
  /** no-changes runs — preconditions correctly not met. */
  neutral: number;
  /** The kill entries inside the window, newest first. */
  kills: LedgerEntry[];
}

export function defaultLedgerPath(controlRepo: string): string {
  return path.join(controlRepo, "fleet", "ledger.jsonl");
}

export function appendLedger(ledgerPath: string, entry: LedgerEntry): void {
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
}

export function readLedger(ledgerPath: string): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

export function fleetRecord(
  entries: LedgerEntry[],
  opts: { days?: number; now?: Date } = {},
): FleetRecord {
  const days = opts.days ?? 30;
  const cutoff = (opts.now ?? new Date()).getTime() - days * 24 * 60 * 60 * 1000;
  const windowed = entries.filter((e) => Date.parse(e.ts) >= cutoff);

  const count = (status: string) => windowed.filter((e) => e.status === status).length;
  const kills = windowed
    .filter((e) => (KILL_STATUSES as readonly string[]).includes(e.status))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

  return {
    days,
    shipped: count("approved"),
    killed: kills.length,
    judgeVetoes: count("vetoed"),
    verifyFailures: count("verify-failed"),
    scopeViolations: count("scope-violation"),
    agentFailures: count("agent-failed"),
    infra: count("engine-failed"),
    neutral: count("no-changes"),
    kills,
  };
}

/** The one-line record used in PR bodies and `fleet report`. */
export function formatRecordLine(record: FleetRecord): string {
  const breakdown = [
    `${record.judgeVetoes} judge veto${record.judgeVetoes === 1 ? "" : "es"}`,
    `${record.verifyFailures} verify failure${record.verifyFailures === 1 ? "" : "s"}`,
    `${record.scopeViolations} scope violation${record.scopeViolations === 1 ? "" : "s"}`,
    ...(record.agentFailures > 0
      ? [`${record.agentFailures} agent failure${record.agentFailures === 1 ? "" : "s"}`]
      : []),
  ].join(", ");
  return `Last ${record.days} days: ${record.shipped} shipped · ${record.killed} killed before review (${breakdown}).`;
}
