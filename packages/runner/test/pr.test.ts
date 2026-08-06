import { describe, expect, it } from "vitest";
import { fleetRecord } from "../src/ledger.js";
import { buildPrBody, diffStats, type PrBodyInput } from "../src/pr.js";
import type { Task } from "../src/task.js";

const DIFF = [
  "diff --git a/tests/feed.test.js b/tests/feed.test.js",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/tests/feed.test.js",
  "+line one",
  "+line two",
  "diff --git a/tests/other.test.js b/tests/other.test.js",
  "--- a/tests/other.test.js",
  "+++ b/tests/other.test.js",
  "-removed",
  "+added",
].join("\n");

const TASK: Task = {
  id: "onramp-1-feed-tests",
  title: "Add unit tests for the feed builder",
  targets: ["demo-feed-service"],
  scope: ["tests/feed.test.js"],
  risk: "drudgery",
  why: "buildFeed has zero tests.",
  body: "",
  raw: "",
};

function input(overrides: Partial<PrBodyInput> = {}): PrBodyInput {
  return {
    task: TASK,
    diff: DIFF,
    verifyChecks: [
      { name: "test", label: "npm run test", status: "passed", summary: "", durationMs: 3200 },
    ],
    verifyState: "passed",
    verifySummary: "VERIFY PASSED\n✔ npm run test passed (3.2s)",
    record: fleetRecord(
      [
        { ts: new Date().toISOString(), task: "a", repo: "r", status: "approved", mode: "local", vetoes: 0 },
        { ts: new Date().toISOString(), task: "b", repo: "r", status: "vetoed", mode: "local", vetoes: 1 },
      ],
    ),
    sha: "abc1234",
    taskFileUrl: "https://github.com/o/control/blob/main/tasks/onramp/onramp-1-feed-tests.md",
    newIssueUrl: "https://github.com/o/control/issues/new",
    ...overrides,
  };
}

describe("diffStats", () => {
  it("counts files, additions, and deletions, ignoring +++/--- headers", () => {
    expect(diffStats(DIFF)).toEqual({
      files: ["tests/feed.test.js", "tests/other.test.js"],
      additions: 3,
      deletions: 1,
    });
  });
});

describe("buildPrBody", () => {
  it("answers what/why/what-not/undo without the diff", () => {
    const body = buildPrBody(input());

    // Header: risk chip + system voice.
    expect(body).toContain("**Risk: drudgery**");
    expect(body).toContain("Nothing reviewed the change for intent; that is what you are doing now.");

    // What changed: diffstat + files.
    expect(body).toContain("2 files, +3 −1");
    expect(body).toContain("`tests/feed.test.js`");

    // Why: the task's sentence + task link.
    expect(body).toContain("buildFeed has zero tests.");
    expect(body).toContain("[`onramp-1-feed-tests`](https://github.com/o/control/blob/main/tasks/onramp/onramp-1-feed-tests.md)");

    // Scope statement + standing lockfile rule.
    expect(body).toContain("Mechanically confined to `tests/feed.test.js`");
    expect(body).toContain("kills any diff outside this scope before a human sees it");
    expect(body).toContain("lockfiles");

    // What actually ran: per-check reasoning, raw log collapsed.
    expect(body).toContain("✔ `npm run test` passed (3.2s)");
    expect(body).toContain("<details><summary>Raw verify log</summary>");

    // Judgment: model + rationale.

    // Undo: one step, real sha.
    expect(body).toContain("`git revert abc1234`");

    // Accountability + fleet record.
    expect(body).toContain("a fleet defect, not a reviewer failure");
    expect(body).toContain("https://github.com/o/control/issues/new");
    expect(body).toContain("Last 30 days: 1 shipped · 1 killed before review");
  });

  it("says nothing ran — and drops the verified claim — when verification was inconclusive", () => {
    const body = buildPrBody(
      input({
        verifyChecks: [],
        verifyState: "inconclusive",
        verifySummary: "VERIFY INCONCLUSIVE — no verifiers detected for this repository",
      }),
    );

    // The banner may not call this a verified change: nothing verified it.
    expect(body).not.toContain("Nothing reviewed the change for intent");
    expect(body).toContain("could not verify");
    // "What actually ran" must answer honestly: nothing did.
    expect(body).toContain("no verifiers detected");
    expect(body).toContain("nothing was executed");
    expect(body).not.toContain("passed");
  });

  it("names a mandated gate that never ran, and drops the verified claim", () => {
    // Checks ran and passed here — the hole is that they are not the set the
    // task demanded. The body sits above a request to co-sign, so "What
    // actually ran" has to be true at the moment it is read.
    const body = buildPrBody(
      input({
        verifyState: "inconclusive",
        unmetGates: ["live-contract-check"],
      }),
    );

    expect(body).not.toContain("Nothing reviewed the change for intent");
    expect(body).toContain("live-contract-check");
    // The other road to inconclusive must not be claimed: verifiers did run.
    expect(body).not.toContain("no verifiers detected");
    // And what did run is still reported, rather than discarded.
    expect(body).toContain("✔ `npm run test` passed (3.2s)");
  });

  it("shows no gate affordance when a task declared none or all were met", () => {
    for (const unmetGates of [undefined, []]) {
      const body = buildPrBody(input({ unmetGates }));
      expect(body).toContain("Nothing reviewed the change for intent");
      expect(body).not.toContain("mandated");
    }
  });

  // ADR-0014: an amended gate input is a loud fact, named with its reason in
  // the PR header. The reason is the half a reflexive operator cannot produce
  // without thinking, so it is quoted rather than summarised.
  it("names an amended gate input and its reason in the header", () => {
    const body = buildPrBody(
      input({
        gateInputs: {
          held: [],
          carried: [
            { glob: "tests/**", reason: "the asserted bound is off by one", files: ["tests/other.test.js"] },
          ],
          introduced: [],
          treeIsBase: false,
        },
      }),
    );

    expect(body).toContain("**Gate inputs**");
    expect(body).toContain("the asserted bound is off by one");
    expect(body).toContain("`tests/other.test.js`");
    expect(body).toContain("verified along with the rest of the diff");
  });

  // The other half, and the one that changes what a co-signer is agreeing to:
  // part of this diff is not part of what proved it.
  it("says which edits shipped without being verified", () => {
    const body = buildPrBody(
      input({ gateInputs: { held: ["tests/other.test.js"], carried: [], introduced: [], treeIsBase: false } }),
    );

    expect(body).toContain("**Gate input held at the base**");
    expect(body).toContain("the edit ships here unverified");
    expect(body).toContain("**not** part of what proves this change");
    // Every check that ran was green, and the recorded state is still `passed`
    // — but the banner may not call this a verified change, because part of the
    // diff under the reviewer's eyes is not what verification saw.
    expect(body).not.toContain("Nothing reviewed the change for intent");
    expect(body).toContain("every check that ran was green");
  });

  it("shows no gate-input affordance on an ordinary diff", () => {
    for (const gateInputs of [undefined, { held: [], carried: [], introduced: [], treeIsBase: false }]) {
      const body = buildPrBody(input({ gateInputs }));
      expect(body).not.toContain("Gate input");
    }
  });

  it("marks a check that never ran as skipped, not passed", () => {
    const body = buildPrBody(
      input({
        verifyChecks: [
          { name: "eslint", label: "npm run lint", status: "failed", summary: "1 error", durationMs: 900 },
          { name: "test", label: "npm run test", status: "skipped", summary: "", durationMs: 0 },
        ],
        verifyState: "failed",
        verifySummary: "VERIFY FAILED",
      }),
    );

    expect(body).toContain("✖ `npm run lint` FAILED (0.9s)");
    expect(body).toContain("– `npm run test` did not run (earlier check failed)");
  });

  it("falls back cleanly without scope, sha, or links", () => {
    const body = buildPrBody(
      input({
        task: { ...TASK, scope: undefined },
        sha: undefined,
        taskFileUrl: undefined,
        newIssueUrl: undefined,
      }),
    );
    expect(body).toContain("no scope contract");
    expect(body).toContain("`git revert <sha>`");
    expect(body).toContain("open an issue on the fleet control repo");
    expect(body).toContain("`onramp-1-feed-tests`");
  });
});
