/**
 * The absence lock: what a reader is *shown* for a ledger line that carries no
 * `verifyState`.
 *
 * Two facts about absence are both true and easy to conflate, and conflating
 * them cost a full session of analysis that reached the wrong answer:
 *
 *  - **In the record**, `verifyState` is absent on a good many lines today.
 *    `composedVerifyState` returns `undefined` whenever the pass produced no
 *    verification of its own ([ADR-0012](../docs/adr/0012-a-pass-reports-only-what-it-observed.md)),
 *    which is every empty diff (`no-changes`, `agent-failed`), every
 *    `scope-violation`, and an `engine-failed` whose agent invocation threw on
 *    pass 1. Absence is *not* only a pre-tri-state line.
 *  - **In a render**, absence resolves to "not recorded" — and that readout is
 *    reachable for `approved` alone, because `ApprovedPass.verify` is not
 *    optional. Every other status is answered from `status` before any surface
 *    reads the field. So the one thing a reader ever sees as "not recorded" *is*
 *    a line written before the tri-state existed, exactly as
 *    [`CONTEXT.md`](../CONTEXT.md#verification-state) says.
 *
 * Nothing enforced the second fact. It held by hand-written early returns — two
 * in `renderTimeline` — and reading the `diedAt`
 * gate without reading the six lines above it yields a table in which a
 * successful `no-changes` run reports itself as a gap. That table was wrong, but
 * it was wrong on the strength of the same evidence a careful reader has.
 *
 * This file is the oracle instead. It renders one entry per status with the
 * field withheld and asserts what comes out, so the property is a red build
 * rather than a thing you re-derive by reading — the same choice
 * `docs-drift.test.ts` makes for prose and `check-scrub.sh` makes for secrets.
 *
 * It covers the runner's report, which since the desktop operator was deleted
 * ([ADR-0026](../docs/adr/0026-the-desktop-operator-is-deleted.md)) is the only
 * surface that renders the field.
 *
 * ## On the wording
 *
 * The assertions anchor on the literal `"not recorded"` from `VERIFY_ROW`. If
 * that readout is reworded, the `approved` case fails with "the readout no longer
 * says …". That is the intended failure, not a false positive: it means a human
 * must re-point this lock, and it is what keeps the six negative assertions from
 * passing vacuously against a string that no longer exists.
 */
import { describe, expect, it } from "vitest";

import { RUN_STATUSES, type LedgerEntry, type RunStatus } from "../packages/runner/src/wire.js";
import { renderLedgerHtml } from "../packages/runner/src/ledger-html.js";

/** The readout a reader sees when the field says nothing (`ledger-html.ts`,
 *  `VERIFY_ROW.unknown`). Duplicated deliberately — see "On the wording". */
const NOT_RECORDED = "not recorded";

/** Fixed, because the report windows entries against `now` and a floating clock
 *  would make this suite's coverage depend on the hour it ran. */
const NOW = new Date("2026-07-30T12:00:00.000Z");

/**
 * A ledger line ending in `status` with `verifyState` **withheld** — the shape
 * the runner writes whenever the pass reached no verification of its own, and
 * the shape *every* line had before the tri-state existed.
 */
function lineWithoutVerifyState(status: RunStatus): LedgerEntry {
  return {
    ts: new Date(NOW.getTime() - 60_000).toISOString(),
    task: "001-absence-lock",
    repo: "demo-target",
    status,
    mode: "local",
    vetoes: 0,
  };
}

const render = (status: RunStatus): string =>
  renderLedgerHtml([lineWithoutVerifyState(status)], { now: NOW });

describe("a ledger line with no verifyState", () => {
  it("says so for an approved run — the one status that can only mean a pre-tri-state line", () => {
    // Withheld here is a historical line: `ApprovedPass.verify` is not optional,
    // so no current runner can ship an approved run without recording a state.
    // This assertion is also what gives the six below their teeth — it fails
    // loudly if the readout is reworded out from under them.
    expect(
      render("approved"),
      `the Verify row no longer reads "${NOT_RECORDED}" — re-point this lock at the new wording`,
    ).toContain(NOT_RECORDED);
  });

  const answeredFromStatus = RUN_STATUSES.filter((s) => s !== "approved");

  it.each(answeredFromStatus)(
    "never reports %s as unproven — the status already answers it",
    (status) => {
      // The point of the lock. A `no-changes` run had nothing to verify, and an
      // `engine-failed` run reached no verdict at all; both are answered from
      // `status` before any surface reads the field. Reporting either as
      // "not recorded" would describe a run that behaved correctly as a gap in
      // the record.
      expect(
        render(status),
        `${status} rendered "${NOT_RECORDED}" — a status that never reaches verify must not ` +
          `report an absent state as a gap. A surface lost its guard, or gained a reader.`,
      ).not.toContain(NOT_RECORDED);
    },
  );
});

describe("the two statuses that leave the gate walk entirely", () => {
  // These do not merely omit the Verify row — `renderTimeline` returns before
  // building the walk at all, because neither ran one. Pinning the replacement
  // prose, not just the absence, is what makes a deleted early return fail here
  // with a readable diff instead of somewhere downstream.
  //
  // Only the positive claim is asserted. The obvious negative — that the page
  // does not name the gates for these two — cannot be written against a whole
  // render: the funnel narrates the same gate labels for the whole window
  // (`ledger-html.ts:1181`), so a page-level `not.toContain` fails on prose that
  // has nothing to do with this run. Reaching the drawer alone would need
  // `renderTimeline` exported, which is a production change this lock does not
  // need — the NOT_RECORDED assertions above already carry the invariant.
  it("says the agent correctly made no change, rather than showing a gate walk", () => {
    expect(render("no-changes")).toContain("agent correctly made no change");
  });

  it("says no verdict was reached when the engine crashed", () => {
    expect(render("engine-failed")).toContain("no verdict was reached");
  });
});
