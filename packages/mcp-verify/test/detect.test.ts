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

  // These names are not internal: they are the vocabulary a task's `gates:`
  // mandates by, so renaming one silently changes the task language. That is
  // why the npm-shape names are asserted rather than left to the summarizer
  // table — `test` in particular was once called `vitest`, though it fires for
  // any `test` script, jest and node:test included.
  it("names the npm-shape checks after the script, not after one runner", () => {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "node --test" } }),
    );
    mkdirSync(path.join(dir, "node_modules"));

    expect(names(detect(dir))).toEqual(["eslint", "tsc", "test"]);
  });

  it("adds the install check only when dependencies are not present", () => {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    writeFileSync(path.join(dir, "package-lock.json"), "{}");

    expect(names(detect(dir))).toEqual(["npm-install", "test"]);
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

// A repo is not always one workspace. The target shape is two: a root
// (`node --test`) and an independent `mobile/` (jest) with its OWN lockfile.
// The root `test` deliberately excludes mobile, so a change under mobile/ used
// to pass the gate vacuously (#95). detect() now descends into independent
// nested workspaces and gates each as its own namespaced checks.
//
// The discriminator is an own lockfile: an independent app carries its own
// dependency closure (its own package-lock.json), whereas a hoisted workspace
// member has none — the root runner already covers it, so descending would
// double-run. That signal is filesystem-only, matching detect()'s ethos.
describe("detect — independent nested workspaces", () => {
  function nested(name: string, files: Record<string, string>): string {
    const d = path.join(dir, name);
    mkdirSync(d);
    for (const [f, contents] of Object.entries(files)) writeFileSync(path.join(d, f), contents);
    return d;
  }

  it("gates an independent nested workspace as its own namespaced checks", () => {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    mkdirSync(path.join(dir, "node_modules"));
    const mobile = nested("mobile", {
      "package.json": JSON.stringify({ scripts: { test: "jest", typecheck: "tsc --noEmit" } }),
      "package-lock.json": "{}", // own closure → not a hoisted member
    });

    const checks = detect(dir);
    // Root check first, then the nested workspace's install → tsc → test.
    expect(names(checks)).toEqual(["test", "npm-install:mobile", "tsc:mobile", "test:mobile"]);
    // Every nested check runs in the nested directory, not the repo root.
    for (const c of checks.filter((c) => c.name.endsWith(":mobile"))) {
      expect(c.cwd).toBe(mobile);
    }
    expect(checks.find((c) => c.name === "test")?.cwd).toBe(dir);
  });

  it("descends even when the repo root has no package.json of its own", () => {
    // Only the nested app is a JS workspace; the root is a shell/polyglot repo.
    nested("app", {
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "package-lock.json": "{}",
    });

    expect(names(detect(dir))).toEqual(["npm-install:app", "test:app"]);
  });

  it("does not descend into a pnpm/yarn-locked nested app (npm-only for now)", () => {
    // npmChecks installs via `npm ci` / `npm install`; running those against a
    // pnpm/yarn closure would be unsound (npm install rewrites a lockfile the
    // diff then vetoes). Detecting it now would only mis-handle it — deliberately
    // left for a per-manager follow-up, not silently half-run.
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    mkdirSync(path.join(dir, "node_modules"));
    nested("web", {
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "pnpm-lock.yaml": "",
    });
    nested("api", {
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "yarn.lock": "",
    });

    expect(names(detect(dir))).toEqual(["test"]);
  });

  it("does not descend into a hoisted member that has no lockfile of its own", () => {
    // Root vitest already covers its workspace members; they carry no own
    // lockfile (deps hoist to the root), so descending would double-run.
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    mkdirSync(path.join(dir, "node_modules"));
    nested("pkg-a", { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });

    expect(names(detect(dir))).toEqual(["test"]);
  });

  it("skips a nested workspace that has a lockfile but no verifier-shaped script", () => {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    mkdirSync(path.join(dir, "node_modules"));
    nested("tool", {
      "package.json": JSON.stringify({ scripts: { build: "tsc -b" } }), // no test/lint/typecheck
      "package-lock.json": "{}",
    });

    expect(names(detect(dir))).toEqual(["test"]);
  });

  it("gates a nested workspace on tsc when it has a tsconfig but no test script", () => {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    mkdirSync(path.join(dir, "node_modules"));
    nested("web", {
      "package.json": JSON.stringify({ scripts: {} }),
      "package-lock.json": "{}",
      "tsconfig.json": "{}",
    });

    // No test script, but a tsconfig → the same tsc-without-typecheck-script
    // fallback the root branch applies, namespaced to the nested dir.
    const checks = detect(dir);
    expect(names(checks)).toEqual(["test", "npm-install:web", "tsc:web"]);
    const tsc = checks.find((c) => c.name === "tsc:web");
    expect([tsc?.command, tsc?.args]).toEqual(["npx", ["tsc", "--noEmit"]]);
  });

  it("never descends into node_modules or dot directories", () => {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    // A dependency (and a cache dir) that themselves look like workspaces must
    // never be gated — they are not the repo's code.
    const dep = path.join(dir, "node_modules", "some-dep");
    mkdirSync(dep, { recursive: true });
    writeFileSync(path.join(dep, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }));
    writeFileSync(path.join(dep, "package-lock.json"), "{}");
    nested(".cache", {
      "package.json": JSON.stringify({ scripts: { test: "exit 1" } }),
      "package-lock.json": "{}",
    });

    expect(names(detect(dir))).toEqual(["test"]);
  });

  it("omits the nested install check when the nested deps are already present", () => {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    mkdirSync(path.join(dir, "node_modules"));
    const mobile = nested("mobile", {
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "package-lock.json": "{}",
    });
    mkdirSync(path.join(mobile, "node_modules"));

    expect(names(detect(dir))).toEqual(["test", "test:mobile"]);
  });
});
