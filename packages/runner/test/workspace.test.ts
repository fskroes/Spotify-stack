/**
 * Unit tests for local-source resolution: resolveLocalPath's interpolation and
 * prepareWorkspace honoring a repo's local_path (instead of demo-repos/<name>).
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FleetRepo } from "../src/fleet.js";
import { resolveLocalPath } from "../src/fleet.js";
import { git, prepareWorkspace } from "../src/workspace.js";

const CONTROL_REPO = mkdtempSync(path.join(os.tmpdir(), "fleet-control-"));

describe("resolveLocalPath", () => {
  const saved = process.env.FLEET_TEST_ROOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.FLEET_TEST_ROOT;
    else process.env.FLEET_TEST_ROOT = saved;
  });

  it("interpolates ${ENV_VAR}", () => {
    process.env.FLEET_TEST_ROOT = "/opt/repos";
    expect(resolveLocalPath("${FLEET_TEST_ROOT}/my-repo", CONTROL_REPO)).toBe("/opt/repos/my-repo");
  });

  it("substitutes an unset ${ENV_VAR} with empty string", () => {
    delete process.env.FLEET_TEST_ROOT;
    // "${FLEET_TEST_ROOT}/my-repo" -> "/my-repo" (absolute), control repo ignored.
    expect(resolveLocalPath("${FLEET_TEST_ROOT}/my-repo", CONTROL_REPO)).toBe("/my-repo");
  });

  it("expands a leading ~ to the home dir", () => {
    expect(resolveLocalPath("~/dev/my-repo", CONTROL_REPO)).toBe(path.join(homedir(), "dev/my-repo"));
  });

  it("resolves a relative path against the control repo", () => {
    expect(resolveLocalPath("../sibling", CONTROL_REPO)).toBe(path.resolve(CONTROL_REPO, "../sibling"));
  });

  it("passes an absolute path through unchanged", () => {
    expect(resolveLocalPath("/abs/repo", CONTROL_REPO)).toBe("/abs/repo");
  });
});

describe("prepareWorkspace with local_path", () => {
  function sourceRepo(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-src-"));
    writeFileSync(path.join(dir, "index.ts"), "export const x = 1;\n");
    writeFileSync(path.join(dir, ".DS_Store"), "junk");
    mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    return dir;
  }

  const repo = (local_path: string): FleetRepo => ({
    name: "my-repo",
    url: "https://example.invalid/my-repo",
    language: "typescript",
    default_branch: "main",
    local_path,
  });

  it("copies from local_path, excludes .DS_Store, and creates a baseline commit", () => {
    const src = sourceRepo();
    const workspace = prepareWorkspace({
      controlRepo: CONTROL_REPO,
      repo: repo(src),
      taskId: "t-local",
      local: true,
    });

    expect(existsSync(path.join(workspace, "index.ts"))).toBe(true);
    // Hygiene: .DS_Store from a live macOS tree must not land in the workspace.
    expect(existsSync(path.join(workspace, ".DS_Store"))).toBe(false);
    // node_modules is symlinked (dep reuse), never copied as a real dir.
    expect(lstatSync(path.join(workspace, "node_modules")).isSymbolicLink()).toBe(true);
    // Baseline commit exists.
    expect(git(workspace, ["log", "--oneline"])).toContain("baseline");
  });

  it("throws a clear error when local_path does not exist", () => {
    expect(() =>
      prepareWorkspace({
        controlRepo: CONTROL_REPO,
        repo: repo("/no/such/dir"),
        taskId: "t-missing",
        local: true,
      }),
    ).toThrow(/local repo not found: \/no\/such\/dir/);
  });
});
