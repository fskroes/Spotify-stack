import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareRunArtifactsDir, pruneRunArtifacts, runArtifactsDir } from "../src/artifacts.js";

function tmpArtifactsRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "fleet-artifacts-"));
}

/** Create a run archive dir with a deterministic mtime (older = smaller n). */
function seedRunDir(artifactsRoot: string, name: string, ageRank: number): string {
  const dir = path.join(artifactsRoot, "runs", name);
  mkdirSync(dir, { recursive: true });
  const t = new Date(Date.now() - ageRank * 60_000);
  utimesSync(dir, t, t);
  return dir;
}

describe("per-run artifact archive", () => {
  it("prunes the oldest archives past the keep limit, newest first", () => {
    const root = tmpArtifactsRoot();
    const ids = Array.from({ length: 5 }, () => randomUUID());
    // ageRank 0 is newest; keep=3 must drop the two oldest.
    const dirs = ids.map((id, rank) => seedRunDir(root, id, rank));

    pruneRunArtifacts(root, 3);

    expect(dirs.slice(0, 3).every((dir) => existsSync(dir))).toBe(true);
    expect(dirs.slice(3).some((dir) => existsSync(dir))).toBe(false);
  });

  it("never touches directories that are not UUID-named run archives", () => {
    const root = tmpArtifactsRoot();
    // A task literally named "runs" would put its flat repo dirs here.
    const impostor = seedRunDir(root, "demo-api", 99);
    writeFileSync(path.join(impostor, "diff.patch"), "not a run archive\n");
    const real = seedRunDir(root, randomUUID(), 98);

    pruneRunArtifacts(root, 0);

    expect(existsSync(impostor)).toBe(true);
    expect(existsSync(real)).toBe(false);
  });

  it("is best-effort: pruning a root with no archive dir is a no-op", () => {
    expect(() => pruneRunArtifacts(tmpArtifactsRoot())).not.toThrow();
  });

  it("prepare creates the archive dir and prunes in the same breath", () => {
    const root = tmpArtifactsRoot();
    const old = seedRunDir(root, randomUUID(), 5);
    const runId = randomUUID();

    const dir = prepareRunArtifactsDir(root, runId, 1);

    expect(dir).toBe(runArtifactsDir(root, runId));
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });
});
