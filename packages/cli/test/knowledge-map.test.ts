import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const cli = path.join(projectRoot, "packages", "cli", "src", "index.ts");
const tsx = path.join(projectRoot, "node_modules", ".bin", "tsx");

function runCli(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.GH_OWNER;
  return spawnSync(tsx, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

describe("fleet knowledge map", () => {
  it("renders a registry target locally without GH_OWNER or remote activity", () => {
    const result = runCli(process.cwd(), ["knowledge", "map", "demo-ts-service", "--budget", "1"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# Repo map — demo-ts-service @");
    expect(result.stdout).toContain("budget 1");
  });

  it("names the target and resolved path when no local source exists", () => {
    const controlRepo = mkdtempSync(path.join(tmpdir(), "fleet-cli-"));
    mkdirSync(path.join(controlRepo, "fleet"));
    writeFileSync(
      path.join(controlRepo, "fleet", "repos.yaml"),
      "repos:\n  - name: missing-local\n    url: https://example.invalid/missing-local\n    language: typescript\n    default_branch: main\n",
    );

    const result = runCli(controlRepo, ["knowledge", "map", "missing-local"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('target "missing-local" has no local source');
    expect(result.stderr).toContain(path.join(controlRepo, "demo-repos", "missing-local"));
    expect(result.stderr).toContain("local_path");
  });

  it("rejects a non-positive integer budget", () => {
    const result = runCli(process.cwd(), ["knowledge", "map", "demo-ts-service", "--budget", "0"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--budget must be a positive integer");
  });
});
