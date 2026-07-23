import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const cli = path.join(projectRoot, "packages", "cli", "src", "index.ts");
const tsx = path.join(projectRoot, "node_modules", ".bin", "tsx");

const ANSWER = "'Mute this thread' lands in src/service.ts, alongside `serve`. It never touches src/ghost.ts.";

function git(repoDir: string, args: string[]) {
  execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
}

/**
 * A fake `claude` that records the prompt it was handed and answers with a
 * fixed envelope carrying model usage, so the ask report's token leg is exercised.
 */
function writeFakeClaude(binDir: string): string {
  const promptPath = path.join(binDir, "claude-prompt.txt");
  const executable = path.join(binDir, "claude");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const promptFlag = process.argv.indexOf("-p");
fs.writeFileSync(process.env.FAKE_CLAUDE_PROMPT, process.argv[promptFlag + 1]);
console.log("SessionStart hook noise");
console.log(JSON.stringify({
  type: "result",
  result: ${JSON.stringify(ANSWER)},
  modelUsage: { "claude-opus-4-8": { inputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 20, outputTokens: 12 } },
}));
`,
  );
  chmodSync(executable, 0o755);
  return promptPath;
}

function createAskFixture(prose: string) {
  const controlRepo = mkdtempSync(path.join(tmpdir(), "fleet-knowledge-ask-"));
  const targetRepo = path.join(controlRepo, "target");
  mkdirSync(path.join(targetRepo, "src"), { recursive: true });
  writeFileSync(path.join(targetRepo, "src", "service.ts"), "export function serve() {}\n");
  git(targetRepo, ["init", "-q"]);
  git(targetRepo, ["config", "user.email", "test@example.com"]);
  git(targetRepo, ["config", "user.name", "Test"]);
  git(targetRepo, ["add", "."]);
  git(targetRepo, ["commit", "-qm", "initial"]);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRepo, encoding: "utf8" }).trim();

  mkdirSync(path.join(controlRepo, "fleet"));
  writeFileSync(
    path.join(controlRepo, "fleet", "repos.yaml"),
    `repos:\n  - name: ask-target\n    url: https://example.invalid/ask-target\n    language: typescript\n    default_branch: main\n    local_path: ${targetRepo}\n`,
  );
  mkdirSync(path.join(controlRepo, "knowledge"));
  writeFileSync(path.join(controlRepo, "knowledge", "ask-target.md"), `---\nsha: ${sha}\ngrounding_ratio: 1\n---\n\n${prose}\n`);

  const binDir = path.join(controlRepo, "bin");
  mkdirSync(binDir);
  const promptPath = writeFakeClaude(binDir);
  return { binDir, controlRepo, promptPath };
}

function runCli(cwd: string, binDir: string, promptPath: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_CLAUDE_PROMPT: promptPath };
  delete env.GH_OWNER;
  return spawnSync(tsx, [cli, ...args], { cwd, encoding: "utf8", env });
}

describe("fleet ask", () => {
  it("answers a question and prints the drift and grounding report in §10 order", () => {
    const fixture = createAskFixture("The product exposes `serve` from src/service.ts.");
    const result = runCli(fixture.controlRepo, fixture.binDir, fixture.promptPath, ["ask", "ask-target", "where would 'mute this thread' land?"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    // The answer itself.
    expect(result.stdout).toContain("'Mute this thread' lands in src/service.ts");
    // Fresh prose is reassured, not warned.
    expect(result.stdout).toContain("prose fresh:");
    // Report order: wall clock, then dead-ends (the grounded leg), then tokens.
    const wall = result.stdout.indexOf("wall clock:");
    const dead = result.stdout.indexOf("dead-ends:");
    const tokens = result.stdout.indexOf("tokens:");
    expect(wall).toBeGreaterThan(-1);
    expect(dead).toBeGreaterThan(wall);
    expect(tokens).toBeGreaterThan(dead);
    // The answer named a file the current tree lacks — it is a dead-end.
    expect(result.stdout).toContain("- file: src/ghost.ts");
    expect(result.stdout).toContain("12 output");

    // The compiled prose and the question both reached the model prompt.
    const prompt = execFileSync("cat", [fixture.promptPath], { encoding: "utf8" });
    expect(prompt).toContain("## Question");
    expect(prompt).toContain("where would 'mute this thread' land?");
    expect(prompt).toContain("`serve` from src/service.ts");
    expect(prompt).toContain("# Repo map — target @");
  });

  it("answers from stale prose and flags drift instead of blocking", () => {
    const fixture = createAskFixture("The handler lives in `src/old.ts` beside `oldThing`.");
    const result = runCli(fixture.controlRepo, fixture.binDir, fixture.promptPath, ["ask", "ask-target", "how is it wired?"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("'Mute this thread' lands"); // still answered
    expect(result.stdout).toContain("DRIFT: stored prose");
    expect(result.stdout).toContain("→ run fleet knowledge compile ask-target");

    // The drift flags reached the model prompt so it could hedge the stale claims.
    const prompt = execFileSync("cat", [fixture.promptPath], { encoding: "utf8" });
    expect(prompt).toContain("has drifted");
    expect(prompt).toContain("- file: src/old.ts");
  });

  it("errors toward compile when no artifact exists", () => {
    const fixture = createAskFixture("The product exposes `serve` from src/service.ts.");
    execFileSync("rm", [path.join(fixture.controlRepo, "knowledge", "ask-target.md")]);

    const result = runCli(fixture.controlRepo, fixture.binDir, fixture.promptPath, ["ask", "ask-target", "where does mute land?"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("knowledge artifact not found");
    expect(result.stderr).toContain("fleet knowledge compile ask-target");
  });
});
