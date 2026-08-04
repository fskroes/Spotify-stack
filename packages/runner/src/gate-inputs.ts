/**
 * Which paths in a diff the amendment rule treats as
 * [gate inputs](../../../CONTEXT.md#gate-input), and which of them a task's
 * `amends:` licences into the verification tree
 * ([ADR-0014](../../../docs/adr/0014-gate-inputs-are-carried-only-under-an-amendment.md)).
 *
 * **A constant, and deliberately not per-target configuration**
 * ([ADR-0020](../../../docs/adr/0020-the-gate-input-set-is-a-convention.md)).
 * ADR-0014's rule is "a property of how the verification tree is built, applied
 * on every run" — a list somebody maintains per target would reintroduce the
 * detection step that record says does not exist, and would rot exactly like the
 * restore list ADR-0013 rejected.
 *
 * Two sources, both free:
 *
 *  1. the files verification already reads to decide a check exists (`detect()`
 *     in `@fleet/mcp-verify`), and
 *  2. one universal test-and-fixture convention.
 *
 * The set is **partial by construction, not by shortcut.** A gate input is
 * defined by what a check reads *when it runs*, and some are never in a diff at
 * all — the harness config is reset out of the index and `node_modules` is
 * ignored by git. Those are not left to this list: ADR-0013 leaves them behind
 * by building the tree from git objects, so nothing here has to name them.
 *
 * Being wrong in either direction is survivable, which is what licenses a
 * convention instead of a configuration:
 *
 *  - **False positive** (a path here that no check reads). If the check really
 *    was indifferent, verification is unchanged and the PR still names the hold.
 *    If it was not, the base version disagrees with the shipped source, the run
 *    dies as an ordinary `verify-failed`, and one `amends:` line fixes it.
 *  - **False negative** (a real gate input this list misses). It is carried —
 *    which is precisely the behaviour of every run before this existed.
 *
 * Neither direction can produce a false green, and only one of them costs
 * anything. So the list is allowed to be approximate, and no target may tune it.
 */
import picomatch from "picomatch";
import type { Amendment } from "./task.js";

/**
 * Source 1: what `detect()` opens or stats to decide a check exists.
 *
 * Named here rather than exported from `@fleet/mcp-verify`, because detection
 * stays task-blind and this is a task-facing rule (ADR-0009's seam, unchanged).
 * The copy can drift from the detector, and drift lands on the harmless side:
 * a detector that learns to read a new file yields a false negative, which is
 * the pre-ADR-0014 behaviour and never a false green.
 */
const DETECTOR_READS = [
  // `scripts.lint` / `.typecheck` / `.test` decide three checks exist, and every
  // one of them re-reads this manifest when it runs.
  "**/package.json",
  // An own lockfile is what makes a nested directory an independent workspace
  // with checks of its own (`nestedWorkspaces`), and the tree installs from it.
  "**/package-lock.json",
  // Presence decides the `tsc --noEmit` check; contents decide what it accepts.
  "**/tsconfig*.json",
  // Presence decides `swift build` and `swift test`.
  "Package.swift",
  // `bundle.unit-test` in it decides whether `xcodebuild-test` exists.
  "project.yml",
  // The scheme the two xcodebuild checks are run against.
  "**/*.xcodeproj/**",
];

/**
 * Source 2: the universal test-and-fixture convention.
 *
 * One list for every target and every language, because a per-language list is
 * the maintained thing this design is avoiding. It covers the file-naming
 * convention, the directory conventions, and the fixture/helper shapes a suite
 * loads — the places CONTEXT.md says the shortest path to a false green runs.
 */
const TEST_AND_FIXTURE_CONVENTION = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/test/**",
  "**/tests/**",
  "**/spec/**",
  // Swift and Xcode name a test target `<Something>Tests`; the `*` also matches
  // the bare `Tests/` directory SwiftPM uses.
  "**/*Tests/**",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/__fixtures__/**",
  "**/fixtures/**",
  // The archetypal harness-shaped file a suite loads without importing.
  "**/conftest.py",
];

/** The whole convention, in one place a reader can check against a diff. */
export const GATE_INPUT_GLOBS = [...DETECTOR_READS, ...TEST_AND_FIXTURE_CONVENTION];

const matchesConvention = picomatch(GATE_INPUT_GLOBS, { dot: true });

/** Whether a repo-relative path is a gate input by this build's convention. */
export function isGateInput(file: string): boolean {
  return matchesConvention(file);
}

/** One amendment a diff actually exercised, with what it licensed. */
export interface CarriedAmendment {
  glob: string;
  reason: string;
  /** The gate inputs in this diff that this glob licensed into the tree. */
  files: string[];
}

/**
 * What the tree does with this diff's gate inputs. Computed from the diff's own
 * paths, so a task whose diff touched none produces an empty decision and
 * nothing anywhere renders an amendment affordance.
 */
export interface GateInputDecision {
  /** Gate inputs no amendment named: taken from the base, not from the diff. */
  held: string[];
  /** Amendments this diff exercised — the licence, its reason, and its files. */
  carried: CarriedAmendment[];
}

/** Nothing to hold and no licence exercised — the shape of an ordinary diff. */
export function noGateInputs(decision: GateInputDecision | undefined): boolean {
  return !decision || (decision.held.length === 0 && decision.carried.length === 0);
}

/**
 * Split a diff's paths into the gate inputs the tree holds at the base and the
 * ones a task's `amends:` carries into it.
 *
 * Declaration order decides a file matched by two globs: the first amendment
 * that names it is the one whose reason travels, so a task's own ordering reads
 * top-to-bottom the way its author wrote it.
 */
export function decideGateInputs(files: string[], amends?: Amendment[]): GateInputDecision {
  const licences = (amends ?? []).map((amendment) => ({
    amendment,
    match: picomatch(amendment.glob, { dot: true }),
  }));
  const held: string[] = [];
  const carried = new Map<string, CarriedAmendment>();

  for (const file of files) {
    if (!isGateInput(file)) continue;
    const licence = licences.find((candidate) => candidate.match(file));
    if (!licence) {
      held.push(file);
      continue;
    }
    const { glob, reason } = licence.amendment;
    const entry = carried.get(glob) ?? { glob, reason, files: [] };
    entry.files.push(file);
    carried.set(glob, entry);
  }

  return { held, carried: [...carried.values()] };
}

/**
 * What the judge is told about this run's gate inputs, appended to the
 * verification summary.
 *
 * The summary is the judge's whole view of what verification did, so a hold it
 * cannot see is a hold it cannot weigh — and a carried gate input reviewed
 * without its licence looks like the tampering the licence exists to
 * distinguish from. Both halves are named with their files, and the amendment
 * with its reason (ADR-0014: an amended gate input is a loud fact).
 */
export function gateInputNote(decision: GateInputDecision): string {
  const sections: string[] = [];

  if (decision.carried.length > 0) {
    sections.push(
      "GATE INPUTS CARRIED UNDER AN AMENDMENT — this task licensed changes to the files that " +
        "judge it, so they were verified as part of this change rather than taken from the base:\n" +
        decision.carried
          .map((a) => `- ${a.glob} (${a.reason}): ${a.files.join(", ")}`)
          .join("\n"),
    );
  }

  if (decision.held.length > 0) {
    sections.push(
      "GATE INPUTS HELD AT THE BASE — this diff edits files the checks read when they run, and " +
        "the task did not amend them. Verification used the BASE version of each, so the edits " +
        `below ship in this diff and are not part of what proves it:\n${decision.held.map((f) => `- ${f}`).join("\n")}`,
    );
  }

  return sections.join("\n\n");
}
