import { describe, expect, it } from "vitest";
import { buildCorrectionRow, decideOutcome } from "../src/index.js";

const draftedScope = ["src/**/*.ts", "test/**"];

describe("decideOutcome", () => {
  it("records narrowed when the scope was edited, whatever the marker says", () => {
    for (const markerPresent of [true, false]) {
      expect(decideOutcome({ draftedScope, approvedScope: ["src/**/*.ts"], markerPresent })).toBe("narrowed");
    }
  });

  it("records narrowed on a widened scope too — the row carries the direction", () => {
    expect(
      decideOutcome({ draftedScope, approvedScope: [...draftedScope, "docs/**"], markerPresent: false }),
    ).toBe("narrowed");
  });

  it("compares scopes order- and whitespace-insensitively", () => {
    expect(
      decideOutcome({
        draftedScope,
        approvedScope: ["test/** ", "src/**/*.ts"],
        markerPresent: true,
      }),
    ).toBe("unreviewed");
  });

  it("records reviewed-unchanged only when the marker was deleted", () => {
    expect(decideOutcome({ draftedScope, approvedScope: draftedScope, markerPresent: false })).toBe(
      "reviewed-unchanged",
    );
  });

  it("records unreviewed when nothing was touched — never silence", () => {
    expect(decideOutcome({ draftedScope, approvedScope: draftedScope, markerPresent: true })).toBe("unreviewed");
  });
});

describe("buildCorrectionRow", () => {
  it("carries both scopes so a reader can see what the edit did", () => {
    const row = buildCorrectionRow({
      ts: "2026-08-04T00:00:00.000Z",
      record: { id: "t", target: "demo-ts-service", draftedScope, draftedAt: "2026-08-04T00:00:00.000Z" },
      approvedScope: ["src/**/*.ts"],
      markerPresent: false,
    });
    expect(row).toMatchObject({
      id: "t",
      target: "demo-ts-service",
      draftedScope,
      approvedScope: ["src/**/*.ts"],
      outcome: "narrowed",
    });
  });
});
