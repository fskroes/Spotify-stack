import { describe, expect, it } from "vitest";
import {
  awaitingReview,
  closeReasonProblem,
  MAX_REASON_LENGTH,
  mergeBlocker,
  parseCosignResult,
} from "../src/cosign-result.js";

// Structurally verbatim from a real capture (2026-07-14): `pnpm fleet cosign
// <runId> --merge --json` against an already-merged shipped run. pnpm's script
// banner precedes the JSON — the contract is "the last JSON line of the
// output", never "the last line". Private identifiers scrubbed per the
// public-repo policy; shape and ordering untouched.
const REAL_REFUSAL_OUTPUT = [
  "> spotify-stack@0.1.0 fleet /srv/spotify-stack",
  "> tsx packages/cli/src/index.ts cosign 9c69a13d-37fb-483a-8424-5c5f3faaee56 --merge --json",
  "",
  '{"action":"merge","runId":"9c69a13d-37fb-483a-8424-5c5f3faaee56","task":"onramp-1-feed-tests","repo":"demo-feed-service","prUrl":"https://github.com/example/demo-feed-service/pull/1","ok":false,"refusals":[{"code":"already-merged","detail":"the PR is already merged"}]}',
].join("\n");

const SUCCESS_LINE =
  '{"action":"merge","runId":"9c69a13d-37fb-483a-8424-5c5f3faaee56","task":"onramp-1-feed-tests","repo":"demo-feed-service","prUrl":"https://github.com/example/demo-feed-service/pull/1","ok":true,"state":"merged","mergedSha":"8df31c2","mergedBy":"operator","mergedAt":"2026-07-14T09:12:44Z","refusals":[]}';

describe("parseCosignResult", () => {
  it("reads the structured refusal from real pnpm-bannered output", () => {
    const result = parseCosignResult(REAL_REFUSAL_OUTPUT);

    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect(result!.action).toBe("merge");
    expect(result!.runId).toBe("9c69a13d-37fb-483a-8424-5c5f3faaee56");
    expect(result!.refusals).toEqual([
      { code: "already-merged", detail: "the PR is already merged" },
    ]);
  });

  it("reads the merge receipt fields from a success line", () => {
    const result = parseCosignResult(`${SUCCESS_LINE}\n`);

    expect(result).toMatchObject({
      ok: true,
      state: "merged",
      mergedSha: "8df31c2",
      mergedBy: "operator",
      mergedAt: "2026-07-14T09:12:44Z",
      refusals: [],
    });
  });

  it("takes the last JSON line when noise follows the result", () => {
    // Hook-leaked stdout has broken JSON.parse before (the judge CLI); the
    // parser scans from the end for the last line that is a cosign result.
    const output = `${SUCCESS_LINE}\n ELIFECYCLE  Command failed with exit code 1.\n`;

    expect(parseCosignResult(output)?.state).toBe("merged");
  });

  it("returns null when no line is a cosign result", () => {
    expect(parseCosignResult("")).toBeNull();
    expect(parseCosignResult("ssh: connect to host runner port 22: timed out")).toBeNull();
    // JSON, but not the cosign contract — e.g. a stray verdict object.
    expect(parseCosignResult('{"verdict":"approve"}')).toBeNull();
  });

  it("reads a close result the same way it reads a merge", () => {
    // Same channel, same pnpm banner — the close path shares the parser.
    const closed = [
      "> spotify-stack@0.1.0 fleet /srv/spotify-stack",
      "> tsx packages/cli/src/index.ts cosign 9c69a13d-37fb-483a-8424-5c5f3faaee56 --close --reason 'stale approach' --json",
      "",
      '{"action":"close","runId":"9c69a13d-37fb-483a-8424-5c5f3faaee56","task":"onramp-1-feed-tests","repo":"demo-feed-service","prUrl":"https://github.com/example/demo-feed-service/pull/1","ok":true,"state":"closed","refusals":[]}',
    ].join("\n");

    expect(parseCosignResult(closed)).toMatchObject({ ok: true, action: "close", state: "closed" });

    const refused =
      '{"action":"close","runId":"9c69a13d-37fb-483a-8424-5c5f3faaee56","ok":false,"refusals":[{"code":"already-merged","detail":"the PR is already merged"}]}';
    expect(parseCosignResult(refused)).toMatchObject({
      ok: false,
      action: "close",
      refusals: [{ code: "already-merged", detail: "the PR is already merged" }],
    });
  });
});

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

  it("offers the merge only for a shipped local run with a live open PR", () => {
    expect(mergeBlocker(mergeable)).toBeNull();
  });

  it("names the blocking reason for every run the gate would refuse", () => {
    expect(mergeBlocker({ kind: "inflight" })).toBe(
      "Run is still in progress — only shipped runs can be co-signed.",
    );
    expect(mergeBlocker({ ...mergeable, mode: "cloud" })).toBe(
      "Cloud run — review and merge on GitHub.",
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

  it("marks a shipped local run with a live open PR as awaiting review", () => {
    expect(awaitingReview(reviewable)).toBe(true);
  });

  it("never marks a cloud run — its review lives on GitHub", () => {
    expect(awaitingReview({ ...reviewable, mode: "cloud" })).toBe(false);
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
