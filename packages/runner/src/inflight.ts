/**
 * In-flight run state — the live half of the fleet ledger.
 *
 * `fleet/ledger.jsonl` is the post-mortem: one append per run, at the end. A
 * run is invisible for its whole life. This module is the other half — each
 * running process keeps a single JSON file at `fleet/inflight/<pid>.json`
 * describing where it currently is, so `fleet report --serve` (a separate
 * process) can render the funnel while tasks are still moving through it.
 *
 * The record is mutable current state, not an event log: it is overwritten on
 * every transition and unlinked when the run finishes, so any accumulated
 * history would die unread. The durable history is the ledger.
 *
 * The store is derived from the ledger's own location, so a caller pointing at
 * a throwaway ledger (every test does) automatically gets a throwaway in-flight
 * directory too — the write path runs under test instead of being skipped.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Where a run currently is. Deliberately *not* the Funnel's bar list: `scope`
 * is a ~10ms glob check nobody will ever catch, and `shipping` (push + `gh pr
 * create`) is seconds long but renders as "judge" today, because the Funnel
 * counts the outcome rather than the phase.
 */
export type Stage = "agent" | "scope" | "verify" | "judge" | "shipping";

export interface InflightRecord {
  v: 1;
  /** Reconcile key: also written to the run's ledger line, so a reader can drop
   *  a live row the ledger has already superseded. */
  runId: string;
  /** Liveness probe for the staleness sweep — `process.kill(pid, 0)`. */
  pid: number;
  startedAt: string;
  task: string;
  repo: string;
  /** Carried, because no ledger line exists yet to read the title from. */
  title: string;
  stage: Stage;
  /** 1-based pass through the agent→verify→judge loop, which is not monotonic. */
  attempt: number;
  /** The instant `stage` was entered. Not a heartbeat: writes happen only on
   *  transitions, so a healthy ten-minute agent phase looks ten minutes stale. */
  stageSince: string;
}

/** Both the runner and the report server locate the store from the ledger path. */
export function inflightDir(ledgerPath: string): string {
  return path.join(path.dirname(ledgerPath), "inflight");
}

/** Every run currently claiming to be in flight. Unreadable files are skipped:
 *  a reader must never crash on a writer it caught mid-rename. */
export function readInflight(ledgerPath: string): InflightRecord[] {
  const dir = inflightDir(ledgerPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: InflightRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(readFileSync(path.join(dir, name), "utf8")) as InflightRecord);
    } catch {
      // torn or half-written; the next poll will see it whole
    }
  }
  return records;
}

export interface InflightHandle {
  /** Record a transition. `attempt` carries forward when omitted. */
  enter(stage: Stage, attempt?: number): void;
  /** Drop this run's claim. Called once the ledger line is durable. */
  clear(): void;
}

export interface BeginInflightOptions {
  ledgerPath: string;
  runId: string;
  startedAt: Date;
  task: string;
  repo: string;
  title: string;
  pid?: number;
  log?: (line: string) => void;
}

/**
 * Stake this process's claim and return the transition emitter. The initial
 * record reads `agent`: cloning the target is bracketed into the phase it
 * exists to start, and a run is worth showing while it clones.
 *
 * Nothing here may fail a run. A live view is a convenience; losing it costs a
 * row in a dashboard, not a shipped change.
 */
export function beginInflight(opts: BeginInflightOptions): InflightHandle {
  const log = opts.log ?? ((line: string) => console.log(line));
  const dir = inflightDir(opts.ledgerPath);
  const pid = opts.pid ?? process.pid;
  const file = path.join(dir, `${pid}.json`);

  const record: InflightRecord = {
    v: 1,
    runId: opts.runId,
    pid,
    startedAt: opts.startedAt.toISOString(),
    task: opts.task,
    repo: opts.repo,
    title: opts.title,
    stage: "agent",
    attempt: 1,
    stageSince: opts.startedAt.toISOString(),
  };

  const guard = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      log(`⚠ in-flight state not ${what}: ${(err as Error).message}`);
    }
  };

  /**
   * Whole-file overwrite via write-tmp + rename, which is atomic on POSIX: a
   * reader polling this file sees the old record or the new one, never a torn
   * one. (A torn *append* would leave a half-line every reader must defend
   * against — one of the reasons this is not an event log.)
   *
   * `fleet/inflight/` is fleet-wide, not scoped to this run: it is created but
   * never cleared, or a starting run would delete every concurrent run's file.
   */
  const write = (): void =>
    guard("written", () => {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(record)}\n`);
      renameSync(tmp, file);
    });

  write();

  return {
    enter(stage, attempt) {
      record.stage = stage;
      record.stageSince = new Date().toISOString();
      if (attempt !== undefined) record.attempt = attempt;
      write();
    },
    clear() {
      // The record is created before every terminal path, so no existence check.
      guard("cleared", () => unlinkSync(file));
    },
  };
}
