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
import { isKillStatus, parseLedgerJsonl, type LedgerEntry } from "@fleet/contract";

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

/** Parse ledger JSONL text (a file's contents, or `git show` of a committed
 *  copy). Split from readLedger so a remote ledger read can reuse it.
 *  Never throws: a corrupt or mistyped line is skipped with a warning — the
 *  ledger is append-only and historical, and one bad line must not brick a
 *  report or the operator's server. */
export function parseLedger(text: string, log: (line: string) => void = console.warn): LedgerEntry[] {
  const { entries, skipped } = parseLedgerJsonl(text);
  for (const skip of skipped) {
    const detail = skip.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("; ");
    log(`⚠ ledger line ${skip.line} skipped — ${detail}`);
  }
  return entries;
}

export function readLedger(ledgerPath: string): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  return parseLedger(readFileSync(ledgerPath, "utf8"));
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
    .filter((e) => isKillStatus(e.status))
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
