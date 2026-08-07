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
 *   Mirrors VERIFY_STATES in packages/runner/src/wire.ts (this package is dependency-free
 *   plain JS and cannot import it). `inconclusive` = no verifier ran at all,
 *   which is a legitimate state for a repo that has none — but not a pass.
 *
 * @typedef {object} VerifyResult
 * @property {VerifyState} state
 * @property {CheckResult[]} checks  Every detected check, including skipped ones
 * @property {string} summary        Agent-facing text for the whole run
 */

/**
 * Every base check name `detect` can emit. A nested workspace suffixes these
 * (`test:web`), so this is the vocabulary, not the full set of ids.
 *
 * It exists so the fleet registry can refuse a registered verifier that would
 * shadow a detected one (ADR-0009) without the shadowing rule hand-copying a
 * list that then drifts. `detected-names.test.js` locks it to the detector.
 */
export const DETECTED_CHECK_NAMES = [
  "eslint",
  "tsc",
  "test",
  "swift-build",
  "swift-test",
  "xcodebuild-build",
  "xcodebuild-test",
];

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
    checks.push(...npmChecks(path.join(cwd, dir), dir));
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
 * Emits verifiers only. Installing dependencies is not a check (ADR-0016): it is
 * how a tree is made runnable, so it belongs to whoever builds the tree — the
 * runner, which owns every side effect (ADR-0003). Detection is therefore
 * independent of whether `node_modules` happens to exist, which is what keeps
 * this module caller-blind: the same repo yields the same check list in the
 * agent's workspace and in the runner's reconstituted tree.
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
 * own package.json and its own package-lock.json.
 *
 * The lockfile discriminates against **double-running**, not against installing:
 * a hoisted workspace member has no lockfile of its own (its deps live in the
 * root's), and the root's own `test` script already runs it, so descending would
 * run the same suite twice. An independent app carries its own closure and its
 * own suite, which the root script deliberately excludes (#95).
 *
 * This is a robust proxy, not a proof. It assumes the app commits its lockfile
 * (the fleet's targets do; an uncommitted one would be silently skipped) and
 * that an independent closure isn't also chained into the root `test` script (if
 * it were, the suite would run twice — wasteful, but not a false green). Both
 * hold for the target shape: a nested `mobile/` app with its own lockfile.
 *
 * A pnpm- or yarn-locked nested app falls out as a side effect of the same
 * predicate and stays a deliberate per-manager follow-up. Depth 1 only: covers
 * the `mobile/` shape without wandering into fixtures or `packages/*`-style
 * nesting. node_modules and dot directories are never the repo's own workspaces,
 * so they are skipped. Whether a dir actually carries a verifier is decided by
 * npmChecks (the single source of truth), not re-derived here.
 *
 * @param {string} cwd  The verify root
 * @returns {string[]}  Nested directory names, sorted for deterministic order
 */
export function nestedWorkspaces(cwd) {
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
      // Detected checks carry an absolute cwd; a registered one (ADR-0009) is
      // written by hand and is naturally relative to the workspace root.
      // `resolve` takes both — an absolute second argument passes through.
      cwd: check.cwd ? path.resolve(cwd, check.cwd) : cwd,
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
 * The registered verifiers the runner passed into this process, if any.
 *
 * An env var rather than a file, deliberately: the workspace is the one place
 * the agent may write, so a check list living there is a check list the agent
 * can edit. This is read once, from an environment only the runner sets.
 *
 * A malformed payload throws. Quietly falling back to "no registered checks"
 * would turn a runner bug into a verification that looks complete and is not —
 * the one output this system may not produce.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Check[]}
 */
export function readRegisteredFromEnv(env) {
  const raw = env.VERIFY_REGISTERED;
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`VERIFY_REGISTERED is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`VERIFY_REGISTERED must be a JSON array of checks, got ${typeof parsed}`);
  }
  return parsed;
}

/**
 * Run all verifiers for a workspace. Stops at the first failing check (later
 * checks usually cascade from the same root cause).
 *
 * `registered` carries the target's registered verifiers (ADR-0009) as ordinary
 * Checks. This module stays target-blind: it never reads the fleet registry and
 * does not know one exists — only the runner holds both halves, so only the
 * runner composes them, the same seam that folds in mandated gates.
 *
 * Registered checks run **after** every detected one. They are the checks that
 * may cost money, so a cheap detected failure must short-circuit them.
 *
 * @param {string} cwd
 * @param {{ registered?: Check[] }} [opts]
 * @returns {Promise<VerifyResult>}
 */
export async function runVerify(cwd, { registered = [] } = {}) {
  const detected = detect(cwd);

  // The shadowing rule, enforced where both halves are actually present. The
  // registry's load-time check catches the common case, but detection is
  // per-workspace: a nested workspace can produce a name (`test:web`) the
  // registry could not have known about. A silent override there would be a
  // false green, so this throws rather than picking a winner.
  const detectedNames = new Set(detected.map((c) => c.name));
  for (const check of registered) {
    if (detectedNames.has(check.name)) {
      throw new Error(
        `registered verifier "${check.name}" would shadow a detected check in this workspace. ` +
          "Rename the registered check; registration may not redefine a check the fleet can infer.",
      );
    }
  }

  const checks = [...detected, ...registered];
  if (checks.length === 0) {
    // A repo with no verifiers is legitimate; a pass for it is not. Nothing ran,
    // so there is nothing to assert about the change — say exactly that.
    //
    // The cause is named as a disjunction rather than asserted: since an install
    // stopped counting as a verifier (ADR-0016), a repo CAN carry a package.json
    // and still detect nothing, so the old parenthetical ("no package.json,
    // Package.swift, or Xcode project") became false for the exact case this
    // change made reachable.
    return {
      state: "inconclusive",
      checks: [],
      summary:
        "VERIFY INCONCLUSIVE — no verifiers detected for this repository: it declares no lint, " +
        "typecheck, or test script, and carries no Package.swift or Xcode project. " +
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
