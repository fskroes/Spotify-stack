/**
 * Generating the Xcode project during tree construction (ADR-0023).
 *
 * Hermetic on any host. The darwin-only branch is reached by injecting the
 * platform, exactly as detect()'s tests reach it, and the missing-binary case
 * empties `PATH` rather than depending on whether the host happens to carry
 * `xcodegen` — so it is the same test on Linux CI and on a developer's Mac.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureXcodeProject, generateXcodeProject } from "../src/xcodegen.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Is a real `xcodegen` on this host? Only the generating tests need one. */
const HAS_XCODEGEN = (() => {
  try {
    execFileSync("xcodegen", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The smallest spec XcodeGen will generate a macOS app project from. */
const SPEC = [
  "name: Foo",
  "targets:",
  "  Foo:",
  "    type: application",
  "    platform: macOS",
  "    sources: [Sources]",
  "",
].join("\n");

function tempRoot(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-xcodegen-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

/** Run with nothing on `PATH`, so `xcodegen` is definitively absent. */
function withoutPath<T>(fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

describe("generateXcodeProject", () => {
  // The Linux cloud runners have no `xcodebuild`, so detect() emits no Xcode
  // checks there and there is nothing for a generated project to be built by.
  // Generating anyway would make `xcodegen` a requirement on hosts that have no
  // use for one.
  it("does nothing off darwin, even with a spec present", () => {
    const root = tempRoot({ "project.yml": SPEC });

    withoutPath(() => generateXcodeProject(root, { platform: "linux" }));

    expect(existsSync(path.join(root, "Foo.xcodeproj"))).toBe(false);
  });

  it("does nothing on darwin without a spec", () => {
    const root = tempRoot({ "package.json": "{}" });

    withoutPath(() => generateXcodeProject(root, { platform: "darwin" }));

    expect(existsSync(path.join(root, "Foo.xcodeproj"))).toBe(false);
  });

  // The false green this whole record removes. A quiet skip here builds against
  // whatever project is on disk — a stale one, or none — and reports on it as if
  // the spec had been read.
  it("fails loudly when the spec is present and xcodegen is not installed", () => {
    const root = tempRoot({ "project.yml": SPEC });

    expect(() => withoutPath(() => generateXcodeProject(root, { platform: "darwin" }))).toThrow(
      /xcodegen is not installed/,
    );
  });

  it.skipIf(!HAS_XCODEGEN)("generates the project from the spec", () => {
    const root = tempRoot({ "project.yml": SPEC, "Sources/main.swift": "print(\"hi\")\n" });

    generateXcodeProject(root, { platform: "darwin" });

    expect(existsSync(path.join(root, "Foo.xcodeproj", "project.pbxproj"))).toBe(true);
  });

  // The target's own file is broken. Attribution is the caller's — this only has
  // to fail rather than emit a half-project.
  it.skipIf(!HAS_XCODEGEN)("throws on a spec it cannot read", () => {
    const root = tempRoot({ "project.yml": "targets: [this is not a target map\n" });

    expect(() => generateXcodeProject(root, { platform: "darwin" })).toThrow(/xcodegen generate failed/);
  });

  // Not idempotent, deliberately: the tree calls it twice and the second call is
  // the one that tells a broken spec apart from a diff that broke it.
  it.skipIf(!HAS_XCODEGEN)("regenerates over a project that is already there", () => {
    const root = tempRoot({ "project.yml": SPEC, "Sources/main.swift": "print(\"hi\")\n" });
    generateXcodeProject(root, { platform: "darwin" });
    writeFileSync(path.join(root, "Foo.xcodeproj", "project.pbxproj"), "clobbered\n");

    generateXcodeProject(root, { platform: "darwin" });

    expect(existsSync(path.join(root, "Foo.xcodeproj", "project.pbxproj"))).toBe(true);
    expect(execFileSync("head", ["-1", path.join(root, "Foo.xcodeproj", "project.pbxproj")], {
      encoding: "utf8",
    })).not.toMatch(/clobbered/);
  });
});

describe("ensureXcodeProject", () => {
  // The workspace half is idempotent, and the skip is load-bearing: a project on
  // disk in a workspace is one the target still tracks, and regenerating a
  // tracked file writes a diff hunk the agent did not author. Emptying `PATH`
  // proves the guard returns before it would ever reach the binary.
  it("leaves a project that is already on disk alone", () => {
    const root = tempRoot({ "project.yml": SPEC });
    mkdirSync(path.join(root, "Foo.xcodeproj"));
    writeFileSync(path.join(root, "Foo.xcodeproj", "project.pbxproj"), "checked in\n");

    withoutPath(() => ensureXcodeProject(root, { platform: "darwin" }));

    expect(execFileSync("cat", [path.join(root, "Foo.xcodeproj", "project.pbxproj")], {
      encoding: "utf8",
    })).toBe("checked in\n");
  });

  // Untracked upstream: nothing was materialised, so the workspace's in-session
  // `verify` would detect no Xcode checks at all without this (ADR-0017).
  it.skipIf(!HAS_XCODEGEN)("generates when no project was materialised", () => {
    const root = tempRoot({ "project.yml": SPEC, "Sources/main.swift": "print(\"hi\")\n" });

    ensureXcodeProject(root, { platform: "darwin" });

    expect(existsSync(path.join(root, "Foo.xcodeproj", "project.pbxproj"))).toBe(true);
  });

  it("still fails loudly when the binary is missing and nothing is on disk", () => {
    const root = tempRoot({ "project.yml": SPEC });

    expect(() => withoutPath(() => ensureXcodeProject(root, { platform: "darwin" }))).toThrow(
      /xcodegen is not installed/,
    );
  });
});
