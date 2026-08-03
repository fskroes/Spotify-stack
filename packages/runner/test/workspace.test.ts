/**
 * Unit tests for local-source resolution: resolveLocalPath's interpolation and
 * prepareWorkspace honoring a repo's local_path (instead of demo-repos/<name>).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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

/** Repo-relative paths held by a repo's HEAD commit, sorted. */
function treePaths(repo: string): string[] {
  return git(repo, ["ls-tree", "-r", "HEAD", "--name-only"]).split("\n").filter(Boolean).sort();
}

/**
 * Repo-relative paths present on disk, sorted. `.git` is skipped as runner
 * bookkeeping, and a symlink is recorded as one entry rather than descended
 * into — the `node_modules` link is the runner's own, and following it would
 * measure the source's dependency closure instead of the workspace.
 */
function diskPaths(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !(prefix === "" && entry.name === ".git"))
    .flatMap((entry) => {
      const rel = prefix + entry.name;
      return entry.isDirectory() ? diskPaths(path.join(dir, entry.name), `${rel}/`) : [rel];
    })
    .sort();
}

describe("prepareWorkspace with local_path", () => {
  /**
   * A live working tree as an operator's disk actually holds one: a git repo
   * with committed source, an ignored dependency dir, an ignored build output
   * dir (target B's is 9.2 GB — see the 2026-08-03 tree-construction
   * experiment), and an untracked .DS_Store on top.
   */
  function sourceRepo(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-src-"));
    writeFileSync(path.join(dir, "index.ts"), "export const x = 1;\n");
    writeFileSync(path.join(dir, ".gitignore"), "node_modules/\ntarget/\n");
    mkdirSync(path.join(dir, "target"), { recursive: true });
    writeFileSync(path.join(dir, "target", "artifact.bin"), "0".repeat(4096));
    mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    git(dir, ["init", "-b", "main"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "source", "--quiet"]);
    writeFileSync(path.join(dir, ".DS_Store"), "junk");
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

  it("checks out local_path at HEAD and creates a baseline commit", () => {
    const src = sourceRepo();
    const workspace = prepareWorkspace({
      controlRepo: CONTROL_REPO,
      repo: repo(src),
      taskId: "t-local",
      local: true,
    });

    expect(existsSync(path.join(workspace, "index.ts"))).toBe(true);
    // .DS_Store is untracked, so it is not in HEAD, so it is not here. No rule
    // names it any more — ADR-0018 retired the four-basename exclusion list.
    expect(existsSync(path.join(workspace, ".DS_Store"))).toBe(false);
    // node_modules is symlinked (dep reuse), never materialised as a real dir.
    expect(lstatSync(path.join(workspace, "node_modules")).isSymbolicLink()).toBe(true);
    // Baseline commit exists.
    expect(git(workspace, ["log", "--oneline"])).toContain("baseline");
  });

  // ADR-0018's behaviour change, asserted rather than described, and the reason
  // it is a decision and not a patch. Copying a working tree made an operator's
  // uncommitted edit the base the verification tree is built on — so a green was
  // earned against a combination nobody can fetch — and `openPr`'s
  // `reset --soft FETCH_HEAD` then shipped that edit inside the agent's PR
  // commit, under the fleet's authorship. A run's base is a commit or there is
  // no run; work the agent must build on has to be committed first.
  it("does not carry the source's uncommitted or untracked work", () => {
    const src = sourceRepo();
    writeFileSync(path.join(src, "index.ts"), "export const x = 1;\nconst operatorWip = 2;\n");
    writeFileSync(path.join(src, "scratch.ts"), "// not committed anywhere\n");

    const workspace = prepareWorkspace({
      controlRepo: CONTROL_REPO,
      repo: repo(src),
      taskId: "t-uncommitted",
      local: true,
    });

    expect(readFileSync(path.join(workspace, "index.ts"), "utf8")).not.toContain("operatorWip");
    expect(existsSync(path.join(workspace, "scratch.ts"))).toBe(false);
  });

  // The demo-target shape, and the reason cloning the source was never an
  // option: `demo-repos/*` have no `.git` of their own — they are tracked
  // directories inside the control repo, so `rev-parse --show-toplevel` returns
  // the control repo. The whole hermetic e2e suite runs local mode against one.
  //
  // Kept as a unit test because this path fails *silently*: `checkout-index
  // --prefix` run from the subdirectory rather than the toplevel writes nothing
  // and exits 0, which yields an empty workspace and an empty baseline. e2e
  // catches that too, but only as a `git commit` failure thirty frames away.
  it("materialises a source that is a tracked subdirectory of a parent repo", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "fleet-parent-"));
    writeFileSync(path.join(parent, "unrelated.md"), "# the parent's own file\n");
    mkdirSync(path.join(parent, "demo-repos", "nested"), { recursive: true });
    writeFileSync(path.join(parent, "demo-repos", "nested", "index.ts"), "export const y = 1;\n");
    git(parent, ["init", "-b", "main"]);
    git(parent, ["add", "-A"]);
    git(parent, ["commit", "-m", "parent", "--quiet"]);

    const workspace = prepareWorkspace({
      controlRepo: CONTROL_REPO,
      repo: repo(path.join(parent, "demo-repos", "nested")),
      taskId: "t-nested",
      local: true,
    });

    // The subtree, and only the subtree: not empty, and not the parent's tree.
    expect(treePaths(workspace)).toEqual(["index.ts"]);
  });

  // The precondition the decision creates, surfaced with its reason rather than
  // left to fail inside a plumbing command. Every fleet target is a git repo —
  // it opens PRs — so this is a misconfiguration, not a supported shape.
  it("throws a clear error when local_path is not inside a git repository", () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), "fleet-nongit-"));
    writeFileSync(path.join(bare, "index.ts"), "export const x = 1;\n");

    expect(() =>
      prepareWorkspace({
        controlRepo: CONTROL_REPO,
        repo: repo(bare),
        taskId: "t-nongit",
        local: true,
      }),
    ).toThrow(/not inside a git repository/);
  });

  // ADR-0018's decision, as a property rather than a path list. The measured
  // defect it closes is a `target/` directory — 9.2 GB of one live target's
  // 10.4 GB — copied per run because no exclusion named it. Asserted over the
  // filesystem and not the baseline commit, because the copy is where the cost
  // lands: a gitignored directory is copied and then simply not committed, so a
  // commit-level assertion watches this defect go by.
  it("materialises the source's HEAD tree on disk and nothing else", () => {
    const src = sourceRepo();

    const workspace = prepareWorkspace({
      controlRepo: CONTROL_REPO,
      repo: repo(src),
      taskId: "t-disk",
      local: true,
    });

    // The one addition the runner makes on purpose, after the baseline commit.
    expect(diskPaths(workspace)).toEqual([...treePaths(src), "node_modules"].sort());
  });

  // The invariant ADR-0018 buys, and the one that would have caught the symlink
  // bug before it was found by hand: the baseline holds what the source's git
  // names at HEAD, and nothing else. Every past and future leak into the base is
  // an instance of this failing — the `node_modules` symlink `.gitignore`'s
  // directory pattern did not match, and the `target/` directory no exclusion
  // list named. Asserted as equality, not a subset: a filter that drops a
  // committed file is the same defect pointing the other way.
  it("commits a baseline holding exactly what the source's git names at HEAD", () => {
    const src = sourceRepo();

    const workspace = prepareWorkspace({
      controlRepo: CONTROL_REPO,
      repo: repo(src),
      taskId: "t-baseline",
      local: true,
    });

    expect(treePaths(workspace)).toEqual(treePaths(src));
  });

  // The same invariant from the side that loses a file rather than gaining one.
  // Git keeps tracking what is already tracked, so a target can legitimately
  // hold a committed file its own `.gitignore` also matches — vendored output is
  // the usual way. Materialising it and then staging with a plain `git add -A`
  // would consult that `.gitignore` and silently drop it, leaving the
  // verification tree short a file the target ships and the checks may read.
  it("commits a file the source tracks even when the source ignores it", () => {
    const src = sourceRepo();
    mkdirSync(path.join(src, "dist"), { recursive: true });
    writeFileSync(path.join(src, "dist", "vendor.js"), "// vendored\n");
    git(src, ["add", "-f", "dist/vendor.js"]);
    writeFileSync(path.join(src, ".gitignore"), "node_modules/\ntarget/\ndist/\n");
    git(src, ["add", ".gitignore"]);
    git(src, ["commit", "-m", "vendored", "--quiet"]);

    const workspace = prepareWorkspace({
      controlRepo: CONTROL_REPO,
      repo: repo(src),
      taskId: "t-vendored",
      local: true,
    });

    expect(treePaths(workspace)).toContain("dist/vendor.js");
    expect(treePaths(workspace)).toEqual(treePaths(src));
  });

  // The baseline commit is what the reconstituted verification tree is built
  // from (ADR-0013), so anything tracked here is materialised there. A tracked
  // `node_modules` symlink would point that tree at the source's dependencies —
  // which the agent's workspace can write through — reintroducing the tier-3
  // contamination reconstitution exists to end. A target's `.gitignore` cannot
  // be relied on to stop it: the usual `node_modules/` pattern matches
  // directories, and this is a symlink.
  it("keeps the symlinked dependencies out of the baseline commit", () => {
    const src = sourceRepo(); // its committed .gitignore already holds node_modules/

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
    const src = sourceRepo(); // its committed .gitignore already holds node_modules/
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
    // Committed, not just written: an uncommitted edit to the source no longer
    // reaches the workspace (ADR-0018), so a bare write here would leave this
    // test asserting nothing.
    writeFileSync(path.join(src, ".gitignore"), "node_modules/\ntarget/\n.claude/\n");
    git(src, ["add", ".gitignore"]);
    git(src, ["commit", "-m", "ignore claude", "--quiet"]);

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
