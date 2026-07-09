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

describe("loadTask scope/risk/why", () => {
  it("defaults: no scope, risk low, why falls back to the title", () => {
    const task = loadTask(taskFile('id: t-1\ntitle: A title\ntargets: [demo-ts-service]'));
    expect(task.scope).toBeUndefined();
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
    ).toThrow(/non-empty list/);
  });
});
