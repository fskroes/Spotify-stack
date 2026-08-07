import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { nestedWorkspaces } from "@fleet/mcp-verify";

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Which installer to run, read off the lockfile the target committed. This is a
 * convention, never per-target configuration — the same shape the gate-input set
 * uses (ADR-0020). A target that commits a lockfile has already named its
 * package manager, and a `pnpm` field in `repos.yaml` would be a second place
 * for that answer to live and drift from.
 *
 * Every entry names a command that **cannot rewrite the lockfile**. `npm ci` and
 * `pnpm --frozen-lockfile` both fail rather than resolve when the lockfile and
 * `package.json` disagree. Plain `npm install` can write, and any such write
 * lands in the run diff as a change nobody authored.
 *
 * pnpm is matched first: npm never produces `pnpm-lock.yaml`, so its presence is
 * a positive statement about the target, while a stray `package-lock.json` in a
 * pnpm repo is what this table exists to stop the runner creating.
 */
const INSTALLERS = [
  { lockfile: "pnpm-lock.yaml", command: "pnpm", args: ["install", "--frozen-lockfile"] },
  { lockfile: "package-lock.json", command: "npm", args: ["ci", "--no-fund", "--no-audit"] },
] as const;

/**
 * No lockfile, so nothing is pinned and nothing can be violated. `npm install`
 * writes `package-lock.json` here, which is correct: the workspace had no
 * lockfile to preserve.
 */
const NO_LOCKFILE = { command: "npm", args: ["install", "--no-fund", "--no-audit"] } as const;

/**
 * Make a workspace's dependencies present, so the checks that resolve their
 * executables out of `node_modules` can run at all.
 *
 * This is the runner's job, not a verifier's. Installing is a network-touching,
 * filesystem-mutating side effect, and the runner owns every side effect
 * ([ADR-0003](../../../docs/adr/0003-the-runner-owns-git.md)). It used to be
 * `npm-install`, a check the detector emitted whenever `node_modules` was
 * missing — which meant the agent triggered an install by calling `verify`, and
 * meant a repo with a package.json but no lint/typecheck/test script could go
 * green on the install alone (ADR-0016 §2).
 *
 * **Idempotent, and that is the interface.** A workspace whose dependencies are
 * already present is left alone — `--local` runs symlink the source's
 * `node_modules` (see prepareWorkspace), which is a legitimate way for them to
 * be present and is far cheaper than reinstalling per run. The reconstituted
 * verification tree of ADR-0013 is a clean checkout, so it would always take the
 * installing branch; it is deliberately NOT sharing this function, because it
 * needs an unconditional two-point install with failure attribution
 * (ADR-0016 §3) and one function cannot be both idempotent and two-point.
 *
 * The nested-workspace set is the detector's, imported rather than re-derived:
 * a nested app that gets gated but not installed would fail for a reason that
 * looks nothing like its cause.
 *
 * Throws on a failed install. What that failure *means* belongs to the caller —
 * here it kills the run before an agent ever sees the workspace.
 */
export function ensureDependencies(root: string): void {
  const workspaces = [root, ...nestedWorkspaces(root).map((dir) => path.join(root, dir))];
  for (const dir of workspaces) {
    if (!existsSync(path.join(dir, "package.json"))) continue;
    if (existsSync(path.join(dir, "node_modules"))) continue;
    const installer =
      INSTALLERS.find((i) => existsSync(path.join(dir, i.lockfile))) ?? NO_LOCKFILE;
    const args = [...installer.args];
    try {
      execFileSync(installer.command, args, {
        cwd: dir,
        encoding: "utf8",
        // Captured, not inherited: execFileSync would otherwise echo the
        // installer's stderr straight to the runner's log, where a failure is
        // already reported once — with the directory attached — by the throw
        // below.
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
          `(${installer.command} ${args[0]}): ${output || err.message}`,
      );
    }
  }
}
