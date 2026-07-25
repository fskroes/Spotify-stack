import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { summarizers, summarizeGeneric } from "./summarize.js";

const execFileAsync = promisify(execFile);

const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * @typedef {object} Check
 * @property {string} name         Stable id; keys into `summarizers` (a `:dir`
 *   suffix on a nested-workspace check falls back to the base name there)
 * @property {string} label        Human-readable description
 * @property {string} command
 * @property {string[]} args
 * @property {string} [cwd]        Directory the check runs in. Absent = the
 *   verify root; set to a nested workspace's directory for its checks.
 *
 * @typedef {"passed" | "failed" | "skipped"} CheckStatus
 *   `skipped` = detected but never executed (an earlier check failed). A
 *   boolean could not say that, so a check that did not run cannot be mistaken
 *   for one that passed.
 *
 * @typedef {object} CheckResult
 * @property {string} name
 * @property {string} label
 * @property {CheckStatus} status
 * @property {string} summary      Empty unless the check failed; its capped summary when it did
 * @property {number} durationMs   0 for a skipped check — it consumed no time
 *
 * @typedef {"passed" | "failed" | "inconclusive"} VerifyState
 *   Mirrors VERIFY_STATES in @fleet/contract (this package is dependency-free
 *   plain JS and cannot import it). `inconclusive` = no verifier ran at all,
 *   which is a legitimate state for a repo that has none — but not a pass.
 *
 * @typedef {object} VerifyResult
 * @property {VerifyState} state
 * @property {CheckResult[]} checks  Every detected check, including skipped ones
 * @property {string} summary        Agent-facing text for the whole run
 */

/**
 * Detect which verifiers apply to a workspace — Spotify part 3: "verifiers
 * activate automatically based on codebase contents".
 *
 * @param {string} cwd
 * @param {{ platform?: NodeJS.Platform }} [opts] Override the host platform;
 *   defaults to `process.platform`. Injected so tests can exercise the
 *   macOS-only Xcode branch deterministically on any CI host.
 * @returns {Check[]}
 */
export function detect(cwd, { platform = process.platform } = {}) {
  /** @type {Check[]} */
  const checks = [];

  // The root workspace first, then any independent nested workspace (its checks
  // namespaced and run in its own directory). A repo is not always one JS
  // workspace: a nested `mobile/` app with its own suite is a second one the
  // root `test` never runs, so a change there used to pass the gate vacuously (#95).
  checks.push(...npmChecks(cwd, ""));
  for (const dir of nestedWorkspaces(cwd)) {
    const nested = npmChecks(path.join(cwd, dir), dir);
    // Gate a nested workspace only when it has a real verifier, not merely an
    // install. npmChecks is the single source of "what counts as a verifier",
    // so this stays in lockstep with the root without re-deriving the predicate.
    if (nested.some((c) => !c.name.startsWith("npm-install"))) checks.push(...nested);
  }

  if (existsSync(path.join(cwd, "Package.swift"))) {
    checks.push({ name: "swift-build", label: "swift build", command: "swift", args: ["build"] });
    checks.push({ name: "swift-test", label: "swift test", command: "swift", args: ["test"] });
  } else if (platform === "darwin") {
    // Xcode-app projects (*.xcodeproj, usually XcodeGen-managed) can't be built
    // by SPM — they carry an Info.plist, entitlements, and asset catalog. Only
    // gate on macOS: `xcodebuild` doesn't exist on the Linux cloud runners, so
    // off-darwin this stays a vacuous pass rather than a hard ENOENT failure.
    const project = readdirSync(cwd).find((f) => f.endsWith(".xcodeproj"));
    if (project) {
      // XcodeGen single-app projects name the scheme after the project. A repo
      // whose scheme differs fails verify loudly, not silently — acceptable
      // until scheme discovery (`xcodebuild -list`) justifies an async detect().
      const scheme = path.basename(project, ".xcodeproj");
      const baseArgs = ["-project", project, "-scheme", scheme, "-destination", "platform=macOS", "CODE_SIGNING_ALLOWED=NO"];
      checks.push({
        name: "xcodebuild-build",
        label: "xcodebuild build",
        command: "xcodebuild",
        args: ["build", ...baseArgs],
      });
      // Only gate on tests when a test action is evident — `xcodebuild test`
      // errors on a scheme with no test action, which would fail a test-less
      // Xcode repo for lacking tests. Cheap sync heuristic, no workspace mutation.
      const projectYml = path.join(cwd, "project.yml");
      const hasUnitTestTarget = existsSync(projectYml) && readFileSync(projectYml, "utf8").includes("bundle.unit-test");
      const hasTestsDir = readdirSync(cwd, { withFileTypes: true }).some((e) => e.isDirectory() && e.name.endsWith("Tests"));
      if (hasUnitTestTarget || hasTestsDir) {
        checks.push({
          name: "xcodebuild-test",
          label: "xcodebuild test",
          command: "xcodebuild",
          args: ["test", ...baseArgs],
        });
      }
    }
  }

  return checks;
}

/**
 * The npm-shape checks for one JS/TS workspace rooted at `dir`. `relDir` is ""
 * for the repo root and the nested directory's name (e.g. "mobile") otherwise;
 * it both namespaces the check ids — the task-facing `gates:` vocabulary, so a
 * nested test becomes `test:mobile` — and, via each check's `cwd`, routes the
 * check to run inside `dir`.
 *
 * @param {string} dir     Absolute workspace directory (holds package.json)
 * @param {string} relDir  "" for the root, else the nested dir's name
 * @returns {Check[]}
 */
function npmChecks(dir, relDir) {
  if (!existsSync(path.join(dir, "package.json"))) return [];
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  const suffix = relDir ? `:${relDir}` : "";
  const where = relDir ? ` (${relDir}/)` : "";
  /** @type {Check[]} */
  const checks = [];
  if (!existsSync(path.join(dir, "node_modules"))) {
    // npm ci never rewrites the lockfile — plain `npm install` can, and any
    // such write lands in the run diff and gets the change vetoed.
    const hasLockfile = existsSync(path.join(dir, "package-lock.json"));
    checks.push({
      name: `npm-install${suffix}`,
      label: `${hasLockfile ? "npm ci" : "npm install"}${where}`,
      command: "npm",
      args: hasLockfile ? ["ci", "--no-fund", "--no-audit"] : ["install", "--no-fund", "--no-audit"],
      cwd: dir,
    });
  }
  if (scripts.lint) {
    checks.push({ name: `eslint${suffix}`, label: `npm run lint${where}`, command: "npm", args: ["run", "lint"], cwd: dir });
  }
  if (scripts.typecheck) {
    checks.push({ name: `tsc${suffix}`, label: `npm run typecheck${where}`, command: "npm", args: ["run", "typecheck"], cwd: dir });
  } else if (existsSync(path.join(dir, "tsconfig.json"))) {
    checks.push({ name: `tsc${suffix}`, label: `tsc --noEmit${where}`, command: "npx", args: ["tsc", "--noEmit"], cwd: dir });
  }
  if (scripts.test) {
    // Named for the script, not for one runner: this fires for any `test`
    // script, so a jest or node:test repo used to get a check called "vitest".
    // Check names are the task-facing `gates:` vocabulary, so the misnomer
    // would have been permanent the moment a task mandated it.
    checks.push({ name: `test${suffix}`, label: `npm run test${where}`, command: "npm", args: ["run", "test"], cwd: dir });
  }
  return checks;
}

/**
 * Immediate child directories that are INDEPENDENT npm workspaces: each has its
 * own package.json and its own package-lock.json. The lockfile is the
 * discriminator — an independent app carries its own dependency closure, whereas
 * a hoisted workspace member has none (its deps live in the root lockfile), so
 * the root runner already covers it and descending would double-run.
 *
 * This is a robust proxy, not a proof. It assumes the app commits its lockfile
 * (the fleet's targets do; an uncommitted one would be silently skipped) and
 * that an independent closure isn't also chained into the root `test` script (if
 * it were, the suite would run twice — wasteful, but not a false green). Both
 * hold for the target shape: a nested `mobile/` app with its own lockfile.
 *
 * npm only: npmChecks installs via `npm ci` / `npm install`, so a pnpm- or
 * yarn-locked nested app is left for a deliberate per-manager follow-up rather
 * than installed unsoundly. Depth 1 only: covers the `mobile/` shape without
 * wandering into fixtures or `packages/*`-style nesting. node_modules and dot
 * directories are never the repo's own workspaces, so they are skipped. Whether
 * a dir actually carries a verifier is decided by npmChecks (the single source
 * of truth), not re-derived here.
 *
 * @param {string} cwd  The verify root
 * @returns {string[]}  Nested directory names, sorted for deterministic order
 */
function nestedWorkspaces(cwd) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(cwd, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const dir = path.join(cwd, entry.name);
    if (!existsSync(path.join(dir, "package.json"))) continue;
    // Own lockfile ⇒ independent closure. Without one it is a hoisted member the
    // root runner already covers, so gating it here would only double-run.
    if (!existsSync(path.join(dir, "package-lock.json"))) continue;
    found.push(entry.name);
  }
  return found.sort();
}

/**
 * Run one check, capturing combined output.
 *
 * @param {string} cwd    The verify root; a check without its own `cwd` runs here
 * @param {Check} check
 * @returns {Promise<CheckResult>}
 */
async function runCheck(cwd, check) {
  const started = Date.now();
  try {
    await execFileAsync(check.command, check.args, {
      cwd: check.cwd ?? cwd,
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    return { name: check.name, label: check.label, status: "passed", summary: "", durationMs: Date.now() - started };
  } catch (/** @type {any} */ err) {
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    // A nested check id (`test:mobile`) has no entry of its own — fall back to
    // the base name (`test`) so it reuses the right parser, not the generic one.
    const summarize = summarizers[check.name] ?? summarizers[check.name.split(":")[0]] ?? summarizeGeneric;
    const timedOut = err.killed || err.signal === "SIGTERM";
    const summary = timedOut
      ? `check timed out after ${CHECK_TIMEOUT_MS / 1000}s`
      : summarize(output);
    return { name: check.name, label: check.label, status: "failed", summary, durationMs: Date.now() - started };
  }
}

/**
 * Run all detected verifiers for a workspace. Stops at the first failing
 * check (later checks usually cascade from the same root cause).
 *
 * @param {string} cwd
 * @returns {Promise<VerifyResult>}
 */
export async function runVerify(cwd) {
  const checks = detect(cwd);
  if (checks.length === 0) {
    // A repo with no verifiers is legitimate; a pass for it is not. Nothing ran,
    // so there is nothing to assert about the change — say exactly that.
    return {
      state: "inconclusive",
      checks: [],
      summary:
        "VERIFY INCONCLUSIVE — no verifiers detected for this repository (no package.json, Package.swift, or Xcode project). " +
        "Nothing was executed, so this change is unverified. This is not a pass.",
    };
  }

  /** @type {CheckResult[]} */
  const results = [];
  for (const check of checks) {
    const result = await runCheck(cwd, check);
    results.push(result);
    if (result.status === "failed") break;
  }
  // Detected but never reached — carried in `checks` rather than only in the
  // summary prose, so a reader can tell "did not run" from "passed".
  for (const check of checks.slice(results.length)) {
    results.push({ name: check.name, label: check.label, status: "skipped", summary: "", durationMs: 0 });
  }

  const failed = results.some((r) => r.status === "failed");
  const lines = results.map((r) =>
    r.status === "passed"
      ? `✔ ${r.label} passed (${(r.durationMs / 1000).toFixed(1)}s)`
      : r.status === "failed"
        ? `✖ ${r.label} FAILED (${(r.durationMs / 1000).toFixed(1)}s)\n${r.summary}`
        : `– ${r.label} skipped (earlier check failed)`,
  );

  return {
    state: failed ? "failed" : "passed",
    checks: results,
    summary: `${failed ? "VERIFY FAILED" : "VERIFY PASSED"}\n${lines.join("\n")}`,
  };
}
