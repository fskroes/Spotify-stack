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
      { name: "vitest", label: "npm run test", ok: true, summary: "", durationMs: 3200 },
    ],
    verifySummary: "VERIFY PASSED\n✔ npm run test passed (3.2s)",
    verdict: {
      verdict: "approve",
      violations: [],
      guidance: "",
      rationale: "touches only the new test file; no production code changed; all checks green",
    },
    vetoes: [],
    judgeName: "claude-opus-4-8",
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
  it("answers what/why/what-not/who-checked/undo without the diff", () => {
    const body = buildPrBody(input());

    // Header: risk chip + system voice.
    expect(body).toContain("**Risk: drudgery**");
    expect(body).toContain("co-signing a verified change, not reviewing raw agent output");

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
    expect(body).toContain("claude-opus-4-8: approved — touches only the new test file");

    // Undo: one step, real sha.
    expect(body).toContain("`git revert abc1234`");

    // Accountability + fleet record.
    expect(body).toContain("a fleet defect, not a reviewer failure");
    expect(body).toContain("https://github.com/o/control/issues/new");
    expect(body).toContain("Last 30 days: 1 shipped · 1 killed before review");
  });

  it("shows the veto trail as an immune-system trace", () => {
    const body = buildPrBody(
      input({
        vetoes: [
          {
            verdict: "veto",
            violations: ["package-lock.json modified without being asked"],
            guidance: "revert it",
            rationale: "lockfile drift",
          },
        ],
      }),
    );
    expect(body).toContain("Attempt 1 vetoed (package-lock.json modified without being asked) → corrected → re-judged.");
    expect(body).toContain("Final verdict after 1 correction: approved.");
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
