/**
 * The reconstituted verification tree (ADR-0013), on its own.
 *
 * Hermetic: the workspaces here carry a lockfile npm chokes on locally, so the
 * install failures below never reach the network, and the trees that succeed
 * have no dependencies to fetch.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { constructVerificationTree, TreeConstructionError } from "../src/verification-tree.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
}

/** A workspace at its baseline commit, exactly as prepareWorkspace leaves one. */
function tempWorkspace(base: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-tree-"));
  dirs.push(dir, `${dir}.verify`);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fleet@example.test"]);
  git(dir, ["config", "user.name", "fleet"]);
  write(dir, base);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "baseline"]);
  return dir;
}

/** What the agent did, staged and diffed the way `stagedDiff` does it. */
function stagedDiff(workspace: string, changes: Record<string, string>): string {
  write(workspace, changes);
  git(workspace, ["add", "-A", "--", "."]);
  return git(workspace, ["diff", "--cached"]);
}

/** A lockfile npm refuses to read — a local failure, no network. */
const BROKEN_LOCKFILE = "{ not json";
const PACKAGE_JSON = JSON.stringify({ name: "target", scripts: { test: "node --test" } });
/** A dependency closure of nothing, so `npm ci` succeeds without a registry. */
const EMPTY_LOCKFILE = JSON.stringify({
  name: "target",
  lockfileVersion: 3,
  requires: true,
  packages: { "": { name: "target" } },
});

function constructionError(fn: () => unknown): TreeConstructionError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TreeConstructionError) return error;
    throw error;
  }
  throw new Error("expected tree construction to fail, and it did not");
}

describe("constructVerificationTree", () => {
  // ADR-0016 §3, first cell. The install fails at the base, so no verdict on
  // the change exists — the run itself broke, and nothing here is the agent's
  // fault. Attribution is the whole point: an unattributed install failure is
  // the one row from which nothing can be learned.
  it("attributes an install that fails at the base to infrastructure", () => {
    const workspace = tempWorkspace({
      "package.json": PACKAGE_JSON,
      "package-lock.json": BROKEN_LOCKFILE,
      "src/a.js": "export const a = 1;\n",
    });
    const diff = stagedDiff(workspace, { "src/a.js": "export const a = 2;\n" });

    const error = constructionError(() => constructVerificationTree({ workspace, diff }));

    expect(error.attribution).toBe("infrastructure");
    expect(error.message).toMatch(/dependency install failed/);
  });

  // ADR-0016 §3, second cell. The base installed, so the environment is sound;
  // what broke arrived with the diff. `verify-failed` — a kill the agent earned.
  it("attributes an install that fails only after the diff to the change", () => {
    const workspace = tempWorkspace({
      "package.json": PACKAGE_JSON,
      "package-lock.json": EMPTY_LOCKFILE,
      "src/a.js": "export const a = 1;\n",
    });
    const diff = stagedDiff(workspace, { "package-lock.json": BROKEN_LOCKFILE });

    const error = constructionError(() => constructVerificationTree({ workspace, diff }));

    expect(error.attribution).toBe("change");
    expect(error.message).toMatch(/dependency install failed/);
  });

  // The property the whole design rests on (ADR-0013): the tree is built from
  // git objects, so a gate input that never entered the index cannot reach it.
  // Tiers 2 and 3 are unreachable by construction here, not by a restore list —
  // nothing in this function names `.claude` or `node_modules` at all.
  it("carries the shipped change and nothing the workspace grew outside git", () => {
    const workspace = tempWorkspace({
      ".gitignore": "node_modules/\n",
      "src/a.js": "export const a = 1;\n",
    });
    const diff = stagedDiff(workspace, { "src/a.js": "export const a = 2;\n" });
    // What the agent can write and the index never sees: the harness config
    // `stagedDiff` resets out, and the dependencies the checks execute.
    write(workspace, {
      ".claude/settings.json": "{}",
      "node_modules/left-pad/index.js": "module.exports = () => 'tampered';\n",
    });

    const tree = constructVerificationTree({ workspace, diff });

    expect(readFileSync(path.join(tree.path, "src/a.js"), "utf8")).toBe("export const a = 2;\n");
    expect(existsSync(path.join(tree.path, ".claude"))).toBe(false);
    expect(existsSync(path.join(tree.path, "node_modules"))).toBe(false);
  });

  // The cloud shape. `prepareWorkspace` shallow-clones when it is not `--local`,
  // and a worktree of a repository with no history is the one construction that
  // could plausibly behave differently there than on a developer's machine —
  // where every workspace is a `git init` with a baseline commit.
  it("builds from a shallow clone, which is what a cloud run gives it", () => {
    const origin = tempWorkspace({ "src/a.js": "export const a = 1;\n" });
    const workspace = `${origin}.clone`;
    dirs.push(workspace, `${workspace}.verify`);
    // file:// because git ignores --depth on a plain local path.
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${origin}`, workspace]);
    const diff = stagedDiff(workspace, { "src/a.js": "export const a = 2;\n" });

    const tree = constructVerificationTree({ workspace, diff });

    expect(git(workspace, ["rev-parse", "--is-shallow-repository"]).trim()).toBe("true");
    expect(readFileSync(path.join(tree.path, "src/a.js"), "utf8")).toBe("export const a = 2;\n");
  });
});
