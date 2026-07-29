import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRootedReader } from "../src/read.js";

/**
 * `find` is why the cage is not also a blindfold.
 *
 * ADR-0011 rejected restricting the judge to paths named in the task or diff:
 * that reimposes text-only blindness one layer down, and the false green the
 * ADR was built on required *finding* a file the diff never mentions. A
 * read-by-path-only surface arrives at the same place by a different route.
 */
let root: string;
let outside: string;

beforeEach(() => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "judge-find-")));
  root = path.join(tmp, "ws");
  outside = path.join(tmp, "outside");
  mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  mkdirSync(path.join(root, ".git"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(path.join(root, "build.json"), "{}");
  writeFileSync(path.join(root, "src", "index.ts"), "");
  writeFileSync(path.join(root, "src", "nested", "deep.ts"), "");
  writeFileSync(path.join(root, "src", "notes.md"), "");
  writeFileSync(path.join(root, "node_modules", "dep", "index.ts"), "");
  writeFileSync(path.join(root, ".git", "config.ts"), "");
  writeFileSync(path.join(outside, "secret.ts"), "");
});

afterEach(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

const paths = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("["));

describe("find", () => {
  it("matches at any depth, and answers in workspace-relative paths", async () => {
    const read = createRootedReader(root);

    const result = await read("find", { glob: "**/*.ts" });

    expect(result.isError).toBe(false);
    expect(paths(result.text)).toEqual(["src/index.ts", "src/nested/deep.ts"]);
  });

  it("keeps a single star inside one path segment", async () => {
    const read = createRootedReader(root);

    const result = await read("find", { glob: "src/*.ts" });

    expect(paths(result.text)).toEqual(["src/index.ts"]);
  });

  it("matches a file at the workspace root", async () => {
    const read = createRootedReader(root);

    expect(paths((await read("find", { glob: "*.json" })).text)).toEqual(["build.json"]);
  });

  it("says plainly when nothing matched, rather than failing", async () => {
    // No match is an answer — and a useful one, since the diff may be claiming
    // a file exists that does not.
    const read = createRootedReader(root);

    const result = await read("find", { glob: "**/*.swift" });

    expect(result.isError).toBe(false);
    expect(paths(result.text)).toEqual([]);
    expect(result.text).toMatch(/no /i);
  });

  it("never reaches outside the workspace, whatever the pattern says", async () => {
    const read = createRootedReader(root);

    for (const glob of ["../outside/*.ts", `${outside}/*.ts`, "**/../../outside/*.ts"]) {
      const result = await read("find", { glob });

      expect(result.isError, `${glob} was not refused`).toBe(true);
      expect(result.text).not.toContain("secret.ts");
      expect(result.text).not.toContain(outside);
    }
  });

  it("does not walk into .git or node_modules, whatever the pattern asks for", async () => {
    // Unconditional, and stated in the tool's own description. Deciding this
    // from the pattern's raw text while matching decides from the compiled
    // expression is two answers to one question — the shape of divergence this
    // package exists to prevent.
    const read = createRootedReader(root);

    expect(paths((await read("find", { glob: "**/*.ts" })).text)).not.toContain("node_modules/dep/index.ts");
    expect(paths((await read("find", { glob: "node_modules/**/*.ts" })).text)).toEqual([]);
  });

  it("still reads a file inside a skipped directory when asked for it by name", async () => {
    // The skip narrows what a search lists, never what may be read: otherwise
    // it would be a second, undeclared fence.
    const read = createRootedReader(root);

    expect((await read("read_file", { path: "node_modules/dep/index.ts" })).isError).toBe(false);
  });

  it("does not follow a symlinked directory out of the workspace", async () => {
    // The walk is the second place a path could escape, and it is contained
    // structurally rather than by the root check — so it needs its own row.
    symlinkSync(outside, path.join(root, "src", "linked"));
    const read = createRootedReader(root);

    const result = await read("find", { glob: "**/*.ts" });

    expect(paths(result.text)).not.toContain("src/linked/secret.ts");
    expect(result.text).not.toContain("secret.ts");
  });

  it("caps the result list and says it capped it", async () => {
    // Two files match; the cap is one, so the second must be reported missing
    // rather than silently absent.
    const read = createRootedReader(root, { maxMatches: 1 });

    const result = await read("find", { glob: "**/*.ts" });

    expect(paths(result.text)).toHaveLength(1);
    expect(result.text).toMatch(/more|capped|truncated/i);
  });

  it("spends the same call budget a read does", async () => {
    // The budget bounds cost and keeps the recorded path list legible; a tool
    // that walks the whole workspace is not the one to leave uncounted.
    const read = createRootedReader(root, { maxReads: 1 });
    await read("find", { glob: "**/*.ts" });

    expect((await read("read_file", { path: "build.json" })).isError).toBe(true);
  });

  it("refuses a glob that is not a string", async () => {
    const read = createRootedReader(root);

    expect((await read("find", { glob: 42 })).isError).toBe(true);
  });

  it("lists a symlink inside the workspace, and read_file still refuses to follow it out", async () => {
    // find names paths; the root check decides what may be opened. Keeping
    // those two jobs separate means the escape is refused in exactly one place.
    symlinkSync(path.join(outside, "secret.ts"), path.join(root, "src", "escape.ts"));
    const read = createRootedReader(root);

    expect(paths((await read("find", { glob: "src/*.ts" })).text)).toContain("src/escape.ts");
    expect((await read("read_file", { path: "src/escape.ts" })).isError).toBe(true);
  });
});
