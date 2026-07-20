import { describe, expect, it } from "vitest";
import {
  dedupeInflight,
  Endpoints,
  InflightRecordSchema,
  isKillStatus,
  KILL_STATUSES,
  LedgerEntrySchema,
  LedgerResponseSchema,
  parseCosignStdout,
  parseLedgerJsonl,
  parseWire,
  RUN_FACTS,
  RUN_KINDS,
  RUN_STATUSES,
  runFacts,
  RunDetailResponseSchema,
  safeParseWire,
  VERIFY_STATES,
  knownVerifyState,
  WireParseError,
  type InflightRecord,
  type LedgerEntry,
} from "../src/index.js";

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

function inflight(overrides: Partial<InflightRecord> = {}): InflightRecord {
  return {
    v: 1,
    runId: "run-live",
    pid: 4242,
    startedAt: "2026-07-15T10:00:00.000Z",
    task: "007-api",
    repo: "demo-api",
    title: "Add operator API",
    stage: "agent",
    attempt: 1,
    stageSince: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("tolerant reading", () => {
  it("ignores unknown fields and degrades on missing optional ones", () => {
    const parsed = parseWire(LedgerEntrySchema, { ...entry(), futureField: { deep: true } });
    expect(parsed.task).toBe("007-api");
    expect(parsed.runId).toBeUndefined();
  });

  it("accepts vocabulary this build does not know — status, mode, stage stay open", () => {
    expect(parseWire(LedgerEntrySchema, entry({ status: "quarantined", mode: "edge" })).status).toBe("quarantined");
    expect(parseWire(InflightRecordSchema, inflight({ stage: "signing" })).stage).toBe("signing");
    expect(isKillStatus("quarantined")).toBe(false);
    expect(isKillStatus("vetoed")).toBe(true);
  });

  it("fails loudly, naming the field path, on a missing required field", () => {
    const result = safeParseWire(LedgerResponseSchema, {
      generatedAt: "now",
      entries: [entry(), { ...entry(), ts: undefined }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(WireParseError);
      expect(result.error.issues[0].path).toBe("entries[1].ts");
    }
  });

  it("keeps structural discriminants strict — an unknown run-detail state is a loud failure", () => {
    const bad = safeParseWire(RunDetailResponseSchema, { state: "queued", run: entry(), artifacts: [] });
    expect(bad.ok).toBe(false);
    const v2 = InflightRecordSchema.safeParse({ ...inflight(), v: 2 });
    expect(v2.success).toBe(false);
  });
});

describe("run fate vocabulary", () => {
  it("states domain facts for every status, exhaustively", () => {
    expect(RUN_STATUSES.length).toBe(7);
    for (const s of RUN_STATUSES) {
      const facts = RUN_FACTS[s];
      expect(RUN_KINDS).toContain(facts.kind);
      // A kill died at a gate; anything else died nowhere.
      expect(facts.kind === "killed" ? facts.diedAt !== null : facts.diedAt === null).toBe(true);
    }
  });

  it("derives the kill set from the fate table — it cannot drift", () => {
    expect([...KILL_STATUSES].sort()).toEqual(["agent-failed", "scope-violation", "verify-failed", "vetoed"]);
    for (const s of RUN_STATUSES) {
      expect(isKillStatus(s)).toBe(RUN_FACTS[s].kind === "killed");
    }
  });

  it("looks up facts tolerantly — undefined for a status this build does not know", () => {
    expect(runFacts("approved")).toEqual({ kind: "shipped", diedAt: null });
    expect(runFacts("agent-failed")).toEqual({ kind: "killed", diedAt: "agent" });
    expect(runFacts("vetoed")?.diedAt).toBe("judge");
    expect(runFacts("engine-failed")?.kind).toBe("infra");
    expect(runFacts("quarantined")).toBeUndefined();
    expect(isKillStatus("quarantined")).toBe(false);
  });
});

describe("verification state", () => {
  it("is a tri-state — a pass is only one of the three ways verification ends", () => {
    expect([...VERIFY_STATES]).toEqual(["passed", "failed", "inconclusive"]);
  });

  it("reads the recorded state tolerantly, never inventing a pass", () => {
    expect(knownVerifyState(entry({ verifyState: "passed" }).verifyState)).toBe("passed");
    expect(knownVerifyState(entry({ verifyState: "inconclusive" }).verifyState)).toBe("inconclusive");
    // A line written before this field existed knows nothing — and "nothing
    // known" must never render as green.
    expect(knownVerifyState(entry().verifyState)).toBeUndefined();
    // A state a newer runner speaks and this build has never heard of.
    expect(knownVerifyState("quarantined")).toBeUndefined();
  });

  it("carries the state on the wire as a plain, optional string", () => {
    expect(LedgerEntrySchema.parse(entry({ verifyState: "inconclusive" })).verifyState).toBe("inconclusive");
    expect(LedgerEntrySchema.parse(entry({ verifyState: "quarantined" })).verifyState).toBe("quarantined");
    expect(LedgerEntrySchema.safeParse({ ...entry(), verifyState: 3 }).success).toBe(false);
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
    expect(skipped[1].issues[0].path).toBe("ts");
  });

  it("returns empty on all-garbage input instead of crashing the report", () => {
    const { entries, skipped } = parseLedgerJsonl("garbage\nmore garbage");
    expect(entries).toEqual([]);
    expect(skipped).toHaveLength(2);
  });
});

describe("parseCosignStdout", () => {
  const result = {
    ok: true,
    action: "merge",
    runId: "run-1",
    state: "merged",
    refusals: [],
  };

  it("finds the last valid co-sign result among SSH noise", () => {
    const output = [
      "Warning: Permanently added 'runner' to hosts",
      JSON.stringify({ unrelated: true }),
      JSON.stringify(result),
      "",
    ].join("\n");
    expect(parseCosignStdout(output)?.state).toBe("merged");
  });

  it("scans from the end — the newest result wins", () => {
    const output = `${JSON.stringify({ ...result, runId: "old" })}\n${JSON.stringify(result)}`;
    expect(parseCosignStdout(output)?.runId).toBe("run-1");
  });

  it("returns null when no line validates, never throwing", () => {
    expect(parseCosignStdout("pnpm banner\n{broken json")).toBeNull();
    expect(parseCosignStdout(JSON.stringify({ ok: true }))).toBeNull();
  });
});

describe("dedupeInflight", () => {
  it("drops a live row whose runId already reached the ledger", () => {
    const decided = [entry({ runId: "run-done" })];
    const live = [inflight({ runId: "run-done" }), inflight({ runId: "run-live" })];
    expect(dedupeInflight(decided, live).map((r) => r.runId)).toEqual(["run-live"]);
  });

  it("keeps live rows when ledger lines predate runId", () => {
    expect(dedupeInflight([entry()], [inflight()])).toHaveLength(1);
  });
});

describe("Endpoints", () => {
  it("binds each route to its schema and URI-encodes path arguments", () => {
    expect(Endpoints.ledger.path).toBe("/api/ledger");
    expect(Endpoints.run.path("run/1")).toBe("/api/runs/run%2F1");
    expect(Endpoints.artifacts.path("007-api", "demo-api")).toBe("/api/artifacts/007-api/demo-api");
  });

  it("stamps the endpoint name onto parse failures, banner-ready", () => {
    const result = Endpoints.inflight.safeParse({ runs: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.endpoint).toBe("GET /api/inflight");
      expect(result.error.message).toContain("GET /api/inflight");
      expect(result.error.message).toContain("generatedAt");
    }
  });

  it("load fetches through the injected transport and parses", async () => {
    const body = { generatedAt: "now", runs: [inflight()] };
    const paths: string[] = [];
    const got = await Endpoints.inflight.load(async (p) => {
      paths.push(p);
      return body;
    });
    expect(paths).toEqual(["/api/inflight"]);
    expect(got.runs[0].runId).toBe("run-live");
    await expect(Endpoints.ledger.load(async () => ({}))).rejects.toThrow(WireParseError);
  });
});
