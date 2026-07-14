import { describe, expect, it } from "vitest";
import { cosign, findRun, formatCosignResult, MAX_REASON_LENGTH, type CosignInput } from "../src/cosign.js";
import type { LedgerEntry } from "../src/ledger.js";

const PR_URL = "https://github.com/o/demo-feed-service/pull/12";

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ts: "2026-07-12T10:00:00.000Z",
    task: "004-upstream-failure-mode-tests",
    repo: "demo-feed-service",
    status: "approved",
    mode: "local",
    vetoes: 0,
    runId: "run-1",
    prUrl: PR_URL,
    ...overrides,
  };
}

/** A gh stub: records every call, answers `pr view` / `pr merge` / `pr close`. */
function ghStub(opts: {
  view?: { state?: string; mergeable?: string; mergeStateStatus?: string };
  mergedView?: Record<string, unknown> | Error;
  mergeError?: Error;
  closeError?: Error;
} = {}) {
  const calls: string[][] = [];
  let views = 0;
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      views += 1;
      if (views > 1) {
        // The post-merge receipt readback.
        if (opts.mergedView instanceof Error) throw opts.mergedView;
        return JSON.stringify(
          opts.mergedView ?? {
            mergeCommit: { oid: "abc1234def" },
            mergedBy: { login: "fernando" },
            mergedAt: "2026-07-12T10:05:00.000Z",
          },
        );
      }
      return JSON.stringify({
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        ...opts.view,
      });
    }
    if (args[0] === "pr" && args[1] === "merge") {
      if (opts.mergeError) throw opts.mergeError;
      return "";
    }
    if (args[0] === "pr" && args[1] === "close") {
      if (opts.closeError) throw opts.closeError;
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { gh, calls };
}

function input(overrides: Partial<CosignInput> = {}): CosignInput {
  return {
    entries: [entry()],
    runId: "run-1",
    action: "merge",
    gh: ghStub().gh,
    ...overrides,
  };
}

describe("findRun", () => {
  it("returns the latest ledger line for a runId", () => {
    const older = entry({ status: "vetoed" });
    const newer = entry({ ts: "2026-07-12T11:00:00.000Z" });
    expect(findRun([older, newer], "run-1")).toBe(newer);
  });

  it("returns undefined for an unknown runId", () => {
    expect(findRun([entry()], "run-999")).toBeUndefined();
  });
});

describe("cosign merge gates", () => {
  it("refuses a runId the ledger has never seen", () => {
    const result = cosign(input({ entries: [] }));
    expect(result.ok).toBe(false);
    expect(result.refusals[0].code).toBe("run-not-found");
  });

  it("gates a cloud run exactly like a local one — mode is not a refusal", () => {
    // The gate is mode-blind: a cloud run's evidence reaches the operator via
    // the artifact sync, so an approved, mergeable cloud run merges here.
    const { gh, calls } = ghStub();
    const result = cosign(input({ entries: [entry({ mode: "cloud" })], gh }));
    expect(result.ok).toBe(true);
    expect(result.state).toBe("merged");
    expect(calls).toContainEqual(["pr", "merge", PR_URL, "--squash", "--delete-branch"]);
  });

  it.each(["agent-failed", "verify-failed", "vetoed", "scope-violation", "engine-failed", "no-changes"])(
    "refuses a %s run as not shipped",
    (status) => {
      const result = cosign(input({ entries: [entry({ status, reason: "✖ npm test failed" })] }));
      expect(result.ok).toBe(false);
      expect(result.refusals[0].code).toBe("not-shipped");
      expect(result.refusals[0].detail).toContain(status);
      expect(result.refusals[0].detail).toContain("✖ npm test failed");
    },
  );

  it("falls back to the first evidence line when a kill has no reason", () => {
    const result = cosign(
      input({ entries: [entry({ status: "vetoed", evidence: ["judge: touches prod code"] })] }),
    );
    expect(result.refusals[0].detail).toContain("judge: touches prod code");
  });

  it("refuses a dry-run that never opened a PR", () => {
    const result = cosign(input({ entries: [entry({ prUrl: undefined })] }));
    expect(result.refusals[0].code).toBe("no-pr");
    expect(result.refusals[0].detail).toContain("--pr");
  });

  it("refuses an already-merged PR", () => {
    const { gh } = ghStub({ view: { state: "MERGED" } });
    const result = cosign(input({ gh }));
    expect(result.refusals[0].code).toBe("already-merged");
  });

  it("refuses an already-closed PR", () => {
    const { gh } = ghStub({ view: { state: "CLOSED" } });
    const result = cosign(input({ gh }));
    expect(result.refusals[0].code).toBe("already-closed");
  });

  it("refuses a conflicting PR", () => {
    const { gh } = ghStub({ view: { mergeable: "CONFLICTING" } });
    const result = cosign(input({ gh }));
    expect(result.refusals[0].code).toBe("conflicts");
  });

  it.each(["BLOCKED", "BEHIND", "UNSTABLE", "DIRTY", "DRAFT"])(
    "refuses when GitHub reports mergeStateStatus %s",
    (mergeStateStatus) => {
      const { gh } = ghStub({ view: { mergeStateStatus } });
      const result = cosign(input({ gh }));
      expect(result.refusals[0].code).toBe("not-mergeable");
      expect(result.refusals[0].detail).toContain(mergeStateStatus);
    },
  );

  it("reports a gh merge failure as a refusal, not a crash", () => {
    const { gh } = ghStub({ mergeError: new Error("GraphQL: base branch was modified") });
    const result = cosign(input({ gh }));
    expect(result.ok).toBe(false);
    expect(result.refusals[0].code).toBe("merge-failed");
    expect(result.refusals[0].detail).toContain("base branch was modified");
  });
});

describe("cosign merge", () => {
  it("squash-merges with branch deletion and reads back the receipt", () => {
    const { gh, calls } = ghStub();
    const result = cosign(input({ gh }));
    expect(result.ok).toBe(true);
    expect(result.state).toBe("merged");
    expect(result.task).toBe("004-upstream-failure-mode-tests");
    expect(result.repo).toBe("demo-feed-service");
    expect(result.prUrl).toBe(PR_URL);
    expect(result.mergedSha).toBe("abc1234");
    expect(result.mergedBy).toBe("fernando");
    expect(result.mergedAt).toBe("2026-07-12T10:05:00.000Z");
    const merge = calls.find((c) => c[1] === "merge");
    expect(merge).toEqual(["pr", "merge", PR_URL, "--squash", "--delete-branch"]);
  });

  it("stays a success when the receipt readback fails — the merge happened", () => {
    const { gh } = ghStub({ mergedView: new Error("network down") });
    const result = cosign(input({ gh }));
    expect(result.ok).toBe(true);
    expect(result.state).toBe("merged");
    expect(result.mergedSha).toBeUndefined();
  });

  it("uses the latest ledger line when a runId appears twice", () => {
    const stale = entry({ status: "verify-failed", prUrl: undefined });
    const result = cosign(input({ entries: [stale, entry()] }));
    expect(result.ok).toBe(true);
  });
});

describe("cosign close", () => {
  it("closes with the reason as a PR comment", () => {
    const { gh, calls } = ghStub();
    const result = cosign(input({ action: "close", reason: "touches prod code beyond the task", gh }));
    expect(result.ok).toBe(true);
    expect(result.state).toBe("closed");
    const close = calls.find((c) => c[1] === "close");
    expect(close).toEqual(["pr", "close", PR_URL, "--comment", "touches prod code beyond the task"]);
  });

  it("closes even when the PR is not cleanly mergeable — closing needs no merge gate", () => {
    const { gh } = ghStub({ view: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } });
    const result = cosign(input({ action: "close", reason: "superseded", gh }));
    expect(result.ok).toBe(true);
  });

  it("closes a cloud run like a local one, but still refuses a run without a PR", () => {
    expect(cosign(input({ action: "close", reason: "r", entries: [entry({ mode: "cloud" })] })).ok).toBe(true);
    expect(cosign(input({ action: "close", reason: "r", entries: [entry({ prUrl: undefined })] })).refusals[0].code).toBe("no-pr");
  });

  it("requires a reason", () => {
    expect(() => cosign(input({ action: "close" }))).toThrow(/--reason/);
    expect(() => cosign(input({ action: "close", reason: "   " }))).toThrow(/--reason/);
  });

  it("caps the reason length", () => {
    const reason = "x".repeat(MAX_REASON_LENGTH + 1);
    expect(() => cosign(input({ action: "close", reason }))).toThrow(/capped/);
  });

  it("reports a gh close failure as a refusal", () => {
    const { gh } = ghStub({ closeError: new Error("HTTP 403") });
    const result = cosign(input({ action: "close", reason: "r", gh }));
    expect(result.refusals[0].code).toBe("close-failed");
  });
});

describe("formatCosignResult", () => {
  it("renders a refusal with its code, detail, and run", () => {
    const result = cosign(input({ entries: [entry({ prUrl: undefined })] }));
    const text = formatCosignResult(result);
    expect(text).toContain("cosign refused (no-pr)");
    expect(text).toContain("004-upstream-failure-mode-tests on demo-feed-service");
  });

  it("renders a merge receipt with sha, merger, and branch deletion", () => {
    const text = formatCosignResult(cosign(input()));
    expect(text).toContain("squash-merged");
    expect(text).toContain("abc1234");
    expect(text).toContain("fernando");
    expect(text).toContain("branch: deleted");
  });

  it("renders a close as recorded", () => {
    const text = formatCosignResult(cosign(input({ action: "close", reason: "nope" })));
    expect(text).toContain("closed without merging");
    expect(text).toContain("reason recorded as a PR comment");
  });
});
