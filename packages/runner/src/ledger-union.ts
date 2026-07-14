/**
 * Union ledger read — the local `fleet/ledger.jsonl` merged with the copy
 * committed on `origin/main`.
 *
 * A cloud run's ledger line is pushed to main from GitHub Actions; nothing
 * pulls the control repo on the runner, so that line never reaches the local
 * file. Meanwhile a local run appends its line *uncommitted*, so a naive
 * `git pull` would conflict exactly when it matters. This reads both sides
 * without ever touching the working tree — `git fetch` only moves the
 * remote-tracking ref, and `git show` reads a committed blob — and merges them
 * in memory, deduped by runId. The single function behind `fleet cosign`'s
 * entry lookup and the serve poll's cloud-run visibility.
 *
 * Kept pure over an injected `git` runner, matching cosign.ts's `gh` seam, so
 * every path is testable without a real repo.
 */
import { parseLedger, readLedger, type LedgerEntry } from "./ledger.js";

/** Runs `git` with the given args and returns stdout; throws on failure. */
export type GitRunner = (args: string[]) => string;

export interface RemoteLedgerOptions {
  /** Branch the cloud pushes its ledger lines to. */
  branch?: string;
  /** Path of the ledger within the repo. */
  ledgerRelPath?: string;
}

/**
 * The ledger committed on `origin/<branch>`, via an injected `git` runner.
 * Fetches first so the ref is current, then reads the blob — both best-effort:
 * offline, no remote, or no ledger on the branch yet all yield `[]`. Never
 * mutates the working tree, so it is safe to call with a dirty local ledger and
 * mid-run.
 */
export function readRemoteLedger(git: GitRunner, opts: RemoteLedgerOptions = {}): LedgerEntry[] {
  const branch = opts.branch ?? "main";
  const ledgerRelPath = opts.ledgerRelPath ?? "fleet/ledger.jsonl";
  try {
    git(["fetch", "origin", branch, "--quiet"]);
  } catch {
    // Offline / no remote — fall back to whatever origin/<branch> already
    // points at (possibly nothing). Never fatal: the local ledger still serves.
  }
  let raw: string;
  try {
    raw = git(["show", `origin/${branch}:${ledgerRelPath}`]);
  } catch {
    return []; // no committed ledger on the branch yet, or the ref is missing
  }
  try {
    return parseLedger(raw);
  } catch {
    return []; // a truncated / malformed blob must not crash the reader
  }
}

/**
 * Merge ledger reads, deduped so a run that is both committed on main and
 * present locally counts once. Keyed by runId; lines that predate runId dedupe
 * by exact content (the common committed history is byte-identical on both
 * sides). On a runId collision the later `ts` wins. Chronological (ts
 * ascending), matching the order a plain local read returns.
 */
export function unionLedgers(...sources: LedgerEntry[][]): LedgerEntry[] {
  const byKey = new Map<string, LedgerEntry>();
  const order: string[] = [];
  for (const source of sources) {
    for (const entry of source) {
      const key = entry.runId ?? JSON.stringify(entry);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, entry);
        order.push(key);
      } else if (Date.parse(entry.ts) > Date.parse(existing.ts)) {
        byKey.set(key, entry); // keep the newer line for this run
      }
    }
  }
  return order
    .map((key) => byKey.get(key) as LedgerEntry)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** The union of the local ledger file and origin/main's committed copy. */
export function readUnionLedger(
  ledgerPath: string,
  git: GitRunner,
  opts?: RemoteLedgerOptions,
): LedgerEntry[] {
  return unionLedgers(readLedger(ledgerPath), readRemoteLedger(git, opts));
}
