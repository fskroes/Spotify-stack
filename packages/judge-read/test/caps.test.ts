import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRootedReader } from "../src/read.js";

/**
 * The two caps. ADR-0007 kept transcripts out of the archive for being large
 * and outside the review contract; a read tool that can pull a 50 MB file into
 * a verdict prompt is the same problem arriving by a different door.
 *
 * Both caps announce themselves in the returned text. A silent truncation
 * would leave the judge reasoning about a file it believes it read in full —
 * a confident verdict about content it never saw.
 */
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "judge-caps-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** `count` lines of `text`, newline-terminated. */
function lines(count: number, text = "x"): string {
  return `${Array.from({ length: count }, (_, i) => `${text}${i + 1}`).join("\n")}\n`;
}

describe("the per-read size cap", () => {
  it("truncates a file past the cap and says so in the text it returns", async () => {
    // ~600 KiB, comfortably past the 256 KiB default.
    writeFileSync(path.join(root, "big.txt"), "y".repeat(1024).concat("\n").repeat(600));
    const read = createRootedReader(root);

    const result = await read("read_file", { path: "big.txt" });

    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.text)).toBeLessThan(300 * 1024);
    expect(result.text).toMatch(/truncated/i);
  });

  it("refuses a line too large to return rather than handing back a fragment of it", async () => {
    writeFileSync(path.join(root, "one-long-line.txt"), `${"z".repeat(500)}\n`);
    const read = createRootedReader(root, { maxBytes: 64 });

    const result = await read("read_file", { path: "one-long-line.txt" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/larger than a single read/);
  });

  it("refuses a file that is not text, rather than returning what UTF-8 made of it", async () => {
    // A utf8 decode substitutes U+FFFD instead of throwing, so without this the
    // judge would reason about mojibake it believes is the target's source.
    writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]));
    const read = createRootedReader(root);

    const result = await read("read_file", { path: "logo.png" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not UTF-8 text/);
  });

  it("leaves a small file whole and unannotated", async () => {
    writeFileSync(path.join(root, "small.txt"), lines(3));
    const read = createRootedReader(root);

    const result = await read("read_file", { path: "small.txt" });

    expect(result.text).toBe(lines(3).trimEnd());
    expect(result.text).not.toMatch(/truncated/i);
  });
});

describe("offset and limit", () => {
  it("returns the requested window of lines", async () => {
    writeFileSync(path.join(root, "many.txt"), lines(10));
    const read = createRootedReader(root);

    const result = await read("read_file", { path: "many.txt", offset: 4, limit: 2 });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("x4\nx5");
    expect(result.text).not.toContain("x3");
    expect(result.text).not.toContain("x6\n");
  });

  it("says more lines follow, so a window is not mistaken for the whole file", async () => {
    writeFileSync(path.join(root, "many.txt"), lines(10));
    const read = createRootedReader(root);

    const result = await read("read_file", { path: "many.txt", limit: 2 });

    expect(result.text).toMatch(/offset/i);
  });

  it("refuses an offset past the end of the file rather than returning nothing", async () => {
    writeFileSync(path.join(root, "many.txt"), lines(10));
    const read = createRootedReader(root);

    const result = await read("read_file", { path: "many.txt", offset: 99 });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/10 line/);
  });
});

describe("the per-invocation call cap", () => {
  it("refuses further reads once the budget is spent", async () => {
    // Bounds cost, and keeps the path list a human sees at co-sign legible.
    writeFileSync(path.join(root, "a.txt"), "a\n");
    const read = createRootedReader(root, { maxReads: 2 });

    expect((await read("read_file", { path: "a.txt" })).isError).toBe(false);
    expect((await read("read_file", { path: "a.txt" })).isError).toBe(false);
    const third = await read("read_file", { path: "a.txt" });

    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/2/);
  });

  it("spends the budget per reader, because a reader is one judge invocation", async () => {
    writeFileSync(path.join(root, "a.txt"), "a\n");
    const first = createRootedReader(root, { maxReads: 1 });
    await first("read_file", { path: "a.txt" });

    const second = createRootedReader(root, { maxReads: 1 });

    expect((await second("read_file", { path: "a.txt" })).isError).toBe(false);
  });

  it("charges a refused read against the budget too", async () => {
    // Otherwise a judge that only ever asks for paths outside the workspace
    // gets an unbounded number of attempts at finding one that lands.
    const read = createRootedReader(root, { maxReads: 1 });
    await read("read_file", { path: "../escape.txt" });

    const next = await read("read_file", { path: "a.txt" });

    expect(next.isError).toBe(true);
    expect(next.text).toMatch(/cap|budget|limit/i);
  });
});
