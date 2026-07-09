import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  summarizeEslint,
  summarizeSwiftBuild,
  summarizeSwiftTest,
  summarizeTsc,
  summarizeVitest,
  summarizers,
} from "../src/summarize.js";

// Fixtures are real captured output from deliberately broken copies of the
// demo repos (including ANSI color codes, as tools emit them).
function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

describe("summarizeEslint", () => {
  it("extracts file, position, and rule for each error", () => {
    const summary = summarizeEslint(fixture("eslint-fail.txt"));
    expect(summary).toContain("src/http.ts");
    expect(summary).toContain("'unusedThing' is assigned a value but never used");
    expect(summary).toContain("no-explicit-any");
    expect(summary).toContain("✖ 2 problems (2 errors, 0 warnings)");
    // ANSI codes stripped
    expect(summary).not.toContain("\x1b[");
  });
});

describe("summarizeTsc", () => {
  it("keeps only error TSxxxx lines", () => {
    const summary = summarizeTsc(fixture("tsc-fail.txt"));
    expect(summary).toContain("error TS2322");
    expect(summary).toContain("src/http.ts(17,7)");
  });
});

describe("summarizeVitest", () => {
  it("keeps failed test names, assertion diff, and counts", () => {
    const summary = summarizeVitest(fixture("vitest-fail.txt"));
    expect(summary).toContain("FAIL");
    expect(summary).toContain("userService.test.ts");
    expect(summary).toMatch(/AssertionError/);
    expect(summary).toMatch(/Tests\s+1 failed/);
    expect(summary).not.toContain("\x1b[");
    // passing test output is not included
    expect(summary).not.toContain("http.test.ts");
  });

  it("keeps the failing test name and assertion from node:test TAP output", () => {
    const summary = summarizeVitest(fixture("node-test-tap-fail.txt"));
    expect(summary).toContain(
      "not ok 2 - resolveItems falls back to original items for degraded entries",
    );
    expect(summary).toContain("Expected values to be strictly deep-equal");
    expect(summary).toContain("# fail 1");
    // the passing test is not included, even though its name says "failure"
    expect(summary).not.toContain("ok 1 - fetchItems retries once");
  });

  it("keeps the failing test name and counts from node:test spec output", () => {
    const summary = summarizeVitest(fixture("node-test-spec-fail.txt"));
    expect(summary).toContain(
      "✖ resolveItems falls back to original items for degraded entries",
    );
    expect(summary).toContain("ℹ fail 1");
    expect(summary).not.toContain("✔");
  });
});

describe("summarizeSwiftBuild", () => {
  it("keeps compiler error lines", () => {
    const summary = summarizeSwiftBuild(fixture("swift-build-fail.txt"));
    expect(summary).toContain("error: cannot assign value of type 'String' to type 'Bool'");
    expect(summary).toContain("Greeting.swift");
  });
});

describe("summarizeSwiftTest", () => {
  it("keeps XCTest failure lines and counts", () => {
    const summary = summarizeSwiftTest(fixture("swift-test-fail.txt"));
    expect(summary).toContain("XCTAssertEqual failed");
    expect(summary).toContain("testBannerTrimsAndUppercases");
    expect(summary).toMatch(/Executed \d+ tests?, with \d+ failures?/);
  });
});

describe("xcodebuild summarizers", () => {
  it("reuses the swift-test parser for xcodebuild test output", () => {
    // xcodebuild-test is wired to summarizeSwiftTest — the XCTest failure and
    // count lines survive from real `xcodebuild test` output.
    expect(summarizers["xcodebuild-test"]).toBe(summarizeSwiftTest);
    expect(summarizers["xcodebuild-build"]).toBe(summarizeSwiftBuild);

    const summary = summarizers["xcodebuild-test"](fixture("xcodebuild-test-fail.txt"));
    expect(summary).toContain("XCTAssertEqual failed");
    expect(summary).toContain("testParseFeedDateWithFractionalSeconds");
    expect(summary).toMatch(/Executed \d+ tests?, with \d+ failures?/);
    // the passing test is not surfaced
    expect(summary).not.toContain("testParseFeedDatePlainISO' passed");
  });
});

describe("size capping", () => {
  it("caps very large outputs", () => {
    const huge = Array.from({ length: 500 }, (_, i) => `line ${i}: error something failed`).join("\n");
    const summary = summarizeTsc(huge);
    expect(summary.length).toBeLessThan(6000);
    expect(summary).toMatch(/omitted|truncated/);
  });
});
