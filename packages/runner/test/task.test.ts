import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTask } from "../src/task.js";

function taskFile(frontmatter: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-task-"));
  const file = path.join(dir, "task.md");
  writeFileSync(file, `---\n${frontmatter}\n---\n\n## End state\n\nBody.\n`);
  return file;
}

describe("loadTask scope/gates/risk/why", () => {
  it("defaults: no scope, no gates, risk low, why falls back to the title", () => {
    const task = loadTask(taskFile('id: t-1\ntitle: A title\ntargets: [demo-ts-service]'));
    expect(task.scope).toBeUndefined();
    // Every task written before gates existed keeps working, untouched.
    expect(task.gates).toBeUndefined();
    expect(task.risk).toBe("low");
    expect(task.why).toBe("A title");
  });

  it("parses explicit scope, risk, and why", () => {
    const task = loadTask(
      taskFile(
        'id: t-2\ntitle: A title\ntargets: [demo-ts-service]\nscope: [test/**, "src/generated/**"]\nrisk: drudgery\nwhy: Because reviewers need one sentence.',
      ),
    );
    expect(task.scope).toEqual(["test/**", "src/generated/**"]);
    expect(task.risk).toBe("drudgery");
    expect(task.why).toBe("Because reviewers need one sentence.");
  });

  it("rejects an unknown risk", () => {
    expect(() =>
      loadTask(taskFile('id: t-3\ntitle: T\ntargets: [demo-ts-service]\nrisk: yolo')),
    ).toThrow(/risk must be one of/);
  });

  it("rejects an empty scope list", () => {
    expect(() =>
      loadTask(taskFile('id: t-4\ntitle: T\ntargets: [demo-ts-service]\nscope: []')),
    ).toThrow(/scope must be a non-empty list/);
  });

  it("parses gates as a flat list of check names", () => {
    const task = loadTask(
      taskFile('id: t-5\ntitle: T\ntargets: [demo-ts-service]\ngates: [test, tsc]'),
    );
    expect(task.gates).toEqual(["test", "tsc"]);
  });

  it("accepts a gate no verifier can produce — the vocabulary is open", () => {
    // The runnable set depends on repo shape and host, so it is not knowable at
    // load time. An unrunnable mandate must register as a hole on every run
    // rather than being unspeakable until someone builds the capability.
    const task = loadTask(
      taskFile('id: t-6\ntitle: T\ntargets: [demo-ts-service]\ngates: [live-contract-check]'),
    );
    expect(task.gates).toEqual(["live-contract-check"]);
  });

  it("parses amends as an ordered glob → reason mapping", () => {
    const task = loadTask(
      taskFile(
        'id: t-9\ntitle: T\ntargets: [demo-ts-service]\namends:\n  "test/http.test.ts": the asserted status code was wrong\n  "test/**": the suite moved with the API',
      ),
    );
    expect(task.amends).toEqual([
      { glob: "test/http.test.ts", reason: "the asserted status code was wrong" },
      { glob: "test/**", reason: "the suite moved with the API" },
    ]);
  });

  it("defaults to no amendment — the ordinary case, and every task written before this", () => {
    const task = loadTask(taskFile('id: t-10\ntitle: T\ntargets: [demo-ts-service]'));
    expect(task.amends).toBeUndefined();
  });

  // The reason is the one part of this licence a reflexive operator cannot
  // supply without thinking, which is the failure ADR-0014 cannot mechanically
  // prevent. A blank one is a load error naming the glob, not a licence with an
  // empty justification beside it.
  it("rejects an amendment with no reason, naming the glob", () => {
    for (const value of ['"test/**": ""', '"test/**": "   "', '"test/**": true']) {
      expect(() =>
        loadTask(taskFile(`id: t-11\ntitle: T\ntargets: [demo-ts-service]\namends:\n  ${value}`)),
      ).toThrow(/amends\["test\/\*\*"\] needs a non-empty reason/);
    }
  });

  // `amends: [test/**]` is exactly the bare glob this design refuses. Reading a
  // list as "reason omitted" would make the required half optional in practice.
  it("rejects a bare list of globs", () => {
    expect(() =>
      loadTask(taskFile('id: t-12\ntitle: T\ntargets: [demo-ts-service]\namends: ["test/**"]')),
    ).toThrow(/amends must be a mapping of path glob to the reason/);
    expect(() =>
      loadTask(taskFile('id: t-13\ntitle: T\ntargets: [demo-ts-service]\namends: {}')),
    ).toThrow(/amends must name at least one path glob/);
  });

  it("rejects a malformed gates value at load, naming the task file", () => {
    // Found at dispatch, not by a run that silently ignored the field.
    const file = taskFile('id: t-7\ntitle: T\ntargets: [demo-ts-service]\ngates: []');
    expect(() => loadTask(file)).toThrow(/gates must be a non-empty list/);
    expect(() => loadTask(file)).toThrow(new RegExp(file.replace(/[/\\]/g, "\\$&")));
    expect(() =>
      loadTask(taskFile('id: t-8\ntitle: T\ntargets: [demo-ts-service]\ngates: test')),
    ).toThrow(/gates must be a non-empty list/);
  });
});
