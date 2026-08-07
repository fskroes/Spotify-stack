import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDependencies } from "../src/install.js";

// Hermetic: every case here either skips before spawning npm, or fails npm
// locally on a malformed lockfile. Nothing in this file reaches the network.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "fleet-install-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const pkg = (where: string, scripts: Record<string, string> = {}) =>
  writeFileSync(path.join(where, "package.json"), JSON.stringify({ scripts }));

describe("ensureDependencies", () => {
  it("does nothing for a workspace with no package.json", () => {
    writeFileSync(path.join(dir, "main.swift"), "print(1)\n");

    expect(() => ensureDependencies(dir)).not.toThrow();
  });

  // The idempotence that lets `--local` keep symlinking the source's deps, and
  // that keeps the e2e suite off the network. If this ever starts installing
  // over an existing tree, every hermetic run pays for a real npm ci.
  it("leaves a workspace whose dependencies are already present alone", () => {
    pkg(dir, { test: "vitest run" });
    // A lockfile npm would choke on, so a spawn would fail loudly rather than
    // silently succeed — the test asserts npm is never reached at all.
    writeFileSync(path.join(dir, "package-lock.json"), "{ not json");
    mkdirSync(path.join(dir, "node_modules"));

    expect(() => ensureDependencies(dir)).not.toThrow();
  });

  it("skips a nested workspace that already has its own dependencies", () => {
    pkg(dir);
    mkdirSync(path.join(dir, "node_modules"));
    const mobile = path.join(dir, "mobile");
    mkdirSync(mobile);
    pkg(mobile, { test: "jest" });
    writeFileSync(path.join(mobile, "package-lock.json"), "{ not json");
    mkdirSync(path.join(mobile, "node_modules"));

    expect(() => ensureDependencies(dir)).not.toThrow();
  });

  // A hoisted member's deps live in the root's closure, so installing it
  // separately would be wrong as well as slow. Same predicate the detector uses
  // to decide what to gate — imported, not re-derived.
  it("does not install a nested workspace that carries no lockfile of its own", () => {
    pkg(dir);
    mkdirSync(path.join(dir, "node_modules"));
    const member = path.join(dir, "pkg-a");
    mkdirSync(member);
    pkg(member, { test: "vitest run" });

    expect(() => ensureDependencies(dir)).not.toThrow();
  });

  // The failure the runner turns into a dead run, and — once the reconstituted
  // tree exists (ADR-0016 §3) — the one it attributes to infrastructure or to
  // the diff. Either way the message has to name the directory and carry npm's
  // own output, or the ledger records a failure nobody can act on.
  it("throws naming the workspace and npm's output when the install fails", () => {
    pkg(dir, { test: "vitest run" });
    writeFileSync(path.join(dir, "package-lock.json"), "{ not json");

    expect(() => ensureDependencies(dir)).toThrow(/dependency install failed in \.\s*\(npm ci\)/);
  });

  // The lockfile names the package manager. A pnpm target installed with npm
  // resolves a tree its lockfile never pinned AND writes a package-lock.json the
  // repo does not have — which `git add -A` sweeps straight into the run diff.
  // Measured on a real target before this branch existed: 105 KB of lockfile
  // nobody authored, in a PR that would have looked green.
  it("installs a pnpm workspace with pnpm, and never writes package-lock.json", () => {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { "left-pad": "^1.3.0" } }),
    );
    // Valid YAML, but out of date with the package.json above, so
    // `--frozen-lockfile` refuses offline rather than resolving from the network.
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    expect(() => ensureDependencies(dir)).toThrow(/\(pnpm install\)/);
    expect(existsSync(path.join(dir, "package-lock.json"))).toBe(false);
  });

  // Both present is ambiguous, and npm never produces pnpm-lock.yaml — so the
  // pnpm one is the target's positive statement about itself and wins.
  it("prefers pnpm when a workspace carries both lockfiles", () => {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { "left-pad": "^1.3.0" } }),
    );
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(path.join(dir, "package-lock.json"), "{ not json");

    expect(() => ensureDependencies(dir)).toThrow(/\(pnpm install\)/);
  });

  it("names the nested directory when a nested install fails", () => {
    pkg(dir);
    mkdirSync(path.join(dir, "node_modules"));
    const mobile = path.join(dir, "mobile");
    mkdirSync(mobile);
    pkg(mobile, { test: "jest" });
    writeFileSync(path.join(mobile, "package-lock.json"), "{ not json");

    expect(() => ensureDependencies(dir)).toThrow(/dependency install failed in mobile/);
  });
});
