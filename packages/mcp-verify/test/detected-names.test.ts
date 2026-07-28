import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DETECTED_CHECK_NAMES } from "../src/verify.js";

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "verify.js"),
  "utf8",
);

/**
 * `DETECTED_CHECK_NAMES` is the list the fleet registry checks a registered
 * verifier's name against (ADR-0009: a registered verifier may not shadow a
 * detected one). A name the detector emits but this list omits would be
 * shadowable — a one-line false green — so the list is locked to the detector
 * rather than trusted to stay in sync by hand.
 *
 * Read out of the source the same way `test/docs-drift.test.ts` does. If the
 * detector is restructured so names stop being literals, this fails loudly with
 * "no check names parsed" rather than passing vacuously.
 */
const emittedNames = (): string[] => {
  const names = [...source.matchAll(/name:\s*[`"]([a-z-]+)(\$\{suffix\})?[`"]/g)].map((m) => m[1]);
  expect(names.length, "no check names parsed out of verify.js — the detector was restructured").toBeGreaterThan(0);
  return [...new Set(names)];
};

describe("DETECTED_CHECK_NAMES", () => {
  it("covers every name the detector can emit", () => {
    const missing = emittedNames().filter((name) => !DETECTED_CHECK_NAMES.includes(name));

    expect(
      missing,
      `detect() emits check name(s) absent from DETECTED_CHECK_NAMES: ${missing.join(", ")}. ` +
        "A registered verifier could shadow them.",
    ).toEqual([]);
  });

  it("claims no name the detector cannot emit", () => {
    // Over-claiming is milder than under-claiming — it only rejects a legal
    // registration — but it is still drift, and it reads as a detector that
    // exists when it does not.
    const emitted = emittedNames();
    expect(DETECTED_CHECK_NAMES.filter((name) => !emitted.includes(name))).toEqual([]);
  });
});
