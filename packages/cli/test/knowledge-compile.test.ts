import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseKnowledgeArtifact } from "@fleet/knowledge";
import { knowledgeArtifactPath } from "@fleet/runner/knowledge";

const projectRoot = process.cwd();
const cli = path.join(projectRoot, "packages", "cli", "src", "index.ts");
const tsx = path.join(projectRoot, "node_modules", ".bin", "tsx");

const PROSE = `## Product

The target exposes \`serve\` from src/service.ts.

## Architecture

A single service module contains the implementation.

## Key seams

\`serve\` is the public entry point.

## Principal data flows

Requests reach \`serve\`.

## Conventions

Source code lives in src/service.ts.

## Feature landing zones

Add service behavior in src/service.ts.

## Verify gate

Run the repository test suite.

## Unknowns

The structural map does not expose runtime integrations.
`;

function git(repoDir: string, args: string[]) {
  execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
}

function writeFakeClaude(binDir: string): string {
  const argsPath = path.join(binDir, "claude-args.json");
  const executable = path.join(binDir, "claude");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
console.log("SessionStart hook noise");
console.log(JSON.stringify({ type: "result", result: ${JSON.stringify(PROSE)} }));
`,
  );
  chmodSync(executable, 0o755);
  return argsPath;
}

function createCompileFixture(visibility: "public" | "private" = "public") {
  const controlRepo = mkdtempSync(path.join(tmpdir(), "fleet-knowledge-compile-"));
  const targetRepo = path.join(controlRepo, "target");
  mkdirSync(path.join(targetRepo, "src"), { recursive: true });
  writeFileSync(path.join(targetRepo, "src", "service.ts"), "export function serve() {}\n");
  git(targetRepo, ["init", "-q"]);
  git(targetRepo, ["config", "user.email", "test@example.com"]);
  git(targetRepo, ["config", "user.name", "Test"]);
  git(targetRepo, ["add", "."]);
  git(targetRepo, ["commit", "-qm", "initial"]);

  mkdirSync(path.join(controlRepo, "fleet"));
  const repo = `  - name: compile-target\n    url: https://example.invalid/compile-target\n    language: typescript\n    default_branch: main\n    local_path: ${targetRepo}\n`;
  writeFileSync(path.join(controlRepo, "fleet", "repos.yaml"), `repos:\n${visibility === "public" ? repo : ""}`);
  if (visibility === "private") writeFileSync(path.join(controlRepo, "fleet", "repos.local.yaml"), `repos:\n${repo}`);

  const binDir = path.join(controlRepo, "bin");
  mkdirSync(binDir);
  const argsPath = writeFakeClaude(binDir);
  return { argsPath, binDir, controlRepo, targetRepo };
}

function runCli(cwd: string, binDir: string, argsPath: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_CLAUDE_ARGS: argsPath };
  delete env.GH_OWNER;
  return spawnSync(tsx, [cli, ...args], { cwd, encoding: "utf8", env });
}

describe("fleet knowledge compile", () => {
  it("compiles and stamps a public artifact using the local Claude CLI", () => {
    const fixture = createCompileFixture();
    const result = runCli(fixture.controlRepo, fixture.binDir, fixture.argsPath, ["knowledge", "compile", "compile-target"]);
    const artifactPath = path.join(fixture.controlRepo, "knowledge", "compile-target.md");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("knowledge compiled: compile-target → knowledge/compile-target.md");
    expect(existsSync(artifactPath)).toBe(true);
    expect(parseKnowledgeArtifact(readFileSync(artifactPath, "utf8")).prose).toBe(PROSE);

    const invocation = JSON.parse(readFileSync(fixture.argsPath, "utf8")) as { cwd: string; args: string[] };
    expect(invocation.cwd).toBe(realpathSync(fixture.targetRepo));
    expect(invocation.args).toContain("--permission-mode");
    expect(invocation.args).toContain("plan");
    expect(invocation.args.join("\n")).toContain("# Repo map — target @");
  });

  it("sanitizes model wrapper prose and reports structural grounding on compile", () => {
    const fixture = createCompileFixture();
    const wrapped = `Sure — here is the knowledge artifact.\n\n${PROSE.trimEnd()}\n\nLet me know if you want it written to a file.`;
    writeFileSync(
      path.join(fixture.binDir, "claude"),
      `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "result", result: ${JSON.stringify(wrapped)} }));\n`,
    );
    chmodSync(path.join(fixture.binDir, "claude"), 0o755);

    const result = runCli(fixture.controlRepo, fixture.binDir, fixture.argsPath, ["knowledge", "compile", "compile-target"]);
    const stored = readFileSync(path.join(fixture.controlRepo, "knowledge", "compile-target.md"), "utf8");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("structural grounding:");
    expect(result.stdout).toContain("behavioral prose is not verified by this ratio");
    // The stored artifact holds only the ordered sections and the labeled envelope.
    expect(stored).toContain("grounding_basis: structural-references");
    expect(stored).not.toContain("here is the knowledge artifact");
    expect(stored).not.toContain("Let me know if you want");
    expect(parseKnowledgeArtifact(stored).prose).toBe(PROSE);
  });

  it("stores local-overlay targets privately and never creates a public copy", () => {
    const fixture = createCompileFixture("private");
    const result = runCli(fixture.controlRepo, fixture.binDir, fixture.argsPath, ["knowledge", "compile", "compile-target"]);

    expect(result.status).toBe(0);
    expect(existsSync(path.join(fixture.controlRepo, "knowledge", "private", "compile-target.md"))).toBe(true);
    expect(existsSync(path.join(fixture.controlRepo, "knowledge", "compile-target.md"))).toBe(false);
  });

  it("leaves no artifact when generated prose violates the section contract", () => {
    const fixture = createCompileFixture();
    writeFileSync(
      path.join(fixture.binDir, "claude"),
      `#!/usr/bin/env node\nconsole.log(JSON.stringify({ result: "## Product\\n" }));\n`,
    );
    chmodSync(path.join(fixture.binDir, "claude"), 0o755);

    const result = runCli(fixture.controlRepo, fixture.binDir, fixture.argsPath, ["knowledge", "compile", "compile-target"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("knowledge prose must contain these headings");
    expect(existsSync(path.join(fixture.controlRepo, "knowledge", "compile-target.md"))).toBe(false);
  });

  it("uses the existing missing-local-source diagnostic", () => {
    const controlRepo = mkdtempSync(path.join(tmpdir(), "fleet-knowledge-missing-"));
    mkdirSync(path.join(controlRepo, "fleet"));
    writeFileSync(
      path.join(controlRepo, "fleet", "repos.yaml"),
      "repos:\n  - name: missing-local\n    url: https://example.invalid/missing-local\n    language: typescript\n    default_branch: main\n",
    );
    const result = spawnSync(tsx, [cli, "knowledge", "compile", "missing-local"], { cwd: controlRepo, encoding: "utf8", env: process.env });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('target "missing-local" has no local source');
  });

  it("rejects path-like target names before choosing either artifact location", () => {
    expect(() => knowledgeArtifactPath("/control", "../published", "private")).toThrow(/one path component/);
    expect(() => knowledgeArtifactPath("/control", "nested/target", "public")).toThrow(/one path component/);
    expect(() => knowledgeArtifactPath("/control", "nested\\target", "private")).toThrow(/one path component/);
  });

  it("ignores private artifacts while leaving public artifacts trackable", () => {
    expect(spawnSync("git", ["check-ignore", "-q", "knowledge/private/compile-target.md"], { cwd: projectRoot }).status).toBe(0);
    expect(spawnSync("git", ["check-ignore", "-q", "knowledge/compile-target.md"], { cwd: projectRoot }).status).toBe(1);
  });
});
