import { describe, expect, it } from "vitest";
import {
  awaitingReview,
  closeReasonProblem,
  MAX_REASON_LENGTH,
  mergeBlocker,
} from "../src/cosign-result.js";

// The stdout-line extraction (parseCosignStdout) now lives in @fleet/contract
// and is covered by its own contract test; this file keeps the operator gate
// logic that reads the parsed result.

describe("closeReasonProblem", () => {
  it("requires a reason — it is the PR comment", () => {
    expect(closeReasonProblem("")).toBe("A reason is required — it lands as the PR comment.");
    expect(closeReasonProblem("   \n ")).toBe("A reason is required — it lands as the PR comment.");
  });

  it("accepts anything up to the CLI's cap and refuses beyond it", () => {
    // The cap mirrors the CLI's — a reason accepted here is never rejected
    // after the fact by the runner.
    expect(MAX_REASON_LENGTH).toBe(500);
    expect(closeReasonProblem("judge missed it: empty feeds crash")).toBeNull();
    expect(closeReasonProblem("x".repeat(500))).toBeNull();
    expect(closeReasonProblem("x".repeat(501))).toBe(
      "The reason is 1 character over the 500-character cap.",
    );
    expect(closeReasonProblem("x".repeat(512))).toBe(
      "The reason is 12 characters over the 500-character cap.",
    );
  });

  it("judges the trimmed reason — surrounding whitespace is not sent", () => {
    expect(closeReasonProblem(`  ${"x".repeat(500)}  `)).toBeNull();
  });
});

describe("mergeBlocker", () => {
  const mergeable = {
    kind: "completed",
    mode: "local",
    status: "approved",
    prUrl: "https://github.com/example/demo-feed-service/pull/1",
    cosignState: "open",
  } as const;

  it("offers the merge for any shipped run with a live open PR — cloud included", () => {
    expect(mergeBlocker(mergeable)).toBeNull();
    // Mode-blind (#36): a synced cloud run is co-signable here too. Evidence
    // adjacency is enforced at the render site, not by this gate.
    expect(mergeBlocker({ ...mergeable, mode: "cloud" })).toBeNull();
  });

  it("names the blocking reason for every run the gate would refuse", () => {
    expect(mergeBlocker({ kind: "inflight" })).toBe(
      "Run is still in progress — only shipped runs can be co-signed.",
    );
    expect(mergeBlocker({ ...mergeable, status: "verify-failed" })).toBe(
      "Run is verify-failed — only approved runs can be merged.",
    );
    expect(mergeBlocker({ ...mergeable, prUrl: undefined })).toBe(
      "Run has no pull request — nothing to merge.",
    );
  });

  it("waits for live PR state rather than offering a blind merge", () => {
    expect(mergeBlocker({ ...mergeable, cosignState: undefined })).toBe(
      "Waiting for live pull-request state from the runner.",
    );
    expect(mergeBlocker({ ...mergeable, cosignState: "merged" })).toBe(
      "Pull request is already merged.",
    );
    expect(mergeBlocker({ ...mergeable, cosignState: "closed" })).toBe(
      "Pull request was closed without merging.",
    );
  });
});

describe("awaitingReview", () => {
  // Awaiting review is defined as "the merge gate would accept a co-sign
  // decision right now" — the attention state and the merge button can never
  // disagree about which runs need the operator.
  const reviewable = {
    kind: "completed",
    mode: "local",
    status: "approved",
    prUrl: "https://github.com/example/demo-feed-service/pull/1",
    cosignState: "open",
  } as const;

  it("marks a shipped run with a live open PR as awaiting review — cloud included", () => {
    expect(awaitingReview(reviewable)).toBe(true);
    // A synced cloud run needs the operator's co-sign exactly as a local one (#36).
    expect(awaitingReview({ ...reviewable, mode: "cloud" })).toBe(true);
  });

  it("leaves the attention state once the PR is merged or closed", () => {
    expect(awaitingReview({ ...reviewable, cosignState: "merged" })).toBe(false);
    expect(awaitingReview({ ...reviewable, cosignState: "closed" })).toBe(false);
  });

  it("is derived from live co-sign state, never assumed before it lands", () => {
    expect(awaitingReview({ ...reviewable, cosignState: undefined })).toBe(false);
  });

  it("excludes runs the gate would refuse anyway", () => {
    expect(awaitingReview({ kind: "inflight" })).toBe(false);
    expect(awaitingReview({ ...reviewable, status: "verify-failed" })).toBe(false);
    expect(awaitingReview({ ...reviewable, prUrl: undefined })).toBe(false);
  });
});
