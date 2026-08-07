import { describe, expect, it } from "vitest";
import {
  isKillStatus,
  knownVerifyState,
  LedgerEntrySchema,
  ModelUsageEvidenceSchema,
  parseLedgerJsonl,
  RUN_FACTS,
  RUN_KINDS,
  RUN_STATUSES,
  runFacts,
  VERIFY_STATES,
  type LedgerEntry,
} from "../src/wire.js";

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ts: "2026-07-15T10:00:00.000Z",
    task: "007-api",
    repo: "demo-api",
    status: "approved",
    mode: "local",
    vetoes: 0,
    ...overrides,
  };
}

describe("reading a record back off disk", () => {
  it("degrades on the fields the oldest ledger rows were written without", () => {
    // 7 of the 50 archived rows predate one or more of these. Absent is *not
    // recorded* — never a zero and never a green.
    const old = LedgerEntrySchema.parse(entry());
    expect(old.runId).toBeUndefined();
    expect(old.verifyState).toBeUndefined();
    expect(old.modelUsage).toBeUndefined();
    expect(old.timings).toBeUndefined();
  });
});

describe("run fate vocabulary", () => {
  it("states domain facts for every status, exhaustively", () => {
    expect(RUN_STATUSES.length).toBe(6);
    for (const s of RUN_STATUSES) {
      const facts = RUN_FACTS[s];
      expect(RUN_KINDS).toContain(facts.kind);
      // A kill died at a gate; anything else died nowhere.
      expect(facts.kind === "killed" ? facts.diedAt !== null : facts.diedAt === null).toBe(true);
    }
  });

  it("derives the kill set from the fate table — it cannot drift", () => {
    expect(RUN_STATUSES.filter(isKillStatus).sort()).toEqual([
      "agent-failed",
      "scope-violation",
      "verify-failed",
    ]);
    for (const s of RUN_STATUSES) {
      expect(isKillStatus(s)).toBe(RUN_FACTS[s].kind === "killed");
    }
  });

  it("returns undefined for a status this build has no facts for, instead of throwing", () => {
    // The ledger is append-only: a row may name a status a later build stopped
    // producing, and a report must render that row rather than crash on it.
    expect(runFacts("approved")).toEqual({ kind: "shipped", diedAt: null });
    expect(runFacts("engine-failed")?.kind).toBe("infra");
    expect(runFacts("quarantined")).toBeUndefined();
    expect(isKillStatus("quarantined")).toBe(false);
  });
});

describe("verification state", () => {
  it("is a tri-state — a pass is only one of the three ways verification ends", () => {
    expect([...VERIFY_STATES]).toEqual(["passed", "failed", "inconclusive"]);
  });

  it("reads the recorded state, never inventing a pass", () => {
    expect(knownVerifyState(entry({ verifyState: "passed" }).verifyState)).toBe("passed");
    expect(knownVerifyState(entry({ verifyState: "inconclusive" }).verifyState)).toBe("inconclusive");
    // A line written before this field existed knows nothing — and "nothing
    // known" must never render as green.
    expect(knownVerifyState(entry().verifyState)).toBeUndefined();
    expect(knownVerifyState("quarantined")).toBeUndefined();
  });

  it("carries the state as a plain, optional string", () => {
    expect(LedgerEntrySchema.parse(entry({ verifyState: "inconclusive" })).verifyState).toBe("inconclusive");
    expect(LedgerEntrySchema.safeParse({ ...entry(), verifyState: 3 }).success).toBe(false);
  });

  it("carries unmet gates as optional structured data, not only as prose", () => {
    // A surface must be able to render them without pattern-matching a
    // paragraph.
    expect(LedgerEntrySchema.parse(entry({ unmetGates: ["live-contract-check"] })).unmetGates).toEqual([
      "live-contract-check",
    ]);
    // Absent means *not recorded* — every line written before gates existed.
    // A reader must render that as unknown, never as "nothing was outstanding".
    expect(LedgerEntrySchema.parse(entry()).unmetGates).toBeUndefined();
    expect(LedgerEntrySchema.safeParse({ ...entry(), unmetGates: "test" }).success).toBe(false);
  });

  it("carries an amendment with its reason, and the files held at the base", () => {
    // The licence and its justification travel together (ADR-0014): a glob
    // alone on the ledger would record that the fleet let something through
    // without recording the argument anyone made for it.
    const parsed = LedgerEntrySchema.parse(
      entry({
        amendments: [{ glob: "test/**", reason: "the asserted bound is off by one" }],
        heldGateInputs: ["test/userService.test.ts"],
      }),
    );
    expect(parsed.amendments).toEqual([{ glob: "test/**", reason: "the asserted bound is off by one" }]);
    expect(parsed.heldGateInputs).toEqual(["test/userService.test.ts"]);

    // Absent means *not recorded*, as everywhere else here — and it is the
    // ordinary case, since a diff that touched no gate input records neither.
    expect(LedgerEntrySchema.parse(entry()).amendments).toBeUndefined();
    expect(LedgerEntrySchema.parse(entry()).heldGateInputs).toBeUndefined();
    // A licence with no reason is not a licence this ledger will carry.
    expect(LedgerEntrySchema.safeParse({ ...entry(), amendments: [{ glob: "test/**" }] }).success).toBe(false);
  });
});

describe("model usage evidence", () => {
  const tokens = {
    inputTokens: 28,
    cacheCreationInputTokens: 99_586,
    cacheReadInputTokens: 96_034,
    outputTokens: 342,
  };

  const evidence = {
    v: 1,
    runId: "run-usage",
    completedAt: "2026-07-21T10:00:00.000Z",
    attempts: [
      {
        rail: "agent",
        ordinal: 1,
        role: "initial",
        producer: { source: "claude-cli-result", version: "2.1.216" },
        billing: { source: "unknown", evidence: "credential-provenance-not-observed" },
        modelUsage: { availability: "observed", value: [{ model: "claude-haiku-4-5", tokens }] },
        reportedCost: { availability: "observed", value: { kind: "claude-cli-estimate", usd: 0.6213254 } },
        providerRetries: { availability: "unavailable", reason: "json-output-has-no-retry-events" },
      },
    ],
  };

  it("preserves the four token counters and an emitted zero as observed evidence", () => {
    const parsed = ModelUsageEvidenceSchema.parse({
      ...evidence,
      attempts: [
        {
          ...evidence.attempts[0],
          modelUsage: {
            availability: "observed",
            value: [{ model: "claude-haiku-4-5", tokens: { ...tokens, cacheReadInputTokens: 0 } }],
          },
        },
      ],
    });
    expect(parsed.attempts[0].modelUsage).toEqual({
      availability: "observed",
      value: [{ model: "claude-haiku-4-5", tokens: { ...tokens, cacheReadInputTokens: 0 } }],
    });
  });

  it("records present-day unavailable evidence distinctly from historical ledger absence", () => {
    expect(ModelUsageEvidenceSchema.parse({
      ...evidence,
      attempts: [{ ...evidence.attempts[0], modelUsage: { availability: "unavailable", reason: "no-final-envelope" } }],
    }).attempts[0].modelUsage).toEqual({ availability: "unavailable", reason: "no-final-envelope" });
    expect(LedgerEntrySchema.parse(entry()).modelUsage).toBeUndefined();
  });

  it("keeps the ledger projection readable on rows a later build would not write", () => {
    const parsed = LedgerEntrySchema.parse(entry({
      modelUsage: {
        artifact: { version: 1, sha256: "a".repeat(64) },
        agent: {
          attempts: 1,
          availability: "observed",
          models: ["claude-haiku-4-5"],
          tokens,
          reportedCost: { kind: "claude-cli-estimate", usd: 0.6213254 },
          billingSources: ["unknown"],
        },
        // 32 archived rows carry a judge rail. Nothing has produced one since
        // ADR-0025 deleted the judge.
        judge: { attempts: 1, availability: "unavailable", billingSources: ["unknown"] },
      },
    }));
    expect(parsed.modelUsage?.agent.tokens).toEqual(tokens);
    expect(parsed.modelUsage?.judge.attempts).toBe(1);
  });

  it("rejects a new artifact shape version, malformed observed usage, and content-bearing fields", () => {
    expect(ModelUsageEvidenceSchema.safeParse({ ...evidence, v: 2 }).success).toBe(false);
    expect(ModelUsageEvidenceSchema.safeParse({
      ...evidence,
      attempts: [{ ...evidence.attempts[0], modelUsage: { availability: "observed", value: [] } }],
    }).success).toBe(false);
    expect(ModelUsageEvidenceSchema.safeParse({ ...evidence, prompt: "private task body" }).success).toBe(false);
  });

  it("requires the known agent and judge attempt sequence to be composeable", () => {
    expect(ModelUsageEvidenceSchema.safeParse({
      ...evidence,
      attempts: [{ ...evidence.attempts[0], rail: "judge", role: "initial", ordinal: 2 }],
    }).success).toBe(false);
    expect(ModelUsageEvidenceSchema.safeParse({
      ...evidence,
      attempts: [
        evidence.attempts[0],
        { ...evidence.attempts[0], ordinal: 3, role: "resume" },
      ],
    }).success).toBe(false);
  });

  it("keeps a partial rail readable while writers prevent false partial totals", () => {
    expect(LedgerEntrySchema.safeParse(entry({
      modelUsage: {
        artifact: { version: 1, sha256: "b".repeat(64) },
        agent: { attempts: 2, availability: "partial", tokens, billingSources: ["unknown"] },
        judge: { attempts: 1, availability: "unavailable", billingSources: ["unknown"] },
      },
    })).success).toBe(true);
  });
});

describe("parseLedgerJsonl", () => {
  it("keeps every good line and reports only the bad ones, never throwing", () => {
    const text = [
      JSON.stringify(entry({ runId: "a" })),
      "not json at all",
      "",
      JSON.stringify({ task: "missing-required-fields" }),
      JSON.stringify(entry({ runId: "b" })),
    ].join("\n");
    const { entries, skipped } = parseLedgerJsonl(text);
    expect(entries.map((e) => e.runId)).toEqual(["a", "b"]);
    expect(skipped.map((s) => s.line)).toEqual([2, 4]);
    expect(skipped[0].issues[0].message).toContain("invalid JSON");
    // The failure names the field, so a corrupt line is diagnosable from the
    // report alone.
    expect(skipped[1].issues[0].path).toBe("ts");
  });

  it("returns empty on all-garbage input instead of crashing the report", () => {
    const { entries, skipped } = parseLedgerJsonl("garbage\nmore garbage");
    expect(entries).toEqual([]);
    expect(skipped).toHaveLength(2);
  });
});
