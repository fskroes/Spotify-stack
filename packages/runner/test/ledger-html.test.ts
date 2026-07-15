import { describe, expect, it } from "vitest";
import { renderLedgerHtml } from "../src/ledger-html.js";
import type { InflightRecord, LedgerEntry } from "@fleet/contract";

const NOW = new Date("2026-07-09T12:10:00.000Z");

/** Both timestamps are pinned: the report stamps `generatedAt` into the header. */
const opts = { now: NOW, generatedAt: NOW };

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ts: "2026-07-09T11:00:00.000Z",
    task: "001-ts-migrate-http-client",
    repo: "demo-feed-service",
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
    startedAt: "2026-07-09T12:00:00.000Z",
    task: "002-dedupe-feed-items",
    repo: "demo-feed-service",
    title: "Dedupe feed items on ingest",
    stage: "verify",
    attempt: 1,
    stageSince: "2026-07-09T12:09:30.000Z",
    ...overrides,
  };
}

describe("renderLedgerHtml · the static report", () => {
  it("is byte-identical with and without in-flight runs when liveReload is off", () => {
    const entries = [entry(), entry({ status: "vetoed", ts: "2026-07-09T10:00:00.000Z" })];

    const bare = renderLedgerHtml(entries, opts);
    const withLive = renderLedgerHtml(entries, { ...opts, inflight: [inflight(), inflight({ pid: 7, runId: "run-2" })] });

    // The committed report is a snapshot: a frozen file may not claim anything
    // is still moving. Byte-identical, not merely "looks the same".
    expect(withLive).toBe(bare);
    expect(bare).not.toContain("In flight");
  });
});

describe("renderLedgerHtml · the Live lane", () => {
  const render = (records: InflightRecord[], entries: LedgerEntry[] = [entry()]) =>
    renderLedgerHtml(entries, { ...opts, liveReload: true, inflight: records });

  it("draws a row per in-flight run, with its stage, elapsed, and repo", () => {
    const html = render([inflight()]);

    expect(html).toContain("Dedupe feed items on ingest");
    expect(html).toContain("002-dedupe-feed-items · demo-feed-service");
    expect(html).toContain("In flight · 1");
    expect(html).toContain("1 in flight"); // the header-strip chip, visible from every tab
    expect(html).toContain(">10m 00s<"); // startedAt → now
    expect(html).toContain(">30s<"); // stageSince → now
  });

  it("badges a run that has bounced back through the loop", () => {
    expect(render([inflight({ stage: "agent", attempt: 2 })])).toContain("↺ attempt 2");
    expect(render([inflight()])).not.toContain("↺ attempt");
  });

  it("drops a live row whose runId already reached the ledger", () => {
    // `finish()` appends the ledger line before it unlinks the in-flight record,
    // so for an instant a run is both. It must render once, as decided.
    const decided = entry({ runId: "run-live", title: "Dedupe feed items on ingest" });
    const html = render([inflight({ runId: "run-live" })], [decided]);

    expect(html).not.toContain("In flight");
    expect(html).toContain("Dedupe feed items on ingest"); // still in the ledger table
  });

  it("keeps live runs out of the funnel, the chips, and the record", () => {
    const decided = [entry({ status: "vetoed" })];
    const html = render([inflight(), inflight({ pid: 9, runId: "run-2" })], decided);

    // One decided run: dispatched 1, and the funnel entered 1 — not 3.
    expect(html).toContain(">1</div>"); // the Dispatched chip's value
    expect(html).toContain("Of 1 decided runs");
  });

  it("orders the lane longest-running first", () => {
    const html = render([
      inflight({ runId: "young", pid: 1, title: "Younger run", startedAt: "2026-07-09T12:05:00.000Z" }),
      inflight({ runId: "old", pid: 2, title: "Older run", startedAt: "2026-07-09T11:30:00.000Z" }),
    ]);

    expect(html.indexOf("Older run")).toBeLessThan(html.indexOf("Younger run"));
  });
});
