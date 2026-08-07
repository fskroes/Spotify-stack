import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../src/wire.js";
import {
  appendLedger,
  fleetRecord,
  formatRecordLine,
  readLedger,
} from "../src/ledger.js";

const NOW = new Date("2026-07-06T12:00:00Z");

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    ts: "2026-07-01T00:00:00Z",
    task: "004-x",
    repo: "demo-feed-service",
    status: "approved",
    mode: "local",
    vetoes: 0,
    ...overrides,
  };
}

describe("ledger append/read", () => {
  it("round-trips entries as JSONL and omits absent optional fields", () => {
    const ledgerPath = path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-ledger-")), "ledger.jsonl");
    expect(readLedger(ledgerPath)).toEqual([]);

    appendLedger(ledgerPath, entry({ status: "approved", prUrl: "https://example.test/pr/1" }));
    appendLedger(ledgerPath, entry({ status: "vetoed", vetoes: 3, reason: "stub: change rejected" }));

    const entries = readLedger(ledgerPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].prUrl).toBe("https://example.test/pr/1");
    expect(entries[0]).not.toHaveProperty("reason");
    expect(entries[1].reason).toBe("stub: change rejected");
    expect(entries[1].vetoes).toBe(3);
  });
});

describe("fleetRecord", () => {
  it("classifies statuses into shipped / killed / infra / neutral", () => {
    const entries = [
      entry({ status: "approved" }),
      entry({ status: "approved" }),
      entry({ status: "vetoed", reason: "out-of-scope refactor" }),
      entry({ status: "verify-failed", reason: "npm run test failed" }),
      entry({ status: "scope-violation", reason: "out-of-scope files: package-lock.json" }),
      entry({ status: "agent-failed" }),
      entry({ status: "engine-failed" }),
      entry({ status: "no-changes" }),
    ];
    const record = fleetRecord(entries, { now: NOW });

    expect(record.shipped).toBe(2);
    expect(record.killed).toBe(4);
    expect(record.judgeVetoes).toBe(1);
    expect(record.verifyFailures).toBe(1);
    expect(record.scopeViolations).toBe(1);
    expect(record.agentFailures).toBe(1);
    expect(record.infra).toBe(1);
    expect(record.neutral).toBe(1);
    expect(record.kills).toHaveLength(4);
  });

  it("windows by days and sorts kills newest first", () => {
    const entries = [
      entry({ ts: "2026-05-01T00:00:00Z", status: "vetoed" }), // outside 30d
      entry({ ts: "2026-06-20T00:00:00Z", status: "verify-failed" }),
      entry({ ts: "2026-07-05T00:00:00Z", status: "vetoed" }),
      entry({ ts: "2026-05-01T00:00:00Z", status: "approved" }), // outside 30d
    ];
    const record = fleetRecord(entries, { days: 30, now: NOW });

    expect(record.shipped).toBe(0);
    expect(record.killed).toBe(2);
    expect(record.kills.map((k) => k.ts)).toEqual([
      "2026-07-05T00:00:00Z",
      "2026-06-20T00:00:00Z",
    ]);

    // A wider window picks the old entries back up.
    expect(fleetRecord(entries, { days: 90, now: NOW }).shipped).toBe(1);
  });

  it("formats the record line", () => {
    const record = fleetRecord(
      [
        entry({ status: "approved" }),
        entry({ status: "vetoed" }),
        entry({ status: "verify-failed" }),
        entry({ status: "scope-violation" }),
      ],
      { now: NOW },
    );
    expect(formatRecordLine(record)).toBe(
      "Last 30 days: 1 shipped · 3 killed before review (1 judge veto, 1 verify failure, 1 scope violation).",
    );
  });
});
