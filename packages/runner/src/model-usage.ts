import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ModelUsageEvidenceSchema,
  type LedgerUsageProjection,
  type ModelUsageEvidence,
  type TokenVector,
  type UsageAttempt,
} from "@fleet/contract";

/** Sanitized producer facts. The runner assigns rail, ordinal, and role. */
export type ProducerUsage = Pick<
  UsageAttempt,
  "producer" | "billing" | "modelUsage" | "reportedCost" | "providerRetries"
>;

export function unavailableProducerUsage(reason: string): ProducerUsage {
  return {
    producer: { source: "claude-cli-result" },
    billing: { source: "unknown", evidence: "producer evidence unavailable" },
    modelUsage: { availability: "unavailable", reason },
    reportedCost: { availability: "unavailable", reason },
    providerRetries: { availability: "unavailable", reason },
  };
}

function emptyTokens(): TokenVector {
  return { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
}

function addTokens(total: TokenVector, next: TokenVector): TokenVector {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    cacheCreationInputTokens: total.cacheCreationInputTokens + next.cacheCreationInputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens + next.cacheReadInputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
  };
}

function railProjection(attempts: UsageAttempt[]): LedgerUsageProjection["agent"] {
  const observed = attempts.filter(
    (attempt): attempt is UsageAttempt & { modelUsage: Extract<UsageAttempt["modelUsage"], { availability: "observed" }> } =>
      attempt.modelUsage.availability === "observed",
  );
  const availability = observed.length === 0 ? "unavailable" : observed.length === attempts.length ? "observed" : "partial";
  const models = [...new Set(observed.flatMap((attempt) => attempt.modelUsage.value.map(({ model }) => model)))];
  const billingSources = [...new Set(attempts.map((attempt) => attempt.billing.source))];
  const projection: LedgerUsageProjection["agent"] = { attempts: attempts.length, availability, billingSources };
  if (models.length > 0) projection.models = models;
  if (availability !== "observed") return projection;

  projection.tokens = observed
    .flatMap((attempt) => attempt.modelUsage.value)
    .reduce((total, entry) => addTokens(total, entry.tokens), emptyTokens());
  const costs = attempts.map((attempt) => attempt.reportedCost);
  if (
    costs.every((cost) => cost.availability === "observed" && cost.value.kind === "claude-cli-estimate")
  ) {
    projection.reportedCost = {
      kind: "claude-cli-estimate",
      usd: costs.reduce((total, cost) => total + (cost.availability === "observed" ? cost.value.usd : 0), 0),
    };
  }
  return projection;
}

export interface UsageCollector {
  recordAgent(usage: ProducerUsage): void;
  recordJudge(usage: ProducerUsage): void;
  evidence(runId: string, completedAt: string): ModelUsageEvidence;
  projection(evidence: ModelUsageEvidence, sha256: string): LedgerUsageProjection;
}

export function createUsageCollector(): UsageCollector {
  const attempts: UsageAttempt[] = [];
  const record = (rail: "agent" | "judge", usage: ProducerUsage) => {
    const railAttempts = attempts.filter((attempt) => attempt.rail === rail);
    const ordinal = railAttempts.length + 1;
    attempts.push({
      rail,
      ordinal,
      role: rail === "agent" ? (ordinal === 1 ? "initial" : "resume") : "review",
      ...usage,
    });
  };
  return {
    recordAgent: (usage) => record("agent", usage),
    recordJudge: (usage) => record("judge", usage),
    evidence: (runId, completedAt) => ModelUsageEvidenceSchema.parse({ v: 1, runId, completedAt, attempts }),
    projection: (evidence, sha256) => ({
      artifact: { version: evidence.v, sha256 },
      agent: railProjection(evidence.attempts.filter((attempt) => attempt.rail === "agent")),
      judge: railProjection(evidence.attempts.filter((attempt) => attempt.rail === "judge")),
    }),
  };
}

export function writeModelUsageEvidence(opts: {
  controlRepo: string;
  evidence: ModelUsageEvidence;
}): { path: string; content: string; sha256: string } {
  const evidence = ModelUsageEvidenceSchema.parse(opts.evidence);
  const dir = path.join(opts.controlRepo, "fleet", "evidence", evidence.runId);
  mkdirSync(dir, { recursive: true });
  const artifactPath = path.join(dir, "model-usage.json");
  const content = `${JSON.stringify(evidence, null, 2)}\n`;
  // Canonical evidence is append-only. A repeated run receives a new UUID; an
  // existing path is therefore a collision or an operator intervention, never
  // a reason to silently replace accounting evidence.
  writeFileSync(artifactPath, content, { flag: "wx" });
  return { path: artifactPath, content, sha256: createHash("sha256").update(content).digest("hex") };
}
