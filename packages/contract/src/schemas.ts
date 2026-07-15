/**
 * The wire shapes — zod schemas as the single declaration, TS types inferred.
 *
 * Tolerant reader (see CONTEXT.md): the operator app and the runner checkout
 * can be at different commits at any time; that is the normal state. So every
 * object schema ignores unknown fields, every enrichment field is optional,
 * and parsing fails — loudly, naming the field — only when a required field
 * is absent or mistyped.
 *
 * Open vocabularies (`status`, `mode`, `stage`, refusal `code`, PR state) stay
 * plain strings on the wire, with the known values exported alongside for
 * narrowing — a newer runner may speak values an older operator doesn't know,
 * and that must degrade, not reject. Only structural discriminants — fields
 * that select which sibling fields exist (`RunDetailResponse.state`,
 * `SyncState.kind`, the in-flight record's `v`) — are strict: there is no
 * graceful rendering for an unknown variant of a shape fork.
 */
import { z } from "zod";

// --- Run vocabulary (known values for narrowing; never enforced by parsing) ---

/** Statuses that count as the immune system killing a change before review. */
export const KILL_STATUSES = ["agent-failed", "verify-failed", "vetoed", "scope-violation"] as const;
export type KillStatus = (typeof KILL_STATUSES)[number];
export function isKillStatus(status: string): status is KillStatus {
  return (KILL_STATUSES as readonly string[]).includes(status);
}

/** Where the run executed. */
export const RUN_MODES = ["local", "cloud"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/**
 * Where a run currently is. Deliberately *not* the Funnel's bar list: `scope`
 * is a ~10ms glob check nobody will ever catch, and `shipping` (push + `gh pr
 * create`) is seconds long but renders as "judge" today, because the Funnel
 * counts the outcome rather than the phase.
 */
export const STAGES = ["agent", "scope", "verify", "judge", "shipping"] as const;
export type Stage = (typeof STAGES)[number];

// --- Ledger entry (persisted in fleet/ledger.jsonl, one line per run) ---

/** Cumulative wall-clock spent in each pipeline phase (summed across judge retries). */
export const PhaseTimingsSchema = z.object({
  agentMs: z.number(),
  verifyMs: z.number(),
  judgeMs: z.number(),
});
export type PhaseTimings = z.infer<typeof PhaseTimingsSchema>;

export const LedgerEntrySchema = z.object({
  /** ISO-8601 timestamp of the run's completion. */
  ts: z.string(),
  task: z.string(),
  repo: z.string(),
  status: z.string(),
  /** Where the run executed — see RUN_MODES for the values this side knows. */
  mode: z.string(),
  /** Number of judge vetoes the run absorbed (including a final fatal one). */
  vetoes: z.number(),
  /** For kills: the first violation/failure line — keeps the kill legible. */
  reason: z.string().optional(),
  prUrl: z.string().optional(),

  // --- Enrichment (all optional; ledger lines written before this omit them,
  // and readers must degrade gracefully). Records what the runner already
  // computed so the ledger can be read on its own — no artifacts/ lookup, which
  // is gitignored and latest-run-wins. ---

  /** Ties this line to the run's in-flight record (`fleet/inflight/<pid>.json`).
   *  A run's line is appended *before* its live record is unlinked, so a reader
   *  scanning both drops any live row whose runId already reached the ledger —
   *  otherwise a run finishing mid-read renders twice. (See dedupeInflight.) */
  runId: z.string().optional(),
  /** Human-readable task title, so ledger views need not resolve the task file. */
  title: z.string().optional(),
  /** Short commit sha — present only when the run actually committed a change. */
  sha: z.string().optional(),
  /** Total wall-clock duration of the run, in milliseconds. */
  elapsedMs: z.number().optional(),
  /** Per-phase durations, in milliseconds. */
  timings: PhaseTimingsSchema.optional(),
  /** A few capped lines of the evidence that decided the run (the gate output). */
  evidence: z.array(z.string()).optional(),

  // --- Cloud provenance (written by run.ts only when GITHUB_ACTIONS is set;
  // recorded, never derived by readers). They let the operator pull a cloud
  // run's evidence on demand — the run executed in Actions, so its artifacts
  // live there, not on the runner. A cloud line missing these predates artifact
  // sync and is permanently "no cloud artifact reference". ---

  /** The Actions run that produced this line (`GITHUB_RUN_ID`) — one Actions
   *  run holds one artifact per repo, so a download must also name the artifact. */
  actionsRunId: z.string().optional(),
  /** The Actions artifact name holding this run's review set: `<task>-<repo>`,
   *  the exact expression `agent-task.yml` uses for its upload. */
  actionsArtifact: z.string().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// --- In-flight record (fleet/inflight/<pid>.json — the live half of the ledger) ---

export const InflightRecordSchema = z.object({
  /** Wire version — a structural discriminant, checked strictly: a future v:2
   *  record is a different shape, and failing loudly here is the upgrade signal. */
  v: z.literal(1),
  /** Reconcile key: also written to the run's ledger line, so a reader can drop
   *  a live row the ledger has already superseded. (See dedupeInflight.) */
  runId: z.string(),
  /** Liveness probe for the staleness sweep — `process.kill(pid, 0)`. */
  pid: z.number(),
  startedAt: z.string(),
  task: z.string(),
  repo: z.string(),
  /** Carried, because no ledger line exists yet to read the title from. */
  title: z.string(),
  /** See STAGES for the values this side knows. */
  stage: z.string(),
  /** 1-based pass through the agent→verify→judge loop, which is not monotonic. */
  attempt: z.number(),
  /** The instant `stage` was entered. Not a heartbeat: writes happen only on
   *  transitions, so a healthy ten-minute agent phase looks ten minutes stale. */
  stageSince: z.string(),
});
export type InflightRecord = z.infer<typeof InflightRecordSchema>;

// --- Co-sign (the human decision on a shipped run, `fleet cosign --json`) ---

/** Longest --close reason accepted; it crosses an SSH boundary as one value. */
export const MAX_REASON_LENGTH = 500;

export const COSIGN_ACTIONS = ["merge", "close"] as const;
export type CosignAction = (typeof COSIGN_ACTIONS)[number];

/** Refusal codes this side knows — `code` is a string on the wire so a newer
 *  runner can refuse for reasons an older operator has never heard of; `detail`
 *  always carries the human rendering. */
export const COSIGN_REFUSAL_CODES = [
  "run-not-found",
  "not-shipped",
  "no-pr",
  "already-merged",
  "already-closed",
  "conflicts",
  "not-mergeable",
  "merge-failed",
  "close-failed",
] as const;
export type KnownCosignRefusalCode = (typeof COSIGN_REFUSAL_CODES)[number];

/** One named gate failure — `code` is stable for machines, `detail` for humans. */
export const CosignRefusalSchema = z.object({
  code: z.string(),
  detail: z.string(),
});
export type CosignRefusal = z.infer<typeof CosignRefusalSchema>;

export const CosignResultSchema = z.object({
  ok: z.boolean(),
  /** See COSIGN_ACTIONS for the values this side knows. */
  action: z.string(),
  runId: z.string(),
  task: z.string().optional(),
  repo: z.string().optional(),
  prUrl: z.string().optional(),
  /** Present on success: "merged" or "closed". */
  state: z.string().optional(),
  /** Merge receipt fields, read back from GitHub after a merge. */
  mergedSha: z.string().optional(),
  mergedBy: z.string().optional(),
  mergedAt: z.string().optional(),
  /** Why the gate refused — empty on success. */
  refusals: z.array(CosignRefusalSchema),
});
export type CosignResult = z.infer<typeof CosignResultSchema>;

// --- PR live state (formerly "Cosign" in ledger-html.ts — renamed to retire
// the collision with CosignResult; the wire field name stays `cosign(s)`) ---

/**
 * The human co-sign state of a shipped PR, fetched live from GitHub at render
 * time (the ledger itself never records it — the merge happens after the run).
 * Known `state` values: "open", "merged", "closed".
 */
export const PrLiveStateSchema = z.object({
  state: z.string(),
  mergedBy: z.string().optional(),
  /** ISO-8601 merge timestamp. */
  mergedAt: z.string().optional(),
});
export type PrLiveState = z.infer<typeof PrLiveStateSchema>;

// --- Cloud evidence sync state ---

/** The evidence state of a cloud run whose archive is not yet on the runner.
 *  `kind` is a structural discriminant (each arm carries different fields),
 *  so it is checked strictly. */
export const SyncStateSchema = z.discriminatedUnion("kind", [
  /** A download is in flight; re-open shortly. */
  z.object({ kind: z.literal("syncing") }),
  /** Permanent: no evidence will ever arrive — with the exact reason. */
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
  /** Transient (gh/network) failure — will be retried on a later open. */
  z.object({ kind: z.literal("retryable"), detail: z.string() }),
]);
export type SyncState = z.infer<typeof SyncStateSchema>;

// --- Catalog + artifact metadata ---

export const OperatorTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  targets: z.array(z.string()),
  risk: z.string(),
});
export type OperatorTask = z.infer<typeof OperatorTaskSchema>;

export const OperatorRepoSchema = z.object({
  name: z.string(),
  language: z.string(),
  defaultBranch: z.string(),
});
export type OperatorRepo = z.infer<typeof OperatorRepoSchema>;

export const ArtifactMetadataSchema = z.object({
  name: z.string(),
  size: z.number(),
  modifiedAt: z.string(),
  url: z.string(),
  contentType: z.string(),
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

// --- HTTP envelopes (one per operator API route) ---

export const LedgerResponseSchema = z.object({
  generatedAt: z.string(),
  entries: z.array(LedgerEntrySchema),
  /** Live PR co-sign state keyed by PR URL. Absent = the serve is offline
   *  (no --cosign polling) — distinct from an empty map, which would read as
   *  "nothing is merged". */
  cosigns: z.record(z.string(), PrLiveStateSchema).optional(),
});
export type LedgerResponse = z.infer<typeof LedgerResponseSchema>;

export const InflightResponseSchema = z.object({
  generatedAt: z.string(),
  runs: z.array(InflightRecordSchema),
});
export type InflightResponse = z.infer<typeof InflightResponseSchema>;

export const CatalogResponseSchema = z.object({
  tasks: z.array(OperatorTaskSchema),
  repos: z.array(OperatorRepoSchema),
});
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;

/** `state` is a structural discriminant — it decides whether `run` is a ledger
 *  entry or an in-flight record — so it is checked strictly, not tolerantly. */
export const RunDetailResponseSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("completed"),
    run: LedgerEntrySchema,
    artifacts: z.array(ArtifactMetadataSchema),
    /** A later run of the same task/repo replaced the shared artifact set, so
     *  this run's evidence is gone — said explicitly instead of implying it
     *  never existed. */
    artifactsSuperseded: z.boolean().optional(),
    sync: SyncStateSchema.optional(),
    cosign: PrLiveStateSchema.optional(),
  }),
  z.object({
    state: z.literal("inflight"),
    run: InflightRecordSchema,
    artifacts: z.array(ArtifactMetadataSchema),
  }),
]);
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;

export const ArtifactListResponseSchema = z.object({
  task: z.string(),
  repo: z.string(),
  artifacts: z.array(ArtifactMetadataSchema),
});
export type ArtifactListResponse = z.infer<typeof ArtifactListResponseSchema>;

/** Any route's failure body. */
export const ErrorResponseSchema = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
