import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendLedger,
  fleetRecord,
  formatRecordLine,
  readLedger,
  type LedgerEntry,
} from "../src/ledger.js";
import { renderLedgerHtml } from "../src/ledger-html.js";

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

describe("renderLedgerHtml", () => {
  const entries = [
    entry({ ts: "2026-07-05T09:00:00Z", status: "approved", prUrl: "https://github.com/o/r/pull/11" }),
    entry({ ts: "2026-07-05T10:00:00Z", status: "vetoed", reason: "regenerated the entire lockfile" }),
    entry({ ts: "2026-07-05T11:00:00Z", status: "scope-violation", reason: "out-of-scope files: package-lock.json" }),
    entry({ ts: "2026-07-05T12:00:00Z", status: "engine-failed" }),
    entry({ ts: "2026-05-01T00:00:00Z", status: "vetoed", reason: "old, outside window" }),
  ];

  it("is a self-contained page with no external fetches", () => {
    const html = renderLedgerHtml(entries, { now: NOW });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("FLEET LEDGER");
    // No CDN fonts, stylesheets, or remote assets — it must render offline.
    expect(html).not.toMatch(/https?:\/\/fonts\./);
    expect(html).not.toContain("support.js");
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet/i);
  });

  it("renders real stat numbers and windows out old entries", () => {
    const html = renderLedgerHtml(entries, { now: NOW });
    // 4 runs in the 30-day window (the May entry is excluded).
    expect(html).toContain("4 runs · in window");
    // decided = 1 shipped + 2 killed; kill rate = 2/3 = 67%.
    expect(html).toContain("67%");
    // The windowed kill reasons appear; the out-of-window one does not.
    expect(html).toContain("regenerated the entire lockfile");
    expect(html).not.toContain("old, outside window");
    // The approved run's PR is linked as #11.
    expect(html).toContain(">#11 ↗<");
  });

  it("escapes reason text so a run cannot inject markup", () => {
    const html = renderLedgerHtml([entry({ status: "vetoed", reason: "<script>x</script>" })], { now: NOW });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("shows an empty state without throwing on an empty ledger", () => {
    const html = renderLedgerHtml([], { now: NOW });
    expect(html).toContain("The ledger is empty");
    expect(html).toContain("Kill rate");
  });

  it("surfaces enriched per-run data: title, sha, elapsed, trace and evidence", () => {
    const html = renderLedgerHtml(
      [
        entry({
          status: "vetoed",
          title: "Bump lodash 4.17.19 → 4.17.21",
          sha: "a1b2c3d",
          elapsedMs: 92_000,
          timings: { agentMs: 60_000, verifyMs: 20_000, judgeMs: 12_000 },
          reason: "regenerated the entire lockfile",
          evidence: ["+ 6,214 insertions", "veto: single-dep bump must touch one lock entry"],
        }),
      ],
      { now: NOW },
    );
    expect(html).toContain("Bump lodash 4.17.19 → 4.17.21"); // title, not just id
    expect(html).toContain("a1b2c3d"); // short sha
    expect(html).toContain("1.5m"); // 92s total elapsed
    expect(html).toContain("openDrawer(0)"); // row opens its drawer
    expect(html).toContain("Pipeline trace");
    expect(html).toContain("VETOED"); // died at the judge stage in the trace
    expect(html).toContain("Evidence on record");
    expect(html).toContain("veto: single-dep bump must touch one lock entry");
  });

  it("degrades gracefully when an old entry has no enriched fields", () => {
    const html = renderLedgerHtml([entry({ status: "approved" })], { now: NOW });
    // Falls back to the task id when there's no title, and dashes the missing elapsed.
    expect(html).toContain("004-x");
    expect(html).toContain("—");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });

  it("renders the 14-day trend with per-day shipped/killed counts", () => {
    const html = renderLedgerHtml(entries, { now: NOW });
    // 2026-07-05 (yesterday relative to NOW) had 1 shipped, 2 killed, 1 infra.
    expect(html).toContain("2026-07-05 · 1 shipped · 2 killed · 1 other");
    // A day with no runs still gets a column (empty baseline, zero counts).
    expect(html).toContain("2026-07-01 · 0 shipped · 0 killed");
    // The trend is now its own tab; the old chip-row mini-trend label is gone.
    expect(html).toContain('data-view="trend"');
    expect(html).not.toContain(">Trend <span");
  });

  it("exposes all five tab views", () => {
    const html = renderLedgerHtml(entries, { now: NOW });
    for (const view of ["ledger", "flow", "funnel", "patterns", "trend"]) {
      expect(html).toContain(`data-view="${view}"`);
      expect(html).toContain(`id="view-${view}"`);
    }
  });

  it("renders the Flow explainer statically without external assets", () => {
    const html = renderLedgerHtml(entries, { now: NOW });
    expect(html).toContain("The worker gets a sealed room");
    expect(html).toContain("Propose, never publish");
    // The Flow port must not drag in the mockup's Google Fonts / support.js.
    expect(html).not.toMatch(/https?:\/\/fonts\./);
    expect(html).not.toContain("support.js");
  });

  it("gives a young ledger an honest trend headline instead of overclaiming", () => {
    // A single day with runs → not enough history to call a trend.
    const html = renderLedgerHtml(
      [entry({ ts: "2026-07-05T09:00:00Z", status: "approved" })],
      { now: NOW },
    );
    expect(html).toContain("Too little history to call a trend");
  });

  it("flags a repeat-offender task from real kills, and stays silent otherwise", () => {
    const repeated = [
      entry({ ts: "2026-07-05T09:00:00Z", task: "004-lock", status: "vetoed", title: "Bump lodash", reason: "regenerated the lockfile" }),
      entry({ ts: "2026-07-05T10:00:00Z", task: "004-lock", status: "vetoed", title: "Bump lodash", reason: "regenerated the lockfile" }),
      entry({ ts: "2026-07-05T11:00:00Z", task: "004-lock", status: "vetoed", title: "Bump lodash", reason: "regenerated the lockfile" }),
    ];
    const flagged = renderLedgerHtml(repeated, { now: NOW });
    expect(flagged).toContain("Flagged for prompt/verifier review");
    expect(flagged).toContain("004-lock");
    expect(flagged).toContain("3×");
    expect(flagged).toContain("judge gate");
    expect(flagged).toContain("Kills by reason");
    expect(flagged).toContain("Repeat offenders");
    // The offender card jumps back to a pre-filtered ledger.
    expect(flagged).toContain(`data-task="004-lock"`);
    expect(flagged).toContain("jumpToTask");

    // One-off kills across distinct tasks trip no flag.
    const scattered = renderLedgerHtml(
      [
        entry({ ts: "2026-07-05T09:00:00Z", task: "a-1", status: "vetoed", reason: "r1" }),
        entry({ ts: "2026-07-05T10:00:00Z", task: "b-2", status: "verify-failed", reason: "r2" }),
      ],
      { now: NOW },
    );
    expect(scattered).not.toContain("Flagged for prompt/verifier review");
  });

  it("offers a repo filter over the distinct repos and escapes them", () => {
    const html = renderLedgerHtml(
      [
        entry({ ts: "2026-07-05T09:00:00Z", repo: "api-core", status: "approved" }),
        entry({ ts: "2026-07-05T10:00:00Z", repo: 'a"b<c', status: "vetoed", reason: "x" }),
      ],
      { now: NOW },
    );
    expect(html).toContain('id="fRepo"');
    expect(html).toContain('<option value="api-core">api-core</option>');
    // The malicious repo name is escaped in both the option and the row's data-repo.
    expect(html).not.toContain('a"b<c');
    expect(html).toContain("a&quot;b&lt;c");
  });

  it("renders the time-window scrubber with one bucket per day", () => {
    const html = renderLedgerHtml(entries, { now: NOW, days: 30 });
    expect(html).toContain('id="scrub"');
    expect(html).toContain('id="scrubFrom"');
    expect(html).toContain('id="scrubTo"');
    expect(html).toContain('data-day="');
    // 30-day window → 30 histogram buckets.
    expect((html.match(/data-b="/g) ?? []).length).toBe(30);
  });

  it("shows where a run was dispatched in the drawer, for local and cloud", () => {
    const local = renderLedgerHtml([entry({ status: "approved", mode: "local" })], { now: NOW });
    expect(local).toContain("Dispatched to Local machine");

    const cloud = renderLedgerHtml(
      [entry({ status: "approved", mode: "cloud", prUrl: "https://github.com/o/r/pull/9" })],
      { now: NOW },
    );
    expect(cloud).toContain("Dispatched to GitHub Flow");
    expect(cloud).toContain("https://github.com/o/r/pull/9");
    // No prompt section — the ledger records no prompt, so we invent none.
    expect(cloud).not.toContain("Task prompt");
  });

  it("shows co-sign state only when the caller supplies it", () => {
    const shipped = entry({ ts: "2026-07-05T09:00:00Z", status: "approved", prUrl: "https://github.com/o/r/pull/11" });

    // Without cosign data: no merge claims, the human gate is just a queue.
    const plain = renderLedgerHtml([shipped], { now: NOW });
    expect(plain).toContain("shipped for review");
    expect(plain).not.toContain("Co-signed");
    expect(plain).not.toContain("co-signed by");
    // The Trend card also stays honest about unknown merge state.
    expect(plain).toContain("merge state not fetched — generate with --cosign");

    // With cosign data: chip, PR-cell state, and the drawer's human gate.
    const cosigned = renderLedgerHtml([shipped], {
      now: NOW,
      cosigns: {
        "https://github.com/o/r/pull/11": { state: "merged", mergedBy: "octocat", mergedAt: "2026-07-05T13:03:37Z" },
      },
    });
    expect(cosigned).toContain("Co-signed");
    expect(cosigned).toContain("1/1");
    expect(cosigned).toContain("co-signed by octocat");
    // The Trend card reflects the same co-sign fraction over its 14-day window.
    expect(cosigned).toContain("were co-signed");

    // An open PR reads as awaiting, not merged.
    const open = renderLedgerHtml([shipped], {
      now: NOW,
      cosigns: { "https://github.com/o/r/pull/11": { state: "open" } },
    });
    expect(open).toContain("awaiting co-sign");
    expect(open).toContain("0/1");
  });

  it("injects the live-reload client only when liveReload is set", () => {
    const live = renderLedgerHtml(entries, { now: NOW, liveReload: true });
    expect(live).toContain("new EventSource");
    expect(live).toContain('"/events"');

    // The static path (the committed report / after-run regenerate) stays clean.
    const staticHtml = renderLedgerHtml(entries, { now: NOW });
    expect(staticHtml).not.toContain("new EventSource");
    expect(staticHtml).not.toContain('"/events"');
  });

});
