import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRootedReader } from "../src/read.js";

/**
 * The root check, which is the reason this package exists.
 *
 * ADR-0011 rejected confining the judge by configuration — a working directory
 * is a default, not a fence, and the content best placed to argue the judge out
 * of staying put is the content it is about to read. This table is the fence.
 * It is one of the two invariants the ADR mandates be asserted rather than
 * assumed, and it is table-driven because the table *is* the value: each row is
 * an escape someone will otherwise reintroduce.
 */
let root: string;
let outside: string;
let sibling: string;

beforeEach(() => {
  // realpath first: on macOS `os.tmpdir()` is itself a symlink, so a root left
  // unresolved would make every contained path look like an escape.
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "judge-root-")));
  root = path.join(tmp, "ws");
  outside = path.join(tmp, "outside");
  // Shares the root's full path as a string prefix — the case `startsWith`
  // admits and `path.relative` refuses.
  sibling = `${root}-evil`;
  for (const dir of [root, outside, sibling]) mkdirSync(dir, { recursive: true });

  writeFileSync(path.join(outside, "secret.txt"), "the operator's private target");
  writeFileSync(path.join(sibling, "secret.txt"), "the operator's private target");
  mkdirSync(path.join(root, "nested"));
  writeFileSync(path.join(root, "nested", "file.txt"), "inside the workspace");
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
  symlinkSync(path.join(root, "nested", "file.txt"), path.join(root, "inside-link.txt"));
});

afterEach(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

describe("the root check refuses every path outside the workspace", () => {
  const refusals: Array<[label: string, requested: (ctx: { root: string; outside: string; sibling: string }) => string]> = [
    ["a parent traversal", () => "../outside/secret.txt"],
    ["a traversal that only escapes after normalisation", () => "nested/../../outside/secret.txt"],
    ["an absolute path outside the workspace", (c) => path.join(c.outside, "secret.txt")],
    // Absolute is refused even when it lands inside: the tool's contract is
    // workspace-relative, and accepting absolutes makes every other rule a
    // question about string handling.
    ["an absolute path inside the workspace", (c) => path.join(c.root, "nested", "file.txt")],
    ["a symlink inside the workspace pointing out of it", () => "escape.txt"],
    ["a sibling directory sharing the root's name as a prefix", (c) => `../${path.basename(c.sibling)}/secret.txt`],
    ["a null byte, which truncates the path below the check", () => "nested/file.txt\0.png"],
    ["the workspace root itself, which is not a file", () => "."],
  ];

  for (const [label, requested] of refusals) {
    it(`refuses ${label}`, async () => {
      const read = createRootedReader(root);

      const result = await read("read_file", { path: requested({ root, outside, sibling }) });

      expect(result.isError, `${label} was not refused`).toBe(true);
      expect(result.text).not.toContain("the operator's private target");
      // A refusal is prose the judge may quote into a rationale that reaches a
      // human at co-sign. It must not carry the host's directory layout there.
      expect(result.text).not.toContain(outside);
      expect(result.text).not.toContain(root);
    });
  }

  it("accepts a path that resolves inside the workspace", async () => {
    // Without this row the table would pass by refusing everything, which is a
    // cage that also happens to be a text-only judge.
    const read = createRootedReader(root);

    const result = await read("read_file", { path: "nested/file.txt" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("inside the workspace");
  });

  it("accepts a symlink inside the workspace that points inside it", async () => {
    const read = createRootedReader(root);

    const result = await read("read_file", { path: "inside-link.txt" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("inside the workspace");
  });

  it("refuses to build a reader on a workspace that does not exist", async () => {
    // A reader with no root would be a judge that reads nothing while being
    // recorded as one that could — the failure ADR-0011 ends.
    expect(() => createRootedReader(path.join(root, "gone"))).toThrow();
  });
});
