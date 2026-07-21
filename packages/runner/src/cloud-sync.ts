/**
 * On-demand cloud artifact sync.
 *
 * A cloud run's review set (diff.patch, verify.log, verdict.json, …) is uploaded
 * by `agent-task.yml` as an Actions artifact named `<task>-<repo>`, not written
 * to the runner. When the operator opens `/runs/<runId>` for such a run and no
 * local archive exists yet, this pulls that artifact with `gh run download` into
 * a temp dir and renames the reviewable files into `artifacts/runs/<runId>/` —
 * the same per-run archive a local run writes, so the operator API serves it
 * through the existing routes with no new endpoints.
 *
 * The download is fire-and-forget: the request returns a structured `syncing`
 * state immediately, a settle callback lets the server nudge the page to
 * re-fetch, and the next open finds the archive. A gone artifact (expired or
 * never uploaded) becomes a permanent `unavailable` state naming the reason; a
 * transient gh/network failure becomes `retryable` and is retried on a later
 * open. In-flight dedupe means concurrent opens download once.
 *
 * Kept pure over an injected async `gh` runner, matching cosign.ts's `gh` seam,
 * so every path is testable without GitHub.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ModelUsageEvidenceSchema, type LedgerEntry, type SyncState } from "@fleet/contract";
import { REVIEW_ARTIFACTS, runArtifactsDir, runArtifactsRoot } from "./artifacts.js";

/** Runs `gh` asynchronously (spawn-based, so a slow download never blocks the
 *  server's event loop) and resolves with stdout; rejects on a non-zero exit. */
export type AsyncGhRunner = (args: string[]) => Promise<string>;

export interface CloudArtifactSyncOptions {
  controlRepo: string;
  gh: AsyncGhRunner;
  /** How long a transient failure suppresses re-download attempts. */
  retryAfterMs?: number;
  /** Called after any download settles (success or failure) so the server can
   *  broadcast a reload and the open page re-fetches this run. */
  onSettled?: () => void;
  now?: () => number;
}

/** Substrings in a gh error that mean the artifact is *gone*, not a transient
 *  failure. Kept artifact-scoped on purpose: a bare "not found" also matches an
 *  auth blip ("repository not found") or a flaky 404, which must stay retryable
 *  — marking those permanently unavailable would never recover. The upload step
 *  runs before the ledger line is pushed, so a genuinely missing artifact is
 *  permanent: expired past retention, or never uploaded (the run crashed first). */
const GONE_PATTERNS = [/no valid artifact/i, /no artifact/i, /artifact not found/i, /expired/i];

function findDownloadedFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root)) {
    const candidate = path.join(root, entry);
    if (statSync(candidate).isDirectory()) {
      const nested = findDownloadedFile(candidate, name);
      if (nested) return nested;
    } else if (entry === name) {
      return candidate;
    }
  }
  return undefined;
}

export class CloudArtifactSync {
  private readonly controlRepo: string;
  private readonly gh: AsyncGhRunner;
  private readonly retryAfterMs: number;
  private readonly onSettled?: () => void;
  private readonly now: () => number;

  /** runId → in-flight download promise (also the dedupe set). */
  private readonly inflight = new Map<string, Promise<void>>();
  /** runId → the last settled state: a *permanent* `unavailable`, or a
   *  `retryable` that `stateFor` re-attempts once its cooldown passes. */
  private readonly lastOutcome = new Map<string, SyncState>();
  /** runId → earliest time a retryable may be re-attempted. */
  private readonly retryAt = new Map<string, number>();

  constructor(opts: CloudArtifactSyncOptions) {
    this.controlRepo = opts.controlRepo;
    this.gh = opts.gh;
    this.retryAfterMs = opts.retryAfterMs ?? 30_000;
    this.onSettled = opts.onSettled;
    this.now = opts.now ?? Date.now;
  }

  /**
   * The current sync state for a cloud run with no local archive, kicking off a
   * download when one is warranted. Never blocks: returns `syncing` while the
   * download runs.
   */
  stateFor(entry: LedgerEntry): SyncState {
    const runId = entry.runId;
    if (!runId) return { kind: "unavailable", reason: "this run has no id — its evidence can't be located" };
    if (!entry.actionsRunId || !entry.actionsArtifact) {
      return {
        kind: "unavailable",
        reason: "this run predates artifact sync — it has no cloud artifact reference to fetch",
      };
    }

    if (this.inflight.has(runId)) return { kind: "syncing" };

    const settled = this.lastOutcome.get(runId);
    if (settled?.kind === "unavailable") return settled; // permanent — never retry
    if (settled?.kind === "retryable" && this.now() < (this.retryAt.get(runId) ?? 0)) {
      return settled; // still cooling down after a transient failure
    }

    // Nothing on the runner and no reason to wait — start (or re-start) a pull.
    this.lastOutcome.delete(runId);
    this.retryAt.delete(runId);
    const job = this.download(entry).finally(() => {
      this.inflight.delete(runId);
      this.onSettled?.();
    });
    // The job's own body never rejects; guard anyway so a stored promise can't
    // surface as an unhandled rejection.
    this.inflight.set(runId, job.catch(() => {}));
    return { kind: "syncing" };
  }

  private async download(entry: LedgerEntry): Promise<void> {
    const runId = entry.runId as string;
    const root = runArtifactsRoot(this.controlRepo);
    mkdirSync(root, { recursive: true });
    // Download into a sibling temp dir so the rename into the archive stays on
    // one filesystem. The leading dot keeps it out of UUID-only prune scans.
    const tmp = path.join(root, `.tmp-${runId}-${randomUUID()}`);
    try {
      mkdirSync(tmp, { recursive: true });
      await this.gh([
        "run",
        "download",
        entry.actionsRunId as string,
        "--name",
        entry.actionsArtifact as string,
        "--dir",
        tmp,
      ]);
      const moved = this.promoteReviewFiles(tmp, runId);
      if (moved === 0) {
        this.lastOutcome.set(runId, {
          kind: "unavailable",
          reason: "the cloud artifact held no reviewable evidence",
        });
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (GONE_PATTERNS.some((re) => re.test(message))) {
        this.lastOutcome.set(runId, {
          kind: "unavailable",
          reason: "the run's artifact is no longer on GitHub (expired past retention, or never uploaded)",
        });
      } else {
        this.lastOutcome.set(runId, { kind: "retryable", detail: `artifact download failed: ${message}` });
        this.retryAt.set(runId, this.now() + this.retryAfterMs);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Move the reviewable files gh extracted into the run's archive; returns how
   *  many landed. The archive dir is created only once there is something to put
   *  in it, so a fruitless download leaves no phantom archive. */
  private promoteReviewFiles(tmp: string, runId: string): number {
    const dest = runArtifactsDir(this.controlRepo, runId);
    let moved = 0;
    for (const name of REVIEW_ARTIFACTS.keys()) {
      const from = findDownloadedFile(tmp, name);
      if (!from || !existsSync(from)) continue;
      if (name === "model-usage.json") {
        const evidence = ModelUsageEvidenceSchema.parse(JSON.parse(readFileSync(from, "utf8")));
        if (evidence.runId !== runId) throw new Error("cloud model usage evidence run id does not match requested run");
        const canonicalDir = path.join(this.controlRepo, "fleet", "evidence", runId);
        mkdirSync(canonicalDir, { recursive: true });
        copyFileSync(from, path.join(canonicalDir, name));
      }
      if (moved === 0) mkdirSync(dest, { recursive: true });
      renameSync(from, path.join(dest, name));
      moved += 1;
    }
    return moved;
  }

  /** Resolves once every in-flight download has settled (tests + shutdown). */
  async drain(): Promise<void> {
    await Promise.all([...this.inflight.values()]);
  }
}
