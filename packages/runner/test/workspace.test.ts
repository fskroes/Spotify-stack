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
import { git, prepareWorkspace, stagedDiff } from "../src/workspace.js";

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
    visibility: "public",
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

  // The baseline commit is what the reconstituted verification tree is built
  // from (ADR-0013), so anything tracked here is materialised there. A tracked
  // `node_modules` symlink would point that tree at the source's dependencies —
  // which the agent's workspace can write through — reintroducing the tier-3
  // contamination reconstitution exists to end. A target's `.gitignore` cannot
  // be relied on to stop it: the usual `node_modules/` pattern matches
  // directories, and this is a symlink.
  it("keeps the symlinked dependencies out of the baseline commit", () => {
    const src = sourceRepo();
    writeFileSync(path.join(src, ".gitignore"), "node_modules/\n");

    const workspace = prepareWorkspace({
      controlRepo: CONTROL_REPO,
      repo: repo(src),
      taskId: "t-symlink",
      local: true,
    });

    expect(lstatSync(path.join(workspace, "node_modules")).isSymbolicLink()).toBe(true);
    expect(git(workspace, ["ls-tree", "-r", "HEAD", "--name-only"])).not.toContain("node_modules");
  });

  // The other half of the same `.gitignore` blind spot: untracked and unignored,
  // the symlink would be swept into the staged diff by `git add -A` — shipping a
  // link to the operator's disk in the PR, and tripping `scope` on a run that
  // never touched it.
  it("keeps the symlinked dependencies out of the staged diff", () => {
    const src = sourceRepo();
    writeFileSync(path.join(src, ".gitignore"), "node_modules/\n");
    const workspace = prepareWorkspace({
      controlRepo: CONTROL_REPO,
      repo: repo(src),
      taskId: "t-symlink-diff",
      local: true,
    });
    writeFileSync(path.join(workspace, "index.ts"), "export const x = 2;\n");

    const diff = stagedDiff(workspace);

    expect(diff).toContain("export const x = 2;");
    expect(diff).not.toContain("node_modules");
  });

  it("stages normal changes when the target ignores injected .claude config", () => {
    const src = sourceRepo();
    writeFileSync(path.join(src, ".gitignore"), ".claude/\n");
    const workspace = prepareWorkspace({
      controlRepo: CONTROL_REPO,
      repo: repo(src),
      taskId: "t-ignored-claude",
      local: true,
    });
    mkdirSync(path.join(workspace, ".claude"), { recursive: true });
    writeFileSync(path.join(workspace, ".claude", "settings.json"), "{}\n");
    writeFileSync(path.join(workspace, "index.ts"), "export const x = 2;\n");

    const diff = stagedDiff(workspace);

    expect(diff).toContain("export const x = 2;");
    expect(diff).not.toContain(".claude");
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
