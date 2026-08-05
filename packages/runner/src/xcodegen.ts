import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const GENERATE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;

/** The spec XcodeGen reads. Root-only, which is where `detect()` looks for it. */
const SPEC = "project.yml";

/**
 * The host, injected rather than read from `process.platform` — the same seam
 * `detect()` carries, and for the same reason: the darwin-only branch is then
 * exercised by the test suite on any host, including the Linux CI that runs it.
 */
export interface GenerateOptions {
  platform?: string;
}

/**
 * Does this root declare an XcodeGen project *and* can a build here mean
 * anything? Both halves matter.
 *
 * Off darwin the answer is no, and that is not a convenience: `detect()` emits
 * `xcodebuild-*` only on darwin, because `xcodebuild` does not exist on the
 * Linux cloud runners. Generating there would demand a `xcodegen` binary those
 * runners have no reason to carry, to produce a project nothing then builds
 * ([ADR-0023](../../../docs/adr/0023-a-generated-project-is-tree-construction-not-a-gate-input.md)).
 */
function declaresXcodeProject(root: string, opts: GenerateOptions): boolean {
  return (opts.platform ?? process.platform) === "darwin" && existsSync(path.join(root, SPEC));
}

/**
 * Materialise the Xcode project from `project.yml`, unconditionally.
 *
 * **This is tree construction, not a check** (ADR-0016 §2). `git checkout` is
 * not modelled as a check and `npm ci` has no better claim; `xcodegen generate`
 * is the same kind of thing — a deterministic materialisation of a declared
 * spec, needed to make the tree runnable at all. Placed here it runs *before*
 * `runVerify`, and `detect()` is path-shaped, so it finds a generated
 * `*.xcodeproj` exactly as it found a checked-in one: same check names, same
 * meanings, no registered verifier, no `gates:` line rewritten (ADR-0023).
 *
 * Deliberately not idempotent, for the reason `install` is not: this is the
 * unconditional half of a two-point call, and its second point runs over a tree
 * whose first point already produced a project. A function that skipped a
 * populated tree could never make the second call, and the second call is what
 * distinguishes a target whose own spec is broken from a diff that broke it
 * (ADR-0016 §3).
 *
 * **A missing binary is a loud failure, never a quiet skip.** Skipping would
 * build against whatever project happened to be on disk — a stale one — which is
 * precisely the false green ADR-0023 exists to remove.
 */
export function generateXcodeProject(root: string, opts: GenerateOptions = {}): void {
  if (!declaresXcodeProject(root, opts)) return;
  try {
    execFileSync("xcodegen", ["generate", "--quiet"], {
      cwd: root,
      encoding: "utf8",
      // Captured, not inherited, as the installs are: the throw below reports
      // the failure once, with the spec named.
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GENERATE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (error) {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === "ENOENT") {
      throw new Error(
        `xcodegen is not installed, and ${SPEC} is present in ${root}.\n` +
          "XcodeGen is a host requirement on darwin since ADR-0023: the Xcode project is " +
          "generated during tree construction, not checked in. Install it (`brew install xcodegen`).",
      );
    }
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    throw new Error(`xcodegen generate failed from ${SPEC}: ${output || err.message}`);
  }
}

/**
 * Make the Xcode project present in the agent's workspace, so the in-session
 * `verify` ([ADR-0017](../../../docs/adr/0017-the-in-session-verify-is-the-retry-loop.md))
 * detects the same checks the verification tree will.
 *
 * The workspace sibling of `ensureDependencies`, idempotent for the same reason
 * and by the same interface: a project already on disk is left alone.
 *
 * That skip is load-bearing, not thrift. A workspace is materialised from the
 * source's `HEAD`, so a project on disk here is one the target still *tracks* —
 * and regenerating a tracked file would write a diff hunk the agent did not
 * author, which `stagedDiff` would stage and the judge would read as the change.
 * Once the target untracks it there is nothing on disk to find, the guard opens,
 * and the generated project stays out of the diff via the target's `.gitignore`
 * — which is the same commit that untracked it.
 *
 * Generating is a filesystem-mutating side effect, so it is the runner's job and
 * never the agent's ([ADR-0003](../../../docs/adr/0003-the-runner-owns-git.md)).
 * An agent that could regenerate its own project could redefine what its gate
 * compiles.
 */
export function ensureXcodeProject(root: string, opts: GenerateOptions = {}): void {
  if (!declaresXcodeProject(root, opts)) return;
  const present = readdirSync(root).some((entry) => entry.endsWith(".xcodeproj"));
  if (present) return;
  generateXcodeProject(root, opts);
}
