/**
 * The operator half of the absence lock: a *source scan* over the four places in
 * `main.ts` that read a verification readout.
 *
 * [`verify-absence.test.ts`](./verify-absence.test.ts) pins the same invariant on
 * the runner's report by rendering it — one entry per status with `verifyState`
 * withheld, asserting nothing reports a run that never verified as a gap. It
 * says outright that it covers the report only, because `main.ts` queries the
 * DOM at module scope (`:127`, `:350-358`) and throws on import. That left the
 * operator's guards held up by a hand-check in one session's notes, which is not
 * a thing a build can fail on.
 *
 * So this reads `main.ts` as **text** and asserts each function still guards
 * before it reads verify. That is a genuinely weaker oracle than rendering: it
 * proves an ordering in the source, not a behaviour, and it cannot see a guard
 * that is present but wrong. It is the strongest lock available without either a
 * DOM environment (none exists here, deliberately — see `docs/README.md`) or the
 * `run-view.ts` extraction, which was scoped and deferred on its own merits
 * rather than smuggled in as a test harness. When that extraction lands, this
 * file should be replaced by real render assertions, not kept alongside them.
 *
 * ## On the anchors
 *
 * Every anchor here is a **function name or a guard expression**, never a line
 * number — the numbers in this session's notes will drift within a release.
 * A rename fails the run with "anchor not found in main.ts", naming what it
 * looked for. That is the intended failure, exactly as `docs-drift.test.ts`
 * argues for prose: it means a human must re-point the lock, and it is what
 * stops the ordering assertions below from passing vacuously against text that
 * is no longer there.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(path.join(repoRoot, "apps/operator-desktop/src/main.ts"), "utf8");

/**
 * The source of one top-level function: from its `function` keyword to the
 * `\n}` that closes it at column 0. That relies on `main.ts` staying
 * consistently indented, which is a weaker guarantee than a parse — but a
 * mis-slice here truncates a body and fails the ordering assertion below rather
 * than passing one, so the failure mode is a loud false red, not a false green.
 */
function bodyOf(name: string): string {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  if (start === -1) {
    throw new Error(
      `guard-lock anchor not found in main.ts: no top-level "function ${name}(". ` +
        `It was renamed, moved, or extracted — re-point this lock, or delete it if the ` +
        `function now lives somewhere a render test can reach.`,
    );
  }
  const end = SRC.indexOf("\n}", start + 1);
  return SRC.slice(start, end === -1 ? undefined : end);
}

/** Where `pattern` occurs in `body`, or a loud failure naming what was sought. */
function at(body: string, pattern: RegExp, fn: string, what: string): number {
  const found = body.match(pattern);
  if (found?.index === undefined) {
    throw new Error(
      `guard-lock anchor not found in main.ts: ${fn} no longer contains ${what} ` +
        `(searched for ${pattern}). Re-point this lock at the new form.`,
    );
  }
  return found.index;
}

/** The last occurrence — the fall-through read, after every guard has declined. */
function lastAt(body: string, pattern: RegExp, fn: string, what: string): number {
  const all = [...body.matchAll(new RegExp(pattern, "g"))];
  const found = all.at(-1);
  if (found?.index === undefined) {
    throw new Error(
      `guard-lock anchor not found in main.ts: ${fn} no longer contains ${what} ` +
        `(searched for ${pattern}). Re-point this lock at the new form.`,
    );
  }
  return found.index;
}

/** The contract's fate table, consulted for the statuses that died before verify. */
const FATE_GUARD = /facts\?\.diedAt \|\| facts\?\.kind === "infra" \|\| facts\?\.kind === "killed"/;
/** The empty-diff status, which had nothing to verify. */
const NO_CHANGES_GUARD = /status === "no-changes"/;

/**
 * The three view derivations. Each ends in a fall-through branch that describes
 * an approved run and reads its verification state; each must decline the
 * statuses that never reached verification *before* getting there. Reporting a
 * `no-changes` or `engine-failed` run's absent state as "not recorded" would
 * describe a run that behaved correctly as a gap in the record — the misleading
 * readout ADR-0004 and ADR-0012 exist to keep out of a reader's face.
 */
const VIEWS = [
  { fn: "spotlightFor", reads: /verifyReadout\(/, what: "a `verifyReadout(` call" },
  { fn: "gateReadouts", reads: /verifyReadout\(/, what: "a `verifyReadout(` call" },
  { fn: "decisionHead", reads: /outcomeDetail\(/, what: "an `outcomeDetail(` call" },
] as const;

describe.each(VIEWS)("$fn", ({ fn, reads, what }) => {
  it("declines the statuses that died before verify, before describing an approved run", () => {
    const body = bodyOf(fn);
    const guard = at(body, FATE_GUARD, fn, "the died/infra/killed fate guard");
    const read = lastAt(body, reads, fn, what);

    expect(
      guard,
      `${fn} reads verify at ${read} but only checks diedAt/infra/killed at ${guard} — a killed ` +
        `run would be described from a verification it never reached.`,
    ).toBeLessThan(read);
  });

  it("declines an empty diff before describing an approved run", () => {
    const body = bodyOf(fn);
    const guard = at(body, NO_CHANGES_GUARD, fn, "the `no-changes` guard");
    const read = lastAt(body, reads, fn, what);

    expect(
      guard,
      `${fn} reads verify at ${read} but only checks for no-changes at ${guard} — a run that ` +
        `correctly changed nothing would report its absent verify state as a gap.`,
    ).toBeLessThan(read);
  });
});

describe("spotlightFor's awaiting-co-sign branch", () => {
  /**
   * The one verify read in this file that is *not* behind the two guards above,
   * and the reason those assertions anchor on the last occurrence rather than
   * the first. It sits earlier, inside the awaiting-review branch — which is its
   * own guard, and a stronger one: `awaitingReview` is the contract's own
   * predicate for a run that cleared every gate and opened a PR. Pinned
   * separately so the ordering above cannot be satisfied by a stray early read
   * that answers to nothing.
   */
  it("reads verify only after awaitingReview has said the run shipped", () => {
    const body = bodyOf("spotlightFor");
    const guard = at(body, /awaitingReview\(/, "spotlightFor", "an `awaitingReview(` call");
    const read = at(body, /verifyReadout\(/, "spotlightFor", "a `verifyReadout(` call");

    expect(
      guard,
      "spotlightFor's first verify read is no longer inside the awaitingReview branch — it now " +
        "answers to nothing, and the fate/no-changes locks above would not cover it.",
    ).toBeLessThan(read);
  });
});

describe("openMergeConfirm", () => {
  /**
   * The dialog that collects a signature, and the only one of the four whose
   * guard is a hard `return` rather than a branch: no PR URL, no dialog. That is
   * sufficient here where the views need two guards, because a run only carries
   * `prUrl` if the runner opened one, which no status that died before verify
   * does. `fleet cosign` has no `--force` for the same reason (ADR-0005) — the
   * signature is gated on the artefact existing, not on prose about it.
   */
  it("returns unless the run actually opened a pull request, before reading verify", () => {
    const body = bodyOf("openMergeConfirm");
    const guard = at(body, /if \(!run \|\| run\.kind !== "completed" \|\| !run\.data\.prUrl\) return;/, "openMergeConfirm", "the no-PR early return");
    const read = at(body, /verifyReadout\(/, "openMergeConfirm", "a `verifyReadout(` call");

    expect(
      guard,
      "openMergeConfirm reads verify before establishing the run opened a PR — the merge dialog " +
        "would state stakes for a run that has nothing to merge.",
    ).toBeLessThan(read);
  });
});
