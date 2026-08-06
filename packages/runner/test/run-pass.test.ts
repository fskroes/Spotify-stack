/**
 * One pass, on its own — the four-phase agent → scope → verify → judge sequence
 * (`CONTEXT.md`: "Pass"), reached directly with fakes in place of the engine and
 * the judge. While the sequence lived twice inside `run()` the only way in was a
 * whole run, so the rules the two copies disagreed on had no test at all. These
 * are those rules.
 *
 * The workspace is a real git repo — `stagedDiff` stages and diffs for real —
 * but it holds no package.json, so verification comes back `inconclusive`
 * (nothing detectable) without spawning a single check. What verification
 * *does* is covered in e2e; what a pass does with its answer is covered here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import picomatch from "picomatch";
import { afterEach, describe, expect, it } from "vitest";
import type { Stage } from "@fleet/contract";
import type { JudgeResult, Verdict } from "@fleet/judge";
import type { Engine, EngineResult } from "../src/engine.js";
import type { InflightHandle } from "../src/inflight.js";
import { createUsageCollector, unavailableProducerUsage } from "../src/model-usage.js";
import {
  runPass,
  type ApprovedPass,
  type EndedPass,
  type PassContext,
  type PassTimings,
} from "../src/run.js";
import type { Task } from "../src/task.js";

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/**
 * A real git repo with one commit, and deliberately no verifier to detect.
 * `base` seeds extra files into that commit — the only way to give the
 * reconstituted tree something to fail on, since it is built from the commit
 * and never from the working directory.
 */
function tempWorkspace(base: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-pass-"));
  // The tree this workspace reconstitutes for verification is its sibling.
  workspaces.push(dir, `${dir}.verify`);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fleet@example.test"]);
  git(dir, ["config", "user.name", "fleet"]);
  writeFileSync(path.join(dir, "README.md"), "base\n");
  for (const [rel, body] of Object.entries(base)) writeFileSync(path.join(dir, rel), body);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

/** A lockfile npm refuses to read, so these cases fail locally and offline. */
const BROKEN_LOCKFILE = "{ not json";
const PACKAGE_JSON = JSON.stringify({ name: "target", scripts: { test: "node --test" } });
const EMPTY_LOCKFILE = JSON.stringify({
  name: "target",
  lockfileVersion: 3,
  requires: true,
  packages: { "": { name: "target" } },
});

const taskFor = (scope?: string[], amends?: Task["amends"]): Task => ({
  id: "unit-pass",
  title: "a pass under test",
  targets: ["demo"],
  scope,
  amends,
  risk: "low",
  why: "unit",
  body: "do the thing",
  raw: "---\nid: unit-pass\n---\ndo the thing",
});

const engineResult = (resultText: string, sessionId = "session-1"): EngineResult => ({
  resultText,
  sessionId,
  transcript: JSON.stringify({ fixture: true }),
  usage: unavailableProducerUsage("fixture engine"),
});

const judgement = (verdict: Verdict): JudgeResult => ({
  verdict,
  usage: unavailableProducerUsage("fixture judge"),
  readPaths: [],
});

const APPROVE: Verdict = { verdict: "approve", violations: [], guidance: "", rationale: "fixture approve" };
const VETO: Verdict = {
  verdict: "veto",
  violations: ["fixture: first violation", "fixture: second violation"],
  guidance: "fixture guidance: narrow the change",
  rationale: "fixture veto",
};

interface Harness {
  ctx: PassContext;
  artifacts: Map<string, string>;
  stages: Array<[Stage, number | undefined]>;
  logs: string[];
  timings: PassTimings;
}

function harness(opts: {
  workspace: string;
  task?: Task;
  /** What the agent does on the run's one pass. */
  onRun: () => EngineResult;
}): Harness {
  const task = opts.task ?? taskFor();
  const artifacts = new Map<string, string>();
  const stages: Array<[Stage, number | undefined]> = [];
  const logs: string[] = [];
  const timings: PassTimings = { agentMs: 0, verifyMs: 0, judgeMs: 0 };

  const engine: Engine = {
    run: () => opts.onRun(),
  };

  const inflight: InflightHandle = {
    enter: (stage, pass) => stages.push([stage, pass]),
    clear: () => {},
  };

  const ctx: PassContext = {
    task,
    workspace: opts.workspace,
    engine,
    registered: [],
    inScope: task.scope ? picomatch(task.scope, { dot: true }) : undefined,
    artifact: (name, content) => {
      artifacts.set(name, content);
    },
    timed: async (phase, fn) => {
      const started = Date.now();
      try {
        return await fn();
      } finally {
        timings[phase] += Date.now() - started;
      }
    },
    inflight,
    usage: createUsageCollector(),
    log: (line) => logs.push(line),
  };

  return { ctx, artifacts, stages, logs, timings };
}

describe("a pass classifies an empty diff", () => {
  it("treats a diff that ends up empty as a failure when the sentinel is absent", async () => {
    const workspace = tempWorkspace();
    const h = harness({
      workspace,
      onRun: () => {
        // The agent edits and then puts the workspace back, leaving nothing to
        // review — and does not say so.
        writeFileSync(path.join(workspace, "added.ts"), "export const a = 1;\n");
        git(workspace, ["reset", "-q", "--hard", "HEAD"]);
        rmSync(path.join(workspace, "added.ts"), { force: true });
        return engineResult("I looked at it and left it alone");
      },
    });

    const pass = (await runPass(h.ctx)) as EndedPass;

    expect(pass.status).toBe("agent-failed");
    expect(pass.diff.trim()).toBe("");
  });

  it("treats it as a benign no-op when the agent declares the sentinel", async () => {
    const workspace = tempWorkspace();
    const h = harness({
      workspace,
      // The sentinel must END the reply, exactly as the task template demands.
      onRun: () => engineResult("On reflection nothing here needs changing.\nNO_CHANGES_NEEDED"),
    });

    const pass = (await runPass(h.ctx)) as EndedPass;

    expect(pass.status).toBe("no-changes");
  });
});

describe("a pass reports only what it observed", () => {
  it("carries no verification when it dies at scope", async () => {
    const workspace = tempWorkspace();
    const h = harness({
      workspace,
      task: taskFor(["src/**"]),
      onRun: () => {
        writeFileSync(path.join(workspace, "OUT-OF-SCOPE.md"), "sneaky\n");
        return engineResult("out of scope");
      },
    });

    const pass = (await runPass(h.ctx)) as EndedPass;

    expect(pass.status).toBe("scope-violation");
    expect(pass.scopeOffenders).toContain("OUT-OF-SCOPE.md");
    // The scope gate fires before verify, so nothing was ever proven here and
    // the pass must not imply otherwise.
    expect(pass.verify).toBeUndefined();
    expect(pass.unmetGates).toBeUndefined();
  });
});

/**
 * ADR-0016 §3. Verification runs on a tree reconstituted from git objects
 * (ADR-0013), and that tree can fail to build. Which side of the run owns the
 * failure is decided by *when* it happens, and it is a two-cell table: an
 * unattributed install failure is the one row from which nothing can be learned
 * about either the agent or the environment.
 */
describe("a failed dependency install is attributed, not filed", () => {
  it("files an install that fails at the base as infrastructure", async () => {
    const workspace = tempWorkspace({
      "package.json": PACKAGE_JSON,
      "package-lock.json": BROKEN_LOCKFILE,
    });
    const h = harness({
      workspace,
      onRun: () => {
        writeFileSync(path.join(workspace, "added.ts"), "export const a = 1;\n");
        return engineResult("made the change");
      },
    });

    const pass = (await runPass(h.ctx)) as EndedPass;

    // The run itself broke: nothing here is evidence about the change, so no
    // verdict on it exists.
    expect(pass.status).toBe("engine-failed");
    expect(pass.resultText).toMatch(/dependency install failed/);
    expect(pass.verify).toBeUndefined();
    // Still reviewable — the diff exists, it just never got verified.
    expect(h.artifacts.get("diff.patch")).toContain("added.ts");
  });

  it("kills a change that broke its own dependency resolution", async () => {
    const workspace = tempWorkspace({
      "package.json": PACKAGE_JSON,
      "package-lock.json": EMPTY_LOCKFILE,
    });
    const h = harness({
      workspace,
      // A lockfile is a gate input, so this cell is now reached only through a
      // licence (ADR-0014). That is the honest reading of both records
      // together: a change can break the dependency resolution the checks run
      // on **only if the task let it near the manifest in the first place.**
      task: taskFor(undefined, [{ glob: "package-lock.json", reason: "the pinned version is yanked" }]),
      onRun: () => {
        writeFileSync(path.join(workspace, "package-lock.json"), BROKEN_LOCKFILE);
        return engineResult("updated the lockfile");
      },
    });

    const pass = (await runPass(h.ctx)) as EndedPass;

    // The base installed, so the environment is sound. `verify-failed` carries
    // `diedAt: "verify"` from the contract's one facts table (ADR-0008), which
    // is what retains the kill's diff and its killing artefact (ADR-0015).
    expect(pass.status).toBe("verify-failed");
    expect(pass.resultText).toMatch(/dependency install failed/);
    expect(h.artifacts.get("verify.log")).toMatch(/dependency install failed/);
  });

  // The same edit without the licence, which is the ordinary shape: the tree
  // installs from the manifest the agent inherited, so the closure the checks
  // execute is one no diff can reach. The edit still ships.
  it("installs from the base manifest when the diff's edit to it is unamended", async () => {
    const workspace = tempWorkspace({
      "package.json": PACKAGE_JSON,
      "package-lock.json": EMPTY_LOCKFILE,
    });
    const h = harness({
      workspace,
      onRun: () => {
        writeFileSync(path.join(workspace, "package-lock.json"), BROKEN_LOCKFILE);
        return engineResult("updated the lockfile");
      },
    });

    const pass = (await runPass(h.ctx)) as ApprovedPass;

    expect(pass.outcome).toBe("approved");
    expect(pass.gateInputs.held).toEqual(["package-lock.json"]);
    expect(pass.diff).toContain("package-lock.json");
  });
});

/**
 * ADR-0021's surviving degenerate case, and the only one left after a gate input
 * the base never had stopped being deleted: a diff of nothing but *edits* to
 * gate inputs the base already had, with no licence. Every path is held, so the
 * tree the checks run on is the base commit — they pass on code that contains no
 * part of the change.
 *
 * This is the one test in this file that needs a real check to run, because the
 * whole claim is about a `passed` the runner refuses to record as one.
 */
describe("a diff whose every path is held", () => {
  it("records inconclusive, not the pass the checks reported", async () => {
    const suite = 'const test = require("node:test");\ntest("ok", () => {});\n';
    const workspace = tempWorkspace({
      "package.json": PACKAGE_JSON,
      "package-lock.json": EMPTY_LOCKFILE,
      "a.test.js": suite,
    });
    const h = harness({
      workspace,
      onRun: () => {
        writeFileSync(path.join(workspace, "a.test.js"), `${suite}test("also ok", () => {});\n`);
        return engineResult("added a case to the suite");
      },
    });

    const pass = (await runPass(h.ctx)) as ApprovedPass;

    expect(pass.gateInputs.held).toEqual(["a.test.js"]);
    expect(pass.gateInputs.treeIsBase).toBe(true);
    // The check itself passed — on the base. The recorded state is the runner's
    // composition, and it may not repeat a green that proved nothing.
    expect(pass.verify.summary).toContain("VERIFY PASSED");
    expect(pass.verify.state).toBe("inconclusive");
    // Said in words as well as in the field, because the judge reads the words.
    expect(pass.verify.summary).toContain("NOTHING OF THIS CHANGE WAS VERIFIED");
    // And the diff still ships: this is a claim about what proved it, never a
    // kill (ADR-0014's consequence, undisturbed).
    expect(pass.diff).toContain("a.test.js");
  });
});

/**
 * ADR-0014 at the pass, on the case a path list read off the diff would miss.
 * Git reports a rename as one entry at its destination, so a suite *moved* out
 * of the tree looks like a file that only ever existed at the new path — and
 * seeing only that path would leave the deletion standing, verifying a tree with
 * no suite in it at all.
 */
describe("a gate input the diff renamed away", () => {
  it("is held at the path the base knew it by, and the new path runs beside it", async () => {
    const workspace = tempWorkspace({ "a.test.js": "assert(true);\n" });
    const h = harness({
      workspace,
      onRun: () => {
        rmSync(path.join(workspace, "a.test.js"));
        writeFileSync(path.join(workspace, "b.test.js"), "assert(true);\n");
        return engineResult("moved the suite");
      },
    });

    const pass = (await runPass(h.ctx)) as ApprovedPass;

    // The two sides of a move are two different facts (ADR-0021). The source is
    // a gate the base had and this diff took away, so it is held and restored.
    // The destination is a gate the change brought, so it runs.
    expect(pass.gateInputs.held).toEqual(["a.test.js"]);
    expect(pass.gateInputs.introduced).toEqual(["b.test.js"]);
    // The suite the agent inherited survives the move, at its own path — which
    // is the property the hold exists for, and the one a deletion would break.
    const tree = `${workspace}.verify`;
    expect(readFileSync(path.join(tree, "a.test.js"), "utf8")).toBe("assert(true);\n");
    expect(readFileSync(path.join(tree, "b.test.js"), "utf8")).toBe("assert(true);\n");
    // Part of the diff was still held, so this run proved less than all of it
    // and may not claim otherwise — but the tree is not the base.
    expect(pass.gateInputs.treeIsBase).toBe(false);
    // And the move itself still ships — this is a claim about the tree, never
    // about the diff.
    expect(pass.diff).toContain("b.test.js");
  });
});

/**
 * ADR-0013's rule, at the pass: **verify the thing you are going to ship.** The
 * check below fails in the presence of a file the agent left outside the index —
 * an untracked, ignored gate input, which is tier 3 of the audit. It cannot
 * reach a tree built from git objects, so the run goes green on the diff alone.
 */
describe("verification runs on the reconstituted tree, not the agent's workspace", () => {
  it("does not let a file the agent kept out of the index reach a check", async () => {
    const workspace = tempWorkspace({
      ".gitignore": "scratch/\n",
      "package.json": JSON.stringify({ name: "target", scripts: { test: "node check.js" } }),
      "package-lock.json": EMPTY_LOCKFILE,
      // Stands in for every gate input that executes out of the workspace: if
      // the check can see the agent's scratch directory, it is running in the
      // wrong tree.
      "check.js": "if (require('node:fs').existsSync('scratch')) { console.error('verified the workspace'); process.exit(1); }\n",
    });
    const h = harness({
      workspace,
      onRun: () => {
        writeFileSync(path.join(workspace, "shipped.ts"), "export const a = 1;\n");
        mkdirSync(path.join(workspace, "scratch"), { recursive: true });
        writeFileSync(path.join(workspace, "scratch", "notes.md"), "working files\n");
        return engineResult("made the change");
      },
    });

    const pass = (await runPass(h.ctx)) as ApprovedPass;

    expect(pass.outcome).toBe("approved");
    expect(pass.verify.state).toBe("passed");
    expect(pass.diff).toContain("shipped.ts");
    expect(pass.diff).not.toContain("scratch");
  });
});
