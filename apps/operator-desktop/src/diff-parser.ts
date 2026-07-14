/** Pure parser for `git diff` patch text (the runner's diff.patch artifact):
 *  patch in, per-file hunks and add/delete counts out. No DOM, no fetch. */

export interface DiffLine {
  kind: "add" | "del" | "context" | "meta";
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** New-side path; the old path for deletions. */
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  /** Old path, present only for renames. */
  oldPath?: string;
  /** True for "Binary files … differ" entries — no hunks to show. */
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
  additions: number;
  deletions: number;
}

function lineKind(line: string): DiffLine["kind"] {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("\\")) return "meta"; // "\ No newline at end of file"
  return "context";
}

export function parsePatch(patch: string): ParsedDiff {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  // A newline-terminated patch splits into a trailing "" that is not a line.
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();

  for (const line of lines) {
    const header = line.match(/^diff --git a\/.* b\/(.*)$/);
    if (header) {
      file = { path: header[1], status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
      hunk = null;
      files.push(file);
      continue;
    }
    if (!file) continue;

    if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      const kind = lineKind(line);
      if (kind === "add") file.additions += 1;
      if (kind === "del") file.deletions += 1;
      hunk.lines.push({ kind, text: kind === "meta" ? line : line.slice(1) });
      continue;
    }

    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ")) file.binary = true;
  }

  return {
    files,
    additions: files.reduce((sum, item) => sum + item.additions, 0),
    deletions: files.reduce((sum, item) => sum + item.deletions, 0),
  };
}
