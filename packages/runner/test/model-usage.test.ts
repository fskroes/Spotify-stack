import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createUsageCollector,
  unavailableProducerUsage,
  writeModelUsageEvidence,
  type ProducerUsage,
} from "../src/model-usage.js";

const observed = (model: string, overrides: Partial<ProducerUsage> = {}): ProducerUsage => ({
  producer: { source: "claude-cli-result" },
  billing: { source: "unknown", evidence: "producer did not expose credential provenance" },
  modelUsage: {
    availability: "observed",
    value: [
      {
        model,
        tokens: {
          inputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 2,
          outputTokens: 4,
        },
      },
    ],
  },
  reportedCost: { availability: "observed", value: { kind: "claude-cli-estimate", usd: 0.02 } },
  providerRetries: { availability: "unavailable", reason: "not exposed by producer" },
  ...overrides,
});

describe("model usage evidence", () => {
  it("keeps the initial agent, resumed agent, and fresh judge calls as separate ordered attempts", () => {
    const usage = createUsageCollector();
    usage.recordAgent(observed("claude-opus-4-8"));
    usage.recordJudge(observed("claude-opus-4-8"));
    usage.recordAgent(unavailableProducerUsage("no final envelope"));
    usage.recordJudge(observed("claude-opus-4-8", {
      modelUsage: {
        availability: "observed",
        value: [{ model: "claude-opus-4-8", tokens: { inputTokens: 0, cacheCreationInputTokens: 1, cacheReadInputTokens: 3, outputTokens: 5 } }],
      },
    }));

    const evidence = usage.evidence("run-1", "2026-07-21T10:00:00.000Z");
    expect(evidence.attempts.map(({ rail, ordinal, role }) => ({ rail, ordinal, role }))).toEqual([
      { rail: "agent", ordinal: 1, role: "initial" },
      { rail: "judge", ordinal: 1, role: "review" },
      { rail: "agent", ordinal: 2, role: "resume" },
      { rail: "judge", ordinal: 2, role: "review" },
    ]);

    const projection = usage.projection(evidence, "a".repeat(64));
    expect(projection.agent).toMatchObject({ attempts: 2, availability: "partial" });
    expect(projection.agent.tokens).toBeUndefined();
    expect(projection.judge).toMatchObject({
      attempts: 2,
      availability: "observed",
      tokens: { inputTokens: 10, cacheCreationInputTokens: 1, cacheReadInputTokens: 5, outputTokens: 9 },
      reportedCost: { kind: "claude-cli-estimate", usd: 0.04 },
    });
  });

  it("writes the strict canonical artifact before returning its digest", () => {
    const usage = createUsageCollector();
    usage.recordAgent(observed("claude-opus-4-8"));
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-model-usage-"));

    const persisted = writeModelUsageEvidence({
      controlRepo: root,
      evidence: usage.evidence("run-2", "2026-07-21T10:00:00.000Z"),
    });

    expect(existsSync(persisted.path)).toBe(true);
    expect(readFileSync(persisted.path, "utf8")).toBe(persisted.content);
    expect(persisted.sha256).toBe(createHash("sha256").update(persisted.content).digest("hex"));
  });
});
