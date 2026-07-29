import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JUDGE_READ_JOURNAL_SEPARATOR,
  createRootedReader,
  distinctReadPaths,
  judgeReadJournalPaths,
} from "../src/read.js";

/**
 * What the reader says it served (`docs/judge-cage-spec.md` §7.1).
 *
 * The paths on a verdict are the runner's account of what it handed over, not
 * the judge's account of what it opened — a judge asked to report its own reads
 * can invent them, and telling a grounded veto from a confident invention is
 * the whole reason to record paths at all. So the path comes back from the
 * reader, beside the text it served, and every transport takes it from there.
 *
 * The other claim these tests make is that a recorded path *cannot* be absolute
 * or reach above the workspace: it is derived from the resolved read, relative
 * to the root that read was proven to be inside, rather than copied from what
 * the judge typed. The rows below are the ways a caller could have written a
 * path that says more than it should.
 */
let tmp: string;
let root: string;
let outside: string;

beforeEach(() => {
  // realpath: on macOS `os.tmpdir()` is a symlink, and an unresolved root makes
  // every contained path look like an escape.
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "judge-served-")));
  root = path.join(tmp, "ws");
  outside = path.join(tmp, "outside");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, "src", "index.ts"), "export const answer = 42;\n");
  writeFileSync(path.join(root, "package.json"), '{"name":"target"}\n');
  writeFileSync(path.join(outside, "secret.txt"), "a private target's business\n");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("a served read reports the path it served", () => {
  it("hands back the workspace-relative path beside the text", async () => {
    const read = createRootedReader(root);

    const result = await read("read_file", { path: "src/index.ts" });

    expect(result.isError).toBe(false);
    expect(result.path).toBe("src/index.ts");
  });

  const rows: Array<[label: string, requested: string]> = [
    ["a path written the long way round", "src/../src/index.ts"],
    ["a path with a leading ./", "./src/index.ts"],
    ["a redundant separator", "src//index.ts"],
    // The one an unresolved path would record verbatim: a link inside the
    // workspace names one file, and the read lands on another.
    ["a symlink inside the workspace", "link.ts"],
  ];

  it.each(rows)("normalises %s to the file actually opened", async (_label, requested) => {
    symlinkSync(path.join(root, "src", "index.ts"), path.join(root, "link.ts"));
    const read = createRootedReader(root);

    const result = await read("read_file", { path: requested });

    expect(result.isError).toBe(false);
    // One file, one recorded path, whatever the judge typed to reach it: a
    // reviewer counting distinct paths is counting files, not spellings.
    expect(result.path).toBe("src/index.ts");
  });

  it("records nothing for a read it refused", async () => {
    const read = createRootedReader(root);

    for (const input of [{ path: "../outside/secret.txt" }, { path: path.join(outside, "secret.txt") }, { path: "nope.ts" }]) {
      const result = await read("read_file", input);
      expect(result.isError).toBe(true);
      // A refused read served no content, so there is nothing to account for —
      // and an absolute path the judge typed must not reach the record by way
      // of a refusal either.
      expect(result.path).toBeUndefined();
    }
  });

  it("records nothing for a search, which opens no file", async () => {
    const read = createRootedReader(root);

    const result = await read("find", { glob: "**/*.ts" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("src/index.ts");
    // `find` tells the judge a file exists; the read paths say which files it
    // then went and looked inside.
    expect(result.path).toBeUndefined();
  });

  it("survives a round trip through the journal, whatever the filename contains", async () => {
    // A POSIX filename may hold any byte but `/` and NUL — a newline included.
    // A newline-delimited journal turns this one directory into two records,
    // the second an *absolute* path that was never read, which would make
    // workspace-relativity a property of the file format rather than of the
    // containment check.
    const awkward = "a\nb";
    mkdirSync(path.join(root, awkward));
    writeFileSync(path.join(root, awkward, "c.ts"), "export const x = 1;\n");
    const journal = path.join(tmp, "reads");
    const read = createRootedReader(root);

    const result = await read("read_file", { path: `${awkward}/c.ts` });
    writeFileSync(journal, `${result.path}${JUDGE_READ_JOURNAL_SEPARATOR}`);

    expect(judgeReadJournalPaths(journal)).toEqual([`${awkward}/c.ts`]);
    // The record that a newline-delimited journal would have invented.
    expect(judgeReadJournalPaths(journal)).not.toContain("/c.ts");
  });

  it("says nothing at all when the journal cannot be read", async () => {
    // Absent, not empty. Empty is the claim that a judge held the read tools
    // and opened no file; a journal that vanished establishes neither, and
    // answering `[]` would put a claim on a verdict that never earned it.
    expect(judgeReadJournalPaths(path.join(tmp, "never-written"))).toBeUndefined();
    // Whereas a journal the server truncated and never appended to is that
    // claim, and reads back as one.
    const empty = path.join(tmp, "empty");
    writeFileSync(empty, "");
    expect(judgeReadJournalPaths(empty)).toEqual([]);
  });

  it("records a path per file, not per call", async () => {
    const read = createRootedReader(root);

    const served = [
      (await read("read_file", { path: "src/index.ts", limit: 1 })).path,
      (await read("read_file", { path: "src/index.ts", offset: 2 })).path,
      (await read("read_file", { path: "package.json" })).path,
    ];

    // Paging a large file is two calls on one file, and the reader's own
    // truncation notice invites exactly that. A reviewer weighs what the judge
    // opened, so the list is of files.
    expect(distinctReadPaths(served.filter((p): p is string => p !== undefined))).toEqual([
      "src/index.ts",
      "package.json",
    ]);
  });
});
