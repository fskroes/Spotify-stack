import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, buildRepoMap, renderMap } from "../src/index.js";

function committedRepo(source = "export const value = 1;\n"): string {
  const repo = mkdtempSync(path.join(tmpdir(), "knowledge-map-"));
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "source.ts"), source);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Knowledge Test");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return repo;
}

function missingSourceRepo(): string {
  const repo = committedRepo();
  for (const file of ["z.ts", "a.ts"]) writeFileSync(path.join(repo, "src", file), "export const value = 1;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("add", "-A");
  git("commit", "-qm", "more fixtures");
  rmSync(path.join(repo, "src", "a.ts"));
  rmSync(path.join(repo, "src", "z.ts"));
  return repo;
}

describe("map skipped-file visibility", () => {
  it("reports supported tracked files that cannot be read in stable path order", async () => {
    const repo = missingSourceRepo();
    const index = await buildIndex(repo);
    const map = await buildRepoMap(repo);

    expect(index.filesSkipped).toEqual([
      { file: "src/a.ts", reason: "unreadable" },
      { file: "src/z.ts", reason: "unreadable" },
    ]);
    expect(renderMap(map)).toContain("# - src/a.ts (unreadable)");
    expect(renderMap(map)).toContain("# - src/z.ts (unreadable)");
  });

  it("marks a map built from changed tracked source as dirty", async () => {
    const repo = committedRepo("export function oldValue() { return 1; }\n");
    writeFileSync(path.join(repo, "src", "source.ts"), "export function newValue() { return 2; }\n");

    const index = await buildIndex(repo);
    const map = await buildRepoMap(repo);

    expect(index.dirty).toBe(true);
    expect(index.symbols.map((symbol) => symbol.name)).toContain("newValue");
    expect(map.dirty).toBe(true);
    expect(renderMap(map)).toContain("working tree changes");
  });
});
