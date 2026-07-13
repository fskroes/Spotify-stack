import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePatch } from "../src/diff-parser.js";

// Fixtures are real captured `git diff` output: two from fleet run artifacts
// (diff.patch as the runner records it), one generated with git to cover the
// rename/binary/no-newline markers the captured runs never produced.
function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

describe("parsePatch", () => {
  it("splits a multi-file patch into files with per-file and total counts", () => {
    const diff = parsePatch(fixture("multi-file-delete.patch"));

    expect(diff.files.map((file) => file.path)).toEqual([
      "src/legacy/httpClient.ts",
      "src/userService.ts",
    ]);
    expect(diff.files[0].status).toBe("deleted");
    expect(diff.files[0].additions).toBe(0);
    expect(diff.files[0].deletions).toBe(25);
    expect(diff.files[1].status).toBe("modified");
    expect(diff.files[1].additions).toBe(2);
    expect(diff.files[1].deletions).toBe(14);
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(39);
  });

  it("keeps hunk boundaries, headers, and line kinds", () => {
    const diff = parsePatch(fixture("multi-file-delete.patch"));
    const [deleted, modified] = diff.files;

    expect(deleted.hunks).toHaveLength(1);
    expect(deleted.hunks[0].header).toBe("@@ -1,25 +0,0 @@");
    expect(deleted.hunks[0].lines).toHaveLength(25);
    expect(deleted.hunks[0].lines.every((line) => line.kind === "del")).toBe(true);

    expect(modified.hunks).toHaveLength(2);
    expect(modified.hunks[1].header).toBe("@@ -13,17 +13,5 @@ export function getUser(");
    const kinds = modified.hunks[0].lines.map((line) => line.kind);
    expect(kinds).toEqual(["del", "add", "context", "context", "context"]);
    expect(modified.hunks[0].lines[1].text).toBe('import { fetchJson } from "./http.js";');
  });

  it("marks a brand-new file as added with only added lines", () => {
    const diff = parsePatch(fixture("new-file.patch"));

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].path).toBe("tests/feed.test.js");
    expect(diff.files[0].status).toBe("added");
    expect(diff.files[0].additions).toBe(61);
    expect(diff.files[0].deletions).toBe(0);
    expect(diff.files[0].hunks).toHaveLength(1);
    expect(diff.files[0].hunks[0].header).toBe("@@ -0,0 +1,61 @@");
  });

  it("handles binary markers, renames with edits, and pure renames", () => {
    const diff = parsePatch(fixture("rename-binary.patch"));
    const [binary, renamedEdit, pureRename] = diff.files;

    expect(binary.path).toBe("icons/sprite.bin");
    expect(binary.binary).toBe(true);
    expect(binary.hunks).toHaveLength(0);
    expect(binary.additions).toBe(0);
    expect(binary.deletions).toBe(0);

    expect(renamedEdit.status).toBe("renamed");
    expect(renamedEdit.oldPath).toBe("dates.js");
    expect(renamedEdit.path).toBe("src/lib/dates.js");
    expect(renamedEdit.additions).toBe(2);
    expect(renamedEdit.deletions).toBe(2);
    // the "\ No newline at end of file" marker is kept but never counted
    expect(renamedEdit.hunks[0].lines.at(-1)).toEqual({
      kind: "meta",
      text: "\\ No newline at end of file",
    });

    expect(pureRename.status).toBe("renamed");
    expect(pureRename.oldPath).toBe("version.js");
    expect(pureRename.path).toBe("src/version.js");
    expect(pureRename.hunks).toHaveLength(0);

    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(2);
  });

  it("returns no files for an empty patch", () => {
    const diff = parsePatch(fixture("empty.patch"));
    expect(diff).toEqual({ files: [], additions: 0, deletions: 0 });
  });
});
