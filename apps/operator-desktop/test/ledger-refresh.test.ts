import { describe, expect, it } from "vitest";
import {
  fleetRevision,
  ledgerRefreshDecision,
  refreshedLedgerUrl,
} from "../src/ledger-refresh.js";

describe("Fleet Ledger refresh", () => {
  const completed = [{
    runId: "run-1",
    ts: "2026-07-11T10:00:00.000Z",
    task: "task-1",
    repo: "repo-1",
    status: "approved",
  }];

  it("changes revision when a completed or in-flight run changes", () => {
    const baseline = fleetRevision(completed, []);
    const completedChanged = fleetRevision([...completed, { ...completed[0], runId: "run-2" }], []);
    const inflightChanged = fleetRevision(completed, [{
      runId: "run-live",
      stage: "verify",
      attempt: 1,
      stageSince: "2026-07-11T10:01:00.000Z",
    }]);

    expect(completedChanged).not.toBe(baseline);
    expect(inflightChanged).not.toBe(baseline);
    expect(fleetRevision(completed, [])).toBe(baseline);
    expect(ledgerRefreshDecision("", baseline)).toBe(false);
    expect(ledgerRefreshDecision(baseline, baseline)).toBe(false);
    expect(ledgerRefreshDecision(baseline, completedChanged)).toBe(true);
    expect(ledgerRefreshDecision(baseline, inflightChanged)).toBe(true);
  });

  it("adds a cache-busting token without discarding existing parameters", () => {
    expect(refreshedLedgerUrl("http://127.0.0.1:49152/?days=30", 42))
      .toBe("http://127.0.0.1:49152/?days=30&fleet-refresh=42");
  });
});
