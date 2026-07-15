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
import { constants } from "node:os";
import path from "node:path";
import { InflightRecordSchema, type InflightRecord, type Stage } from "@fleet/contract";
import { STALE_AFTER_MS } from "./timeouts.js";

/**
 * How long a record may sit in one stage before it is presumed orphaned.
 *
 * This is a backstop, not the detector: `process.kill(pid, 0)` catches an
 * orphan in microseconds, where a TTL lags by up to its own bound. It exists
 * for the one case liveness cannot see — a dead run whose pid has been reused.
 *
 * The bound is over `stageSince`, not `startedAt`. A *run* is unbounded (the
 * agent→verify→judge loop repeats), but a *stage* is not: the agent call is
 * capped by `AGENT_TIMEOUT_MS` and every other stage is shorter, and each pass
 * through the loop rewrites `stageSince`.
 */
export { STALE_AFTER_MS };

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
      const parsed = InflightRecordSchema.safeParse(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
      if (parsed.success) records.push(parsed.data);
      // schema mismatch is skipped like a torn write: a foreign or future-
      // versioned record must not crash the reader
    } catch {
      // torn or half-written; the next poll will see it whole
    }
  }
  return records;
}

/**
 * Is this record's run still running? `EPERM` means the process exists but is
 * owned by someone else — alive. `ESRCH` means it is gone.
 */
export function isLive(record: InflightRecord, now: number = Date.now()): boolean {
  let running: boolean;
  try {
    process.kill(record.pid, 0);
    running = true;
  } catch (err) {
    running = (err as NodeJS.ErrnoException).code === "EPERM";
  }
  return running && now - Date.parse(record.stageSince) <= STALE_AFTER_MS;
}

/** The door the report renders from: claims whose runs are still alive. */
export function readLiveInflight(ledgerPath: string): InflightRecord[] {
  return readInflight(ledgerPath).filter((record) => isLive(record));
}

/**
 * Unlink the records `readLiveInflight` filters out. Disk hygiene only — a
 * filtered record is already invisible — so this is the runner's job, called
 * once at the top of a run. The report server never unlinks: a `GET` stays
 * side-effect-free and cannot race a runner staking its claim.
 */
export function sweepInflight(ledgerPath: string, log?: (line: string) => void): void {
  const dir = inflightDir(ledgerPath);
  for (const record of readInflight(ledgerPath)) {
    if (isLive(record)) continue;
    dropClaim(path.join(dir, `${record.pid}.json`), log ?? ((line) => console.log(line)));
  }
}

/**
 * Idempotent unlink. `ENOENT` is the expected steady state, not a failure: a
 * successful run clears once in `finish()` and again in `run()`'s `finally`,
 * and a swept record may be cleared by its own process moments later. Genuine
 * failures (`EACCES`) still surface.
 */
function dropClaim(file: string, log: (line: string) => void): void {
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    log(`⚠ in-flight state not cleared: ${(err as Error).message}`);
  }
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

  /**
   * The claim's lifecycle is owned here rather than by the caller, because the
   * caller cannot see every way it dies: a plain Ctrl-C orphans the record, and
   * so does any throw before `finish()`. Removing the listeners in `clear()` is
   * not optional — `e2e.test.ts` calls `run()` eight times in one process, so
   * listeners that outlive their run trip Node's MaxListeners warning at 11.
   */
  const listeners = new Map<NodeJS.Signals, () => void>();

  const clear = (): void => {
    for (const [signal, onSignal] of listeners) process.removeListener(signal, onSignal);
    listeners.clear();
    dropClaim(file, log);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const onSignal = (): void => {
      clear();
      // Installing a listener replaces Node's default disposition for the
      // signal, which exits 128 + signo. Re-exit the same way, or Ctrl-C on a
      // fleet run reports success.
      process.exit(128 + constants.signals[signal]);
    };
    listeners.set(signal, onSignal);
    process.on(signal, onSignal);
  }

  return {
    enter(stage, attempt) {
      record.stage = stage;
      record.stageSince = new Date().toISOString();
      if (attempt !== undefined) record.attempt = attempt;
      write();
    },
    clear,
  };
}
