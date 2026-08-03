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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  type VetoedPass,
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

const taskFor = (scope?: string[]): Task => ({
  id: "unit-pass",
  title: "a pass under test",
  targets: ["demo"],
  scope,
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
  resumes: Array<{ sessionId: string; guidance: string }>;
}

function harness(opts: {
  workspace: string;
  task?: Task;
  /** What the agent does on the first pass. */
  onRun: () => EngineResult;
  /** What the agent does on every later pass. */
  onResume?: () => EngineResult;
  judgeOnce?: PassContext["judgeOnce"];
}): Harness {
  const task = opts.task ?? taskFor();
  const artifacts = new Map<string, string>();
  const stages: Array<[Stage, number | undefined]> = [];
  const logs: string[] = [];
  const timings: PassTimings = { agentMs: 0, verifyMs: 0, judgeMs: 0 };
  const resumes: Array<{ sessionId: string; guidance: string }> = [];

  const engine: Engine = {
    run: () => opts.onRun(),
    resume: (sessionId, guidance) => {
      resumes.push({ sessionId, guidance });
      if (!opts.onResume) throw new Error("fixture: resume not expected");
      return opts.onResume();
    },
  };

  const inflight: InflightHandle = {
    enter: (stage, pass) => stages.push([stage, pass]),
    clear: () => {},
  };

  const ctx: PassContext = {
    task,
    workspace: opts.workspace,
    engine,
    judgeOnce: opts.judgeOnce ?? (async () => judgement(APPROVE)),
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

  return { ctx, artifacts, stages, logs, timings, resumes };
}

/** Drive one pass to a veto, so a retry has something legal to be seeded with. */
async function vetoedFirstPass(h: Harness): Promise<VetoedPass> {
  const pass = await runPass(h.ctx);
  expect(pass.outcome).toBe("vetoed");
  return pass as VetoedPass;
}

describe("a pass classifies an empty diff on every pass, not only the first", () => {
  it("treats a reverted change as a failure to correct when the sentinel is absent", async () => {
    const workspace = tempWorkspace();
    const h = harness({
      workspace,
      onRun: () => {
        writeFileSync(path.join(workspace, "added.ts"), "export const a = 1;\n");
        return engineResult("made the change");
      },
      onResume: () => {
        // The agent gives up on the vetoed change and puts the workspace back.
        git(workspace, ["reset", "-q", "--hard", "HEAD"]);
        rmSync(path.join(workspace, "added.ts"), { force: true });
        return engineResult("I reverted it; the reviewer was right");
      },
      judgeOnce: async () => judgement(VETO),
    });

    const retry = await runPass(h.ctx, await vetoedFirstPass(h));

    expect(retry.outcome).toBe("ended");
    expect((retry as EndedPass).status).toBe("agent-failed");
    expect(retry.diff.trim()).toBe("");
  });

  it("treats it as a benign no-op when the agent declares the sentinel", async () => {
    const workspace = tempWorkspace();
    const h = harness({
      workspace,
      onRun: () => {
        writeFileSync(path.join(workspace, "added.ts"), "export const a = 1;\n");
        return engineResult("made the change");
      },
      onResume: () => {
        git(workspace, ["reset", "-q", "--hard", "HEAD"]);
        rmSync(path.join(workspace, "added.ts"), { force: true });
        // The sentinel must END the reply, exactly as the task template demands.
        return engineResult("On reflection nothing here needs changing.\nNO_CHANGES_NEEDED");
      },
      judgeOnce: async () => judgement(VETO),
    });

    const retry = await runPass(h.ctx, await vetoedFirstPass(h));

    expect((retry as EndedPass).status).toBe("no-changes");
  });
});

describe("a pass reports only what it observed", () => {
  it("carries no verification when it dies at scope, though an earlier pass verified", async () => {
    const workspace = tempWorkspace();
    const h = harness({
      workspace,
      task: taskFor(["src/**"]),
      onRun: () => {
        mkdirSync(path.join(workspace, "src"), { recursive: true });
        writeFileSync(path.join(workspace, "src", "in-scope.ts"), "export const a = 1;\n");
        return engineResult("in scope");
      },
      onResume: () => {
        writeFileSync(path.join(workspace, "OUT-OF-SCOPE.md"), "sneaky\n");
        return engineResult("out of scope");
      },
      judgeOnce: async () => judgement(VETO),
    });

    // The first pass verifies and is judged; the retry then breaks scope.
    const prior = await vetoedFirstPass(h);
    expect(prior.verify.state).toBe("inconclusive");

    const retry = (await runPass(h.ctx, prior)) as EndedPass;

    expect(retry.status).toBe("scope-violation");
    expect(retry.scopeOffenders).toContain("OUT-OF-SCOPE.md");
    // The earlier pass's verification examined a diff this pass replaced.
    // Carrying it here would attach one change's green to another's diff.
    expect(retry.verify).toBeUndefined();
    expect(retry.unmetGates).toBeUndefined();
  });

  it("records no verdict when its own judge failed, rather than the previous pass's", async () => {
    const workspace = tempWorkspace();
    let judged = 0;
    const h = harness({
      workspace,
      onRun: () => {
        writeFileSync(path.join(workspace, "first.ts"), "export const a = 1;\n");
        return engineResult("first change");
      },
      onResume: () => {
        writeFileSync(path.join(workspace, "second.ts"), "export const b = 2;\n");
        return engineResult("corrected");
      },
      judgeOnce: async () => {
        judged += 1;
        if (judged === 1) return judgement(VETO);
        throw new Error("judge transport died");
      },
    });

    const prior = await vetoedFirstPass(h);
    const retry = (await runPass(h.ctx, prior)) as EndedPass;

    expect(retry.status).toBe("engine-failed");
    expect(retry.resultText).toBe("judge transport died");
    // The previous pass's veto judged a different diff. Recording it here would
    // pair a verdict with a change its judge never saw.
    expect(retry.verdict).toBeUndefined();
    // This pass's own verification, though, is exactly what it observed.
    expect(retry.verify?.state).toBe("inconclusive");
    expect(retry.diff).toContain("second.ts");
  });

  it("keeps the prior pass's facts when the agent never reached the workspace", async () => {
    const workspace = tempWorkspace();
    const h = harness({
      workspace,
      onRun: () => {
        writeFileSync(path.join(workspace, "first.ts"), "export const a = 1;\n");
        return engineResult("first change");
      },
      onResume: () => {
        throw new Error("agent resume died");
      },
      judgeOnce: async () => judgement(VETO),
    });

    const prior = await vetoedFirstPass(h);
    const retry = (await runPass(h.ctx, prior)) as EndedPass;

    expect(retry.status).toBe("engine-failed");
    // The resume threw, so the vetoed change is still what is staged in the
    // workspace: diff, verification and verdict all still describe it, and
    // reporting nothing would call a dirty workspace clean.
    expect(retry.diff).toBe(prior.diff);
    expect(retry.verify).toBe(prior.verify);
    expect(retry.verdict).toBe(prior.judgeResult.verdict);
  });
});

describe("a retry is seeded by the veto that caused it", () => {
  it("resumes the same session, handing back the violations and the guidance", async () => {
    const workspace = tempWorkspace();
    const h = harness({
      workspace,
      onRun: () => {
        writeFileSync(path.join(workspace, "first.ts"), "export const a = 1;\n");
        return engineResult("first change", "session-xyz");
      },
      onResume: () => engineResult("corrected", "session-xyz"),
      judgeOnce: async () => judgement(VETO),
    });

    const prior = await vetoedFirstPass(h);
    expect(prior.ordinal).toBe(1);
    expect(prior.sessionId).toBe("session-xyz");

    await runPass(h.ctx, prior);

    expect(h.resumes).toHaveLength(1);
    expect(h.resumes[0].sessionId).toBe("session-xyz");
    expect(h.resumes[0].guidance).toContain("- fixture: first violation");
    expect(h.resumes[0].guidance).toContain("- fixture: second violation");
    expect(h.resumes[0].guidance).toContain("fixture guidance: narrow the change");
  });

  it("numbers its passes, and re-enters the agent stage on every one", async () => {
    const workspace = tempWorkspace();
    let written = 0;
    const h = harness({
      workspace,
      onRun: () => {
        writeFileSync(path.join(workspace, `f${++written}.ts`), "export const a = 1;\n");
        return engineResult("change");
      },
      onResume: () => {
        writeFileSync(path.join(workspace, `f${++written}.ts`), "export const b = 2;\n");
        return engineResult("change");
      },
      judgeOnce: async () => judgement(VETO),
    });

    const second = (await runPass(h.ctx, await vetoedFirstPass(h))) as VetoedPass;

    expect(second.ordinal).toBe(2);
    // The agent stage is re-entered on the first pass too, so `stageSince`
    // marks the real start of the agent call rather than the start of the run.
    expect(h.stages.filter(([stage]) => stage === "agent")).toEqual([
      ["agent", 1],
      ["agent", 2],
    ]);
  });

  it("only a veto can seed another pass", () => {
    // Compile-time, which is the point: the guarantee is the type, not a rule
    // someone has to remember. If either directive stops being needed, tsc
    // fails on the unused @ts-expect-error and this test has to be revisited.
    const approved = {} as ApprovedPass;
    const ended = {} as EndedPass;
    // @ts-expect-error — an approved pass carries no session, so it cannot seed a retry
    void ((ctx: PassContext) => runPass(ctx, approved));
    // @ts-expect-error — a pass that reached a fate of its own is not retried
    void ((ctx: PassContext) => runPass(ctx, ended));
    expect(VETO.verdict).toBe("veto");
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
