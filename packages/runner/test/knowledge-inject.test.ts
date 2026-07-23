/**
 * Unit tests for the run-time knowledge seam (#89, Stage 5): injectKnowledge
 * writes the target's compiled artifact into the workspace as an untracked root
 * dotfile that stagedDiff/stagedFiles must never surface — so a scoped run can't
 * trip scope-violation on it — and that survives a second staging pass (the
 * --resume analogue). No agent is invoked.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FleetRepo } from "../src/fleet.js";
import { injectKnowledge, prepareWorkspace, RUN_KNOWLEDGE_FILE, stagedDiff, stagedFiles } from "../src/workspace.js";

/** A control repo carrying a compiled artifact for `my-repo` at knowledge/my-repo.md. */
function controlRepoWithArtifact(): string {
  const controlRepo = mkdtempSync(path.join(os.tmpdir(), "fleet-control-"));
  mkdirSync(path.join(controlRepo, "knowledge"), { recursive: true });
  writeFileSync(
    path.join(controlRepo, "knowledge", "my-repo.md"),
    ["---", "sha: " + "b".repeat(40), "grounding_ratio: 1", "---", "", "The product exposes work from index.ts.", ""].join("\n"),
  );
  return controlRepo;
}

/** A source tree with one tracked file, so the workspace has a real index. */
function sourceRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-src-"));
  writeFileSync(path.join(dir, "index.ts"), "export function work() { return 1; }\n");
  return dir;
}

const repo = (local_path: string): FleetRepo => ({
  name: "my-repo",
  url: "https://example.invalid/my-repo",
  language: "typescript",
  default_branch: "main",
  visibility: "public",
  local_path,
});

describe("injectKnowledge", () => {
  it("writes the compiled artifact into the workspace and returns a handle", async () => {
    const controlRepo = controlRepoWithArtifact();
    const workspace = prepareWorkspace({ controlRepo, repo: repo(sourceRepo()), taskId: "t-inject", local: true });

    const result = await injectKnowledge({ controlRepo, workspace, repo: repo("unused") });

    expect(result.injected).toBe(true);
    expect(result.relPath).toBe(RUN_KNOWLEDGE_FILE);
    expect(result.artifactSha).toBe("b".repeat(40));
    // The file is really on disk, and it is the rendered body, not the raw artifact.
    const onDisk = readFileSync(path.join(workspace, RUN_KNOWLEDGE_FILE), "utf8");
    expect(onDisk).toBe(result.content);
    expect(onDisk).toContain("# Target knowledge — my-repo");
  });

  it("returns { injected: false } and writes nothing when no artifact exists", async () => {
    const controlRepo = mkdtempSync(path.join(os.tmpdir(), "fleet-control-empty-"));
    const workspace = prepareWorkspace({ controlRepo, repo: repo(sourceRepo()), taskId: "t-cold", local: true });

    const result = await injectKnowledge({ controlRepo, workspace, repo: repo("unused") });

    expect(result).toEqual({ injected: false });
    expect(existsSync(path.join(workspace, RUN_KNOWLEDGE_FILE))).toBe(false);
  });

  it("keeps the injected file out of the reviewable diff while staging a real edit", async () => {
    const controlRepo = controlRepoWithArtifact();
    const workspace = prepareWorkspace({ controlRepo, repo: repo(sourceRepo()), taskId: "t-scope", local: true });
    await injectKnowledge({ controlRepo, workspace, repo: repo("unused") });

    // The agent makes a normal source edit alongside the injected dotfile.
    writeFileSync(path.join(workspace, "index.ts"), "export function work() { return 2; }\n");

    const diff = stagedDiff(workspace);
    const files = stagedFiles(workspace);

    // The edit is reviewable; the injected knowledge file is not — so a scoped
    // run never sees it as an out-of-scope offender.
    expect(diff).toContain("return 2;");
    expect(diff).not.toContain(RUN_KNOWLEDGE_FILE);
    expect(files).toContain("index.ts");
    expect(files).not.toContain(RUN_KNOWLEDGE_FILE);
  });

  it("survives a second staging pass — the resume analogue leaves it in the workspace", async () => {
    const controlRepo = controlRepoWithArtifact();
    const workspace = prepareWorkspace({ controlRepo, repo: repo(sourceRepo()), taskId: "t-resume", local: true });
    await injectKnowledge({ controlRepo, workspace, repo: repo("unused") });

    stagedDiff(workspace);
    // A resume stages again; the file must still be present and still excluded.
    const files = stagedFiles(workspace);

    expect(existsSync(path.join(workspace, RUN_KNOWLEDGE_FILE))).toBe(true);
    expect(files).not.toContain(RUN_KNOWLEDGE_FILE);
  });
});
