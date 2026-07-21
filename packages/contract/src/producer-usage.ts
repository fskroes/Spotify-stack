import type { TokenVector, UsageAttempt } from "./schemas.js";

/**
 * The content-free usage subset a producer contributes to one {@link UsageAttempt}.
 * The runner and judge each assign the surrounding `rail`, `ordinal`, and `role`;
 * this is everything a producer's raw output can actually prove.
 */
export type ProducerUsageEvidence = Pick<
  UsageAttempt,
  "producer" | "billing" | "modelUsage" | "reportedCost" | "providerRetries"
>;

const TOKEN_FIELDS = [
  "inputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "outputTokens",
] as const;

/** A non-negative integer counter — a producer-emitted `0` is observed evidence. */
function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Keep an envelope's per-model usage only when all four counters are valid;
 *  a malformed vector is discarded rather than coerced. */
function tokenVector(value: unknown): TokenVector | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!TOKEN_FIELDS.every((field) => isCounter(raw[field]))) return undefined;
  return {
    inputTokens: raw.inputTokens as number,
    cacheCreationInputTokens: raw.cacheCreationInputTokens as number,
    cacheReadInputTokens: raw.cacheReadInputTokens as number,
    outputTokens: raw.outputTokens as number,
  };
}

/**
 * The single sanitizer for a Claude CLI `--output-format json` final result
 * envelope. Both the runner agent engine and the CLI judge route through it, so
 * their CLI-envelope evidence can never drift apart.
 *
 * It reads only two facts, and treats them as independent observations:
 * `modelUsage` (the four token counters per actual served model) and
 * `total_cost_usd` (a producer-reported estimate — never a billed charge). A
 * present cost therefore survives even when no valid token vector was exposed,
 * and vice versa. Everything else — billing provenance and provider retries —
 * is unobservable from a JSON envelope and is reported `unavailable`, not
 * inferred. No `result`, session id, or other content-bearing field is read.
 */
export function sanitizeCliEnvelopeUsage(envelope: Record<string, unknown>): ProducerUsageEvidence {
  const modelUsage = envelope.modelUsage;
  const vectors =
    modelUsage && typeof modelUsage === "object"
      ? Object.entries(modelUsage as Record<string, unknown>)
          .map(([model, usage]) => ({ model, tokens: tokenVector(usage) }))
          .filter((entry): entry is { model: string; tokens: TokenVector } => entry.tokens !== undefined)
      : [];

  const usd = envelope.total_cost_usd;
  return {
    producer: { source: "claude-cli-result" },
    billing: { source: "unknown", evidence: "CLI result does not expose credential provenance" },
    modelUsage:
      vectors.length > 0
        ? { availability: "observed", value: vectors }
        : { availability: "unavailable", reason: "final CLI envelope did not expose valid model usage" },
    reportedCost:
      typeof usd === "number" && Number.isFinite(usd) && usd >= 0
        ? { availability: "observed", value: { kind: "claude-cli-estimate", usd } }
        : { availability: "unavailable", reason: "final CLI envelope did not expose a reported estimate" },
    providerRetries: { availability: "unavailable", reason: "final CLI envelope does not expose provider retries" },
  };
}
