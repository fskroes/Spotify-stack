import { describe, expect, it } from "vitest";
import { WireParseError, type InflightRecord, type LedgerEntry } from "@fleet/contract";
import { ingestInflight, ingestLedger } from "../src/ingest.js";

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

describe("ingestLedger", () => {
  it("keeps the readable entries and counts the ones it had to drop", () => {
    const raw = {
      generatedAt: "2026-07-15T10:05:00.000Z",
      entries: [
        entry({ runId: "a" }),
        { ...entry(), ts: undefined }, // required field missing — unreadable
        "not even an object", // unreadable
        entry({ runId: "b" }),
      ],
    };

    const ledger = ingestLedger(raw);

    expect(ledger.entries.map((e) => e.runId)).toEqual(["a", "b"]);
    expect(ledger.unreadable).toBe(2);
    expect(ledger.generatedAt).toBe("2026-07-15T10:05:00.000Z");
  });

  it("passes unknown fields through — a newer runner never bricks a read", () => {
    const raw = {
      generatedAt: "now",
      entries: [{ ...entry({ status: "quarantined" }), futureField: true }],
    };

    const ledger = ingestLedger(raw);

    expect(ledger.entries[0].status).toBe("quarantined");
    expect(ledger.unreadable).toBe(0);
  });

  it("tolerates a malformed co-sign value without losing the good ones", () => {
    const raw = {
      generatedAt: "now",
      entries: [],
      cosigns: {
        "https://example/pull/1": { state: "open" },
        "https://example/pull/2": { notAState: true },
      },
    };

    const ledger = ingestLedger(raw);

    expect(ledger.cosigns).toEqual({ "https://example/pull/1": { state: "open" } });
  });

  it("distinguishes an offline serve (no cosigns) from an empty co-sign map", () => {
    expect(ingestLedger({ generatedAt: "now", entries: [] }).cosigns).toBeUndefined();
    expect(ingestLedger({ generatedAt: "now", entries: [], cosigns: {} }).cosigns).toEqual({});
  });

  it("fails loudly — endpoint and field path — when the envelope itself is wrong", () => {
    const missing = () => ingestLedger({ entries: [] });
    expect(missing).toThrow(WireParseError);
    try {
      missing();
    } catch (error) {
      expect((error as WireParseError).endpoint).toBe("GET /api/ledger");
      expect((error as WireParseError).issues[0].path).toBe("generatedAt");
    }

    expect(() => ingestLedger("nope")).toThrow(WireParseError);
    expect(() => ingestLedger(null)).toThrow(WireParseError);
  });
});

describe("ingestInflight", () => {
  it("keeps the readable live records and counts the rest", () => {
    const raw = {
      generatedAt: "now",
      runs: [inflight({ runId: "live-1" }), { ...inflight(), v: 2 }, inflight({ runId: "live-2" })],
    };

    const result = ingestInflight(raw);

    expect(result.runs.map((r) => r.runId)).toEqual(["live-1", "live-2"]);
    expect(result.unreadable).toBe(1);
  });

  it("degrades to no live runs when the runs field is absent, without throwing", () => {
    expect(ingestInflight({ generatedAt: "now" }).runs).toEqual([]);
  });

  it("fails loudly on a broken container — same invariant as the ledger sibling", () => {
    expect(() => ingestInflight("nope")).toThrow(WireParseError);
    // A missing `generatedAt` is a broken container, not a tolerable record gap.
    const missing = () => ingestInflight({ runs: [] });
    expect(missing).toThrow(WireParseError);
    try {
      missing();
    } catch (error) {
      expect((error as WireParseError).endpoint).toBe("GET /api/inflight");
      expect((error as WireParseError).issues[0].path).toBe("generatedAt");
    }
  });
});
