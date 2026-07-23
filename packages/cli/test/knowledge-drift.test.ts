import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const cli = path.join(projectRoot, "packages", "cli", "src", "index.ts");
const tsx = path.join(projectRoot, "node_modules", ".bin", "tsx");

function git(repoDir: string, args: string[]) {
  execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
}

function runCli(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.GH_OWNER;
  return spawnSync(tsx, [cli, ...args], { cwd, encoding: "utf8", env });
}

function createDriftFixture() {
  const controlRepo = mkdtempSync(path.join(tmpdir(), "fleet-knowledge-drift-"));
  const targetRepo = path.join(controlRepo, "target");
  mkdirSync(path.join(targetRepo, "src"), { recursive: true });
  writeFileSync(path.join(targetRepo, "src", "current.ts"), "export function currentThing() {}\n");
  git(targetRepo, ["init", "-q"]);
  git(targetRepo, ["config", "user.email", "test@example.com"]);
  git(targetRepo, ["config", "user.name", "Test"]);
  git(targetRepo, ["add", "."]);
  git(targetRepo, ["commit", "-qm", "initial"]);

  mkdirSync(path.join(controlRepo, "fleet"));
  writeFileSync(
    path.join(controlRepo, "fleet", "repos.yaml"),
    `repos:\n  - name: drift-target\n    url: https://example.invalid/drift-target\n    language: typescript\n    default_branch: main\n    local_path: ${targetRepo}\n`,
  );
  mkdirSync(path.join(controlRepo, "knowledge"));
  writeFileSync(
    path.join(controlRepo, "knowledge", "drift-target.md"),
    "---\nsha: compiled-sha\ngrounding_ratio: 1\n---\n\nThe old implementation lives in `src/old.ts` beside `oldThing`.\n",
  );

  return controlRepo;
}

describe("fleet knowledge drift", () => {
  it("finds private artifacts through the local-overlay resolver", () => {
    const controlRepo = createDriftFixture();
    const publicRegistry = readFileSync(path.join(controlRepo, "fleet", "repos.yaml"), "utf8");
    writeFileSync(path.join(controlRepo, "fleet", "repos.yaml"), "repos:\n");
    writeFileSync(path.join(controlRepo, "fleet", "repos.local.yaml"), publicRegistry);
    mkdirSync(path.join(controlRepo, "knowledge", "private"));
    writeFileSync(
      path.join(controlRepo, "knowledge", "private", "drift-target.md"),
      readFileSync(path.join(controlRepo, "knowledge", "drift-target.md"), "utf8"),
    );
    rmSync(path.join(controlRepo, "knowledge", "drift-target.md"));

    const result = runCli(controlRepo, ["knowledge", "drift", "drift-target"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("# Knowledge drift — drift-target @");
  });

  it("checks stored prose locally and reports when its relative baseline requires recompilation", () => {
    const result = runCli(createDriftFixture(), ["knowledge", "drift", "drift-target"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# Knowledge drift — drift-target @");
    expect(result.stdout).toContain("structural-reference coverage");
    expect(result.stdout).toContain("not behavioral verification");
    expect(result.stdout).toContain("baseline: 1.000");
    expect(result.stdout).toContain("current:  0.000");
    expect(result.stdout).toContain("drift:    recompile required");
    expect(result.stdout).toContain("- file: src/old.ts");
    expect(result.stdout).toContain("- symbol: oldThing");
  });
});
