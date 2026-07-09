import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detect } from "../src/verify.js";

// Real temp workspaces with marker files — detect() only inspects the
// filesystem, so no processes are spawned. Platform is injected (not read from
// process.platform) so the macOS-only Xcode branch is exercised on any host.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "detect-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function names(checks: { name: string }[]): string[] {
  return checks.map((c) => c.name);
}

describe("detect", () => {
  it("returns no checks for an empty workspace", () => {
    expect(detect(dir)).toEqual([]);
  });

  it("gates an Xcode project with a unit-test target on macOS", () => {
    mkdirSync(path.join(dir, "Foo.xcodeproj"));
    writeFileSync(path.join(dir, "project.yml"), "targets:\n  FooTests:\n    type: bundle.unit-test\n");

    const checks = detect(dir, { platform: "darwin" });
    expect(names(checks)).toEqual(["xcodebuild-build", "xcodebuild-test"]);
    for (const c of checks) {
      expect(c.command).toBe("xcodebuild");
      expect(c.args).toEqual(
        expect.arrayContaining(["-project", "Foo.xcodeproj", "-scheme", "Foo", "CODE_SIGNING_ALLOWED=NO"]),
      );
    }
    // The build check runs `build`, the test check runs `test`.
    expect(checks[0].args[0]).toBe("build");
    expect(checks[1].args[0]).toBe("test");
  });

  it("detects a *Tests directory as evidence of a test action", () => {
    mkdirSync(path.join(dir, "Foo.xcodeproj"));
    mkdirSync(path.join(dir, "FooTests"));

    expect(names(detect(dir, { platform: "darwin" }))).toEqual(["xcodebuild-build", "xcodebuild-test"]);
  });

  it("gates build only when an Xcode project has no test action", () => {
    mkdirSync(path.join(dir, "Foo.xcodeproj"));

    expect(names(detect(dir, { platform: "darwin" }))).toEqual(["xcodebuild-build"]);
  });

  it("skips the Xcode branch off macOS", () => {
    mkdirSync(path.join(dir, "Foo.xcodeproj"));
    writeFileSync(path.join(dir, "project.yml"), "targets:\n  FooTests:\n    type: bundle.unit-test\n");

    expect(detect(dir, { platform: "linux" })).toEqual([]);
  });

  it("prefers the SPM gate and skips xcodebuild when Package.swift is present", () => {
    writeFileSync(path.join(dir, "Package.swift"), "// swift-tools-version:5.9\n");
    mkdirSync(path.join(dir, "Foo.xcodeproj"));

    expect(names(detect(dir, { platform: "darwin" }))).toEqual(["swift-build", "swift-test"]);
  });
});
