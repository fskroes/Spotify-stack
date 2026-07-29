import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRootedReader } from "../src/read.js";

let root: string;

beforeEach(() => {
  // realpath: on macOS `os.tmpdir()` is a symlink (/var → /private/var), and a
  // reader that resolves symlinks would otherwise see every path as an escape.
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "judge-read-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("read_file", () => {
  it("returns the text of a file inside the workspace", async () => {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "index.ts"), "export const answer = 42;\n");
    const read = createRootedReader(root);

    const result = await read("read_file", { path: "src/index.ts" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("export const answer = 42;");
  });

  it("reports a missing file without pretending it read one", async () => {
    const read = createRootedReader(root);

    const result = await read("read_file", { path: "nope.ts" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/nope\.ts/);
  });

  it("refuses a tool it does not have, naming the surface it does", async () => {
    const read = createRootedReader(root);

    const result = await read("write_file", { path: "src/index.ts" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("read_file");
  });
});
