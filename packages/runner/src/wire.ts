/**
 * The shapes the fleet writes down and reads back: the append-only ledger, the
 * in-flight store, and the per-run usage artifact.
 *
 * These used to be a package (`@fleet/contract`) because two machines at
 * different commits had to agree on them. There is one machine now, and one
 * reader — this one — always at the same commit as the writer beside it. So the
 * shapes live next to their writer, and only two things here are still parsed
 * rather than merely constructed: the ledger lines and the in-flight files,
 * both read back off disk.
 *
 * **Optional is not tolerance.** Measured against the 50 archived rows
 * ([experiment, 2026-08-07](../../../docs/experiments/2026-08-07-strict-parse-of-the-archived-ledger.md)):
 * no row carries a key this file does not declare, and no row carries a value
 * outside the vocabularies below. What the archive does hold is 7 early rows
 * written before `runId`, `title`, `elapsedMs`, `timings`, `modelUsage` and
 * `verifyState` existed. Those fields are optional for that reason, and for the
 * ordinary reason that a field can be a fact about one run and not another —
 * `prUrl` exists only where a PR does. Absent always means *not recorded*; no
 * reader may render it as a zero, an empty set, or a green.
 *
 * The one wire this repo does not write is read elsewhere: `cli-envelope.ts`
 * parses Anthropic's Claude CLI output, whose producer can change without a
 * commit here. That file stays deliberately forgiving. This one does not
 * have to be.
 */
import { z } from "zod";

// --- Run vocabulary ---

/**
 * Every way a run can end — the single enumeration of run statuses. `run.ts`
 * infers its `RunStatus` from this, and the ledger report keys its presentation
 * off it. `status` still travels as a plain string: the ledger is append-only,
 * so a row may name a status a later build stopped producing.
 */
export const RUN_STATUSES = [
  "approved", // diff approved; PR created unless dry-run
  "no-changes", // precondition not met — agent correctly did nothing
  "agent-failed", // agent produced no diff without declaring NO_CHANGES_NEEDED
  "verify-failed", // deterministic verification red after the agent finished
  "vetoed", // judge vetoed and retries were exhausted (no producer since ADR-0025)
  "scope-violation", // diff touched files outside the task's scope contract
  "engine-failed", // the engine process crashed mid-run
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The coarse fate a status rolls up to — what funnel math and the trend bars
 * count:
 *  - `shipped`: a change survived the filter and became a PR (`approved`)
 *  - `killed`:  the immune system stopped a bad change (the four kills)
 *  - `infra`:   the run itself broke, so there is no verdict on the change
 *  - `neutral`: there was nothing to decide (`no-changes`)
 */
export const RUN_KINDS = ["shipped", "killed", "infra", "neutral"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/**
 * The pipeline gate a *killed* run died at — where the change was stopped.
 * Deliberately distinct from the in-flight `stage` (STAGES, where a live run is
 * *now*): this is past-tense and exists only for kills, so `shipping` — which a
 * run only reaches once it has already passed every gate — is not a member.
 */
export const TERMINAL_STAGES = ["agent", "scope", "verify", "judge"] as const;
export type TerminalStage = (typeof TERMINAL_STAGES)[number];

/** The domain facts a status carries — true regardless of the surface reading it. */
export interface RunFacts {
  kind: RunKind;
  /** The gate a kill died at; `null` for non-kills (nothing was stopped). */
  diedAt: TerminalStage | null;
}

/**
 * The one status → facts table. Typed with `satisfies Record<RunStatus,
 * RunFacts>`, so adding a value to RUN_STATUSES (or renaming one) is a compile
 * error here until its facts are stated — no status can slip through a
 * forgotten `default:` branch on any surface that keys off this.
 */
export const RUN_FACTS = {
  approved: { kind: "shipped", diedAt: null },
  "no-changes": { kind: "neutral", diedAt: null },
  "agent-failed": { kind: "killed", diedAt: "agent" },
  "verify-failed": { kind: "killed", diedAt: "verify" },
  vetoed: { kind: "killed", diedAt: "judge" },
  "scope-violation": { kind: "killed", diedAt: "scope" },
  "engine-failed": { kind: "infra", diedAt: null },
} as const satisfies Record<RunStatus, RunFacts>;

/** The facts for a status this build knows, else `undefined` — the lookup a
 *  reader uses on a historical row whose status no producer writes any more. */
export function runFacts(status: string): RunFacts | undefined {
  return (RUN_FACTS as Record<string, RunFacts>)[status];
}

/** The statuses that count as the immune system killing a change before review
 *  — derived from the fate table (`kind === "killed"`), so the kill set can
 *  never drift from the facts. */
export type KillStatus = { [K in RunStatus]: (typeof RUN_FACTS)[K]["kind"] extends "killed" ? K : never }[RunStatus];
export function isKillStatus(status: string): status is KillStatus {
  return runFacts(status)?.kind === "killed";
}

/**
 * How deterministic verification ended — a tri-state, because `passed | failed`
 * cannot say "nothing ran". A repo with no detectable verifiers is a legitimate
 * state; claiming a pass for it is not, so that run is `inconclusive`.
 *
 * Orthogonal to RunStatus: what is unproven is the verification, not the run. A
 * run that shipped a good diff against a repo with no verifiers is still
 * `approved`. Surfaces read this field; none may infer it from summary prose.
 */
export const VERIFY_STATES = ["passed", "failed", "inconclusive"] as const;
export type VerifyState = (typeof VERIFY_STATES)[number];

/** The verification state this build knows, else `undefined` — the lookup for a
 *  field absent on every ledger line written before it existed (6 of the 50
 *  archived rows). `undefined` means "not known", which no surface may render
 *  as green. */
export function knownVerifyState(value: string | undefined): VerifyState | undefined {
  return (VERIFY_STATES as readonly string[]).includes(value as string) ? (value as VerifyState) : undefined;
}

/**
 * Where a run currently is. Deliberately *not* the Funnel's bar list: `scope`
 * is a ~10ms glob check nobody will ever catch, and `shipping` (push + `gh pr
 * create`) is seconds long but renders as "judge" today, because the Funnel
 * counts the outcome rather than the phase.
 */
export const STAGES = ["agent", "scope", "verify", "judge", "shipping"] as const;
export type Stage = (typeof STAGES)[number];

// --- Model usage evidence (sanitized per-run artifact + ledger projection) ---

/** The four counters a producer exposes for one actual served model. They remain
 * separate because cache categories have different prices and explain materially
 * different execution shapes; no stored scalar may replace this vector. */
export const TokenVectorSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cacheCreationInputTokens: z.number().int().nonnegative(),
    cacheReadInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
export type TokenVector = z.infer<typeof TokenVectorSchema>;

/** A value the current producer did observe, as distinct from a fact it could
 * not expose. A ledger field omitted entirely remains the third case: historical
 * "not recorded". */
function observationSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("availability", [
    z.object({ availability: z.literal("observed"), value }).strict(),
    z.object({ availability: z.literal("unavailable"), reason: z.string() }).strict(),
  ]);
}

const ModelTokenUsageSchema = z
  .object({
    /** Actual model identity returned by the producer, never a configured default. */
    model: z.string(),
    tokens: TokenVectorSchema,
  })
  .strict();

const ReportedCostSchema = z
  .object({
    /** Known value: `claude-cli-estimate`; stays open for future producer labels. */
    kind: z.string(),
    /** A producer-reported estimate, never an authoritative billed amount. */
    usd: z.number().nonnegative(),
  })
  .strict();

export const UsageAttemptSchema = z
  .object({
    /** Known values: `agent`, `judge`; open so a future rail does not break readers. */
    rail: z.string(),
    /** 1-based within one rail: every resume and fresh judge call gets its own row. */
    ordinal: z.number().int().positive(),
    /** Known values: agent `initial`/`resume`, judge `review`; intentionally open. */
    role: z.string(),
    producer: z
      .object({
        /** Known values: `claude-cli-result`, `anthropic-messages-response`. */
        source: z.string(),
        /** CLI or SDK version, only when the producer exposed it. */
        version: z.string().optional(),
      })
      .strict(),
    billing: z
      .object({
        /** Known values: `api`, `subscription`, `unknown`; independent of run mode. */
        source: z.string(),
        /** Coarse, non-sensitive proof category — never credential details. */
        evidence: z.string(),
      })
      .strict(),
    /** One vector per actual model in a final CLI envelope or SDK response. */
    modelUsage: observationSchema(z.array(ModelTokenUsageSchema).min(1)),
    /** CLI estimates only; no token-to-dollar conversion is permitted. */
    reportedCost: observationSchema(ReportedCostSchema),
    /** Current JSON CLI and SDK paths cannot observe provider retry counts. */
    providerRetries: observationSchema(z.number().int().nonnegative()),
  })
  .strict();
export type UsageAttempt = z.infer<typeof UsageAttemptSchema>;

/** The canonical, content-free evidence document. It holds attempts; its
 * agent/judge and whole-run summaries are reader-derived, never persisted here. */
export const ModelUsageEvidenceSchema = z
  .object({
    /** Structural discriminant: an unknown artifact shape must fail loudly. */
    v: z.literal(1),
    runId: z.string(),
    completedAt: z.string(),
    attempts: z.array(UsageAttemptSchema),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const ordinals = { agent: 0, judge: 0 };
    for (const [index, attempt] of evidence.attempts.entries()) {
      if (attempt.rail !== "agent" && attempt.rail !== "judge") continue;
      const expectedOrdinal = ++ordinals[attempt.rail];
      if (attempt.ordinal !== expectedOrdinal) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts", index, "ordinal"],
          message: `${attempt.rail} attempt ordinals must be consecutive from 1`,
        });
      }
      const expectedRole = attempt.rail === "agent" ? (attempt.ordinal === 1 ? "initial" : "resume") : "review";
      if (attempt.role !== expectedRole) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts", index, "role"],
          message: `${attempt.rail} attempt ${attempt.ordinal} must use role ${expectedRole}`,
        });
      }
    }
    const first = evidence.attempts[0];
    if (first && (first.rail !== "agent" || first.ordinal !== 1 || first.role !== "initial")) {
      ctx.addIssue({
        code: "custom",
        path: ["attempts", 0],
        message: "a recorded Fleet sequence starts with agent attempt 1 in the initial role",
      });
    }
  });
export type ModelUsageEvidence = z.infer<typeof ModelUsageEvidenceSchema>;

/** Ledger objects are looser than the canonical artifact on purpose: a row is
 * historical the moment it is written, and one old line must not be discarded
 * because a later build tightened a rail. */
const LedgerTokenVectorSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
const LedgerReportedCostSchema = z.object({ kind: z.string(), usd: z.number().nonnegative() });

const LedgerUsageRailSchema = z.object({
  attempts: z.number().int().nonnegative(),
  /** Known values: `observed`, `partial`, `unavailable`. */
  availability: z.string(),
  /** Actual returned models; present only when the compact projection has them. */
  models: z.array(z.string()).optional(),
  /** Present only when every attempt in the rail has observed usage. */
  tokens: LedgerTokenVectorSchema.optional(),
  /** Compatible reported estimates only; never billed cost. */
  reportedCost: LedgerReportedCostSchema.optional(),
  /** Coarse source categories observed across the rail's attempts. */
  billingSources: z.array(z.string()),
});

/** Compact, public-ledger projection of the canonical per-run artifact. Omitted
 * on the 6 oldest rows — absence means "not recorded", never a zero-usage run.
 * The `judge` rail has had no producer since ADR-0025 and is carried because 32
 * archived rows hold one. */
export const LedgerUsageProjectionSchema = z.object({
  artifact: z.object({
    version: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  }),
  agent: LedgerUsageRailSchema,
  judge: LedgerUsageRailSchema,
});
export type LedgerUsageProjection = z.infer<typeof LedgerUsageProjectionSchema>;

// --- Ledger entry (persisted in fleet/ledger.jsonl, one line per run) ---

/** Cumulative wall-clock spent in each pipeline phase (summed across judge retries). */
const PhaseTimingsSchema = z.object({
  agentMs: z.number(),
  verifyMs: z.number(),
  /** No producer since ADR-0025; 30 archived rows carry a non-zero value. */
  judgeMs: z.number(),
});

export const LedgerEntrySchema = z.object({
  /** ISO-8601 timestamp of the run's completion. */
  ts: z.string(),
  task: z.string(),
  repo: z.string(),
  status: z.string(),
  /** Where the run executed: `local`, or `cloud` on the 2 rows that predate
   *  ADR-0024 removing the cloud entry point. */
  mode: z.string(),
  /** Number of judge vetoes the run absorbed. No producer since ADR-0025, and
   *  zero on all 50 archived rows — carried because every row declares it. */
  vetoes: z.number(),
  /** For kills: the first violation/failure line — keeps the kill legible. */
  reason: z.string().optional(),
  prUrl: z.string().optional(),

  // --- Fields a run records only when the fact exists, and fields that did not
  // exist when the oldest rows were written. Both read as absent; absent always
  // means *not recorded*, never zero, empty, or green. ---

  /** Ties this line to the run's in-flight record (`fleet/inflight/<pid>.json`).
   *  A run's line is appended *before* its live record is unlinked, so a reader
   *  scanning both drops any live row whose runId already reached the ledger. */
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
  /** How deterministic verification ended — see VERIFY_STATES. Absent on the 6
   *  rows written before the tri-state existed, and on runs where nothing ran;
   *  a reader must not render either as green. */
  verifyState: z.string().optional(),
  /** Gates the task mandated that no check satisfied — see `unmetGates()` in the
   *  runner. Present and non-empty only when something the task demanded did not
   *  run; a run that declared no gates and a run whose gates were all met both
   *  omit it. Absent therefore means *not recorded*, which a reader must render
   *  as unknown rather than as an empty set — the latter would assert that
   *  nothing was outstanding, which no historical line ever established. */
  unmetGates: z.array(z.string()).optional(),
  /** Gate inputs the verification tree took from the base instead of from the
   *  diff, because the task did not amend them (ADR-0014). Their edits are in
   *  the diff and in the PR; they are not part of what verified it. Present
   *  only when this run actually held one — absent means *not recorded*, never
   *  an assertion that the whole diff was verified. */
  heldGateInputs: z.array(z.string()).optional(),
  /** Amendments this run exercised: the glob a task licensed and the reason it
   *  gave. A licence, the mirror of `unmetGates`' mandate — and, like it,
   *  present only when the diff actually matched one. The reason travels with
   *  the glob deliberately: it is the half a reflexive operator cannot supply
   *  without thinking, so a reader who sees the licence sees the argument. */
  amendments: z
    .array(z.object({ glob: z.string(), reason: z.string() }))
    .optional(),
  /** Compact projection of the sanitized per-run usage artifact. Absent on
   * historical lines means "not recorded"; a present `unavailable` rail means
   * a current producer could not expose its evidence, and is never a zero. */
  modelUsage: LedgerUsageProjectionSchema.optional(),

  // --- Cloud provenance. No producer since ADR-0024 removed the cloud entry
  // point; 2 archived rows carry both, from runs that executed in Actions. ---

  /** The Actions run that produced this line (`GITHUB_RUN_ID`). */
  actionsRunId: z.string().optional(),
  /** The Actions artifact name holding this run's review set: `<task>-<repo>`. */
  actionsArtifact: z.string().optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// --- In-flight record (fleet/inflight/<pid>.json — the live half of the ledger) ---

export const InflightRecordSchema = z.object({
  /** Wire version — a structural discriminant, checked strictly: a future v:2
   *  record is a different shape, and failing loudly here is the upgrade signal. */
  v: z.literal(1),
  /** Reconcile key: also written to the run's ledger line, so a reader can drop
   *  a live row the ledger has already superseded. */
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
  /** 1-based pass through the agent→verify loop, which is not monotonic.
   *  Named for the pass, not the attempt: an *attempt* is one model invocation
   *  on one rail (see `UsageAttemptSchema`), and a single pass may contain more
   *  than one. */
  pass: z.number(),
  /** The instant `stage` was entered. Not a heartbeat: writes happen only on
   *  transitions, so a healthy ten-minute agent phase looks ten minutes stale. */
  stageSince: z.string(),
});
export type InflightRecord = z.infer<typeof InflightRecordSchema>;

// --- Reading the ledger back off disk ---

export interface SkippedLine {
  /** 1-based line number in the original text. */
  line: number;
  raw: string;
  /** Dotted path (`timings.agentMs`; "" = the root value) and the reason. */
  issues: { path: string; message: string }[];
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/**
 * Parse ledger JSONL text (a file's contents, or `git show` of a committed
 * copy). Never throws: a line that is not JSON, or is JSON that fails the
 * schema, lands in `skipped` (with its line number and issues) and the other
 * lines are unaffected. The ledger is append-only and historical — one corrupt
 * line must not brick a report. Order is preserved; blank lines are skipped
 * silently.
 */
export function parseLedgerJsonl(text: string): { entries: LedgerEntry[]; skipped: SkippedLine[] } {
  const entries: LedgerEntry[] = [];
  const skipped: SkippedLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      skipped.push({ line: i + 1, raw, issues: [{ path: "", message: `invalid JSON: ${(err as Error).message}` }] });
      continue;
    }
    const result = LedgerEntrySchema.safeParse(value);
    if (result.success) entries.push(result.data);
    else
      skipped.push({
        line: i + 1,
        raw,
        issues: result.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
      });
  }
  return { entries, skipped };
}

// --- Co-sign (the human decision on a shipped run, `fleet cosign --json`) ---
//
// Constructed here and printed; nothing in this repo parses it back. It was a
// wire while the operator app drove `fleet cosign` over SSH (ADR-0005), and
// ADR-0026 ended that transport — so these are plain types, not schemas.

/** Longest --close reason accepted. */
export const MAX_REASON_LENGTH = 500;

export const COSIGN_ACTIONS = ["merge", "close"] as const;
export type CosignAction = (typeof COSIGN_ACTIONS)[number];

/** The named ways the co-sign gate refuses. */
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
export interface CosignRefusal {
  code: string;
  detail: string;
}

export interface CosignResult {
  ok: boolean;
  action: string;
  runId: string;
  task?: string;
  repo?: string;
  prUrl?: string;
  /** Present on success: "merged" or "closed". */
  state?: string;
  /** Merge receipt fields, read back from GitHub after a merge. */
  mergedSha?: string;
  mergedBy?: string;
  mergedAt?: string;
  /** Why the gate refused — empty on success. */
  refusals: CosignRefusal[];
}
