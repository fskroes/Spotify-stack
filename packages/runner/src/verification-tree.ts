import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { nestedWorkspaces } from "@fleet/mcp-verify";
import { git } from "./workspace.js";

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Which half of the run a failed tree build belongs to (ADR-0016 §3).
 *
 * `infrastructure` — the run itself broke and no verdict on the change exists.
 * `change` — the change broke its own dependency resolution; a kill it earned.
 */
export type TreeAttribution = "infrastructure" | "change";

export class TreeConstructionError extends Error {
  readonly attribution: TreeAttribution;

  constructor(attribution: TreeAttribution, message: string) {
    super(message);
    this.name = "TreeConstructionError";
    this.attribution = attribution;
  }
}

/**
 * Install a workspace's dependencies from its lockfile, unconditionally.
 *
 * Deliberately not `ensureDependencies`: that one is idempotent — "ensure", not
 * "install" — because the agent's workspace may legitimately already hold them
 * (ADR-0017 §3). This is the other half of a two-point install, whose second
 * point runs over a tree the first one already populated, so a function that
 * skips a populated tree could never make it (ADR-0016 §3).
 */
function install(root: string): void {
  const workspaces = [root, ...nestedWorkspaces(root).map((dir) => path.join(root, dir))];
  for (const dir of workspaces) {
    if (!existsSync(path.join(dir, "package.json"))) continue;
    // `npm ci` never rewrites the lockfile; plain `npm install` can, and this
    // tree's whole claim is that it holds the dependencies the lockfile names.
    const hasLockfile = existsSync(path.join(dir, "package-lock.json"));
    const args = hasLockfile
      ? ["ci", "--no-fund", "--no-audit"]
      : ["install", "--no-fund", "--no-audit"];
    try {
      execFileSync("npm", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
      throw new Error(
        `dependency install failed in ${path.relative(root, dir) || "."} ` +
          `(npm ${args[0]}): ${output || err.message}`,
      );
    }
  }
}

export interface VerificationTree {
  /** Absolute path of the tree. This is what `runVerify` is pointed at. */
  path: string;
  /** The commit the tree was checked out at — what the change was verified against. */
  base: string;
}

/**
 * Reconstitute the tree verification runs on: the base commit, the staged diff
 * applied to it, dependencies installed from the lockfile at both points
 * ([ADR-0013](../../../docs/adr/0013-verification-runs-on-the-shipped-artefact.md)).
 *
 * **Built from git objects, never by copying the workspace.** That is what makes
 * ADR-0013's invisible tiers unreachable by construction rather than by
 * discipline: the harness config and `node_modules` are not in the base commit
 * and not in the diff, so nothing has to remember to exclude them, and no
 * "restore the harness" step may be added back out of caution.
 */
export function constructVerificationTree(opts: { workspace: string; diff: string }): VerificationTree {
  // Beside the workspace it belongs to, and kept after the run for the same
  // reason the workspace is: it is the tree the verdict was actually produced
  // on, and a red verify is re-runnable there. It does not accumulate within a
  // run — every pass rebuilds this one path.
  const treePath = `${opts.workspace}.verify`;
  const base = git(opts.workspace, ["rev-parse", "HEAD"]).trim();

  // A pass rebuilds from scratch: a veto retry must not verify against the tree
  // its predecessor's diff produced. Prune first, so a directory removed out
  // from under git's worktree admin does not block re-registering the path.
  rmSync(treePath, { recursive: true, force: true });
  git(opts.workspace, ["worktree", "prune"]);
  git(opts.workspace, ["worktree", "add", "--detach", "--quiet", treePath, base]);

  const attributed = (attribution: TreeAttribution, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      throw new TreeConstructionError(attribution, error instanceof Error ? error.message : String(error));
    }
  };

  // The order *is* the attribution (ADR-0016 §3). Installing before the diff is
  // applied is what lets a broken environment be told apart from a change that
  // broke its own dependency resolution — with no machinery beyond the sequence.
  attributed("infrastructure", () => install(treePath));
  // The patch applied is the same text the judge reviews and the PR ships, which
  // is the whole rule (ADR-0013): verify the thing you are going to ship.
  //
  // Known residual, recorded rather than chased: `git diff --cached` renders a
  // binary file as "Binary files differ", which `git apply` cannot apply, so a
  // diff carrying one dies here and is filed as infrastructure. No target has
  // produced one — the agent is told not to touch dependency manifests, and it
  // writes source. The fix, if one is ever needed, is a `--binary` patch for the
  // tree alone, which would end the property that the reviewed bytes and the
  // verified bytes are one artefact.
  attributed("infrastructure", () => git(treePath, ["apply", "-"], opts.diff));
  // Unconditional, with no list of dependency files that would trigger it: a
  // missing entry mis-attributes a diff-caused failure as infrastructure, and
  // an install of an already-installed closure measures ~1 s.
  attributed("change", () => install(treePath));

  return { path: treePath, base };
}
