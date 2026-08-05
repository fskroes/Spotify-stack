/**
 * `fleet draft` is the only path that authors a task. A bare id therefore
 * resolves only where drafted (tasks/drafts) and already-shipped private
 * (tasks/private) tasks live. Fixture directories — tasks/examples,
 * tasks/onramp — are teaching material, reachable by explicit path only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveTaskPath } from "../src/resolve-task.js";

const controlRepo = mkdtempSync(path.join(tmpdir(), "fleet-resolve-"));
afterAll(() => rmSync(controlRepo, { recursive: true, force: true }));

function putTask(dir: string, id: string): string {
  const abs = path.join(controlRepo, dir);
  mkdirSync(abs, { recursive: true });
  const file = path.join(abs, `${id}.md`);
  writeFileSync(file, "---\nid: x\n---\n");
  return file;
}

describe("resolveTaskPath", () => {
  it("resolves a bare id from tasks/drafts", () => {
    const file = putTask("tasks/drafts", "tighten-retry-loop");
    expect(resolveTaskPath(controlRepo, "tighten-retry-loop")).toBe(file);
  });

  it("resolves an explicit path anywhere, fixture directories included", () => {
    const file = putTask("tasks/examples", "002-swift-migrate-formatter");
    expect(resolveTaskPath(controlRepo, file)).toBe(file);
  });

  it("resolves a bare id from tasks/private, shadowed by a fresh draft of the same id", () => {
    const priv = putTask("tasks/private", "rotate-api-token");
    expect(resolveTaskPath(controlRepo, "rotate-api-token")).toBe(priv);
    const draft = putTask("tasks/drafts", "rotate-api-token");
    expect(resolveTaskPath(controlRepo, "rotate-api-token")).toBe(draft);
  });

  it("refuses a bare id that only exists in a fixture directory", () => {
    putTask("tasks/examples", "001-ts-migrate-http-client");
    expect(() => resolveTaskPath(controlRepo, "001-ts-migrate-http-client")).toThrow(/task not found/);
  });
});
