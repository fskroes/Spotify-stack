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
      // A status no build produces any more — `vetoed` was one until the judge's
      // vocabulary was removed. It belongs to no bucket, so it must be counted
      // as unclassified rather than dropped.
      entry({ status: "vetoed", reason: "out-of-scope refactor" }),
      entry({ status: "verify-failed", reason: "npm run test failed" }),
      entry({ status: "scope-violation", reason: "out-of-scope files: package-lock.json" }),
      entry({ status: "agent-failed" }),
      entry({ status: "engine-failed" }),
      entry({ status: "no-changes" }),
    ];
    const record = fleetRecord(entries, { now: NOW });

    expect(record.shipped).toBe(2);
    expect(record.killed).toBe(3);
    expect(record.verifyFailures).toBe(1);
    expect(record.scopeViolations).toBe(1);
    expect(record.agentFailures).toBe(1);
    expect(record.infra).toBe(1);
    expect(record.neutral).toBe(1);
    expect(record.unclassified).toBe(1);
    expect(record.kills).toHaveLength(3);
    // Every row in the window lands in exactly one bucket. This is the property
    // that makes the tally readable: a row can never go missing quietly.
    const { shipped, killed, infra, neutral, unclassified } = record;
    expect(shipped + killed + infra + neutral + unclassified).toBe(entries.length);
  });

  it("windows by days and sorts kills newest first", () => {
    const entries = [
      entry({ ts: "2026-05-01T00:00:00Z", status: "verify-failed" }), // outside 30d
      entry({ ts: "2026-06-20T00:00:00Z", status: "verify-failed" }),
      entry({ ts: "2026-07-05T00:00:00Z", status: "scope-violation" }),
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
      [entry({ status: "approved" }), entry({ status: "verify-failed" }), entry({ status: "scope-violation" })],
      { now: NOW },
    );
    expect(formatRecordLine(record)).toBe(
      "Last 30 days: 1 shipped · 2 killed before review (1 verify failure, 1 scope violation).",
    );
  });

  it("says so on the line when a row's status is one this build cannot classify", () => {
    // The silent version of this is the dangerous one: the row is in neither
    // the shipped count nor the killed count, so a record with runs missing
    // from it reads exactly like a record with none (ADR-0004).
    const record = fleetRecord([entry({ status: "approved" }), entry({ status: "vetoed" })], { now: NOW });

    // Outside the parenthesis: that breakdown itemises the kills, and this run
    // is not one. Inside, it would read as a "0 killed" that lists an item.
    expect(formatRecordLine(record)).toBe(
      "Last 30 days: 1 shipped · 0 killed before review (0 verify failures, 0 scope violations)." +
        " 1 further run carries a status this build cannot classify, and is in neither count.",
    );
  });

  it("counts a status that collides with an Object prototype key as unclassified", () => {
    // `status` is a plain string on the wire, so `"constructor"` reaches the
    // fate-table lookup. Indexed naively it resolves through the prototype to a
    // truthy value, and the row is then neither classified nor reported —
    // precisely the silent drop `unclassified` exists to make impossible.
    for (const status of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const record = fleetRecord([entry({ status: "approved" }), entry({ status })], { now: NOW });

      expect(record.unclassified, status).toBe(1);
      const { shipped, killed, infra, neutral, unclassified } = record;
      expect(shipped + killed + infra + neutral + unclassified, status).toBe(2);
    }
  });
});
