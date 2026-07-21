import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FleetRepo } from "./fleet.js";

const GIT_IDENTITY = [
  "-c",
  "user.email=fleet-agent@example.invalid",
  "-c",
  "user.name=Fleet Agent Runner",
];

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Prepare an isolated workspace for a run. Local mode copies the repo from
 * the repo's local_path (or demo-repos/<name> if unset) and creates a baseline
 * commit; remote mode shallow-clones.
 */
export function prepareWorkspace(opts: {
  controlRepo: string;
  repo: FleetRepo;
  taskId: string;
  local: boolean;
}): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const workspace = path.join(opts.controlRepo, ".tmp", "runs", `${opts.taskId}-${opts.repo.name}-${stamp}`);
  mkdirSync(workspace, { recursive: true });

  if (opts.local) {
    const source =
      opts.repo.local_path ?? path.join(opts.controlRepo, "demo-repos", opts.repo.name);
    if (!existsSync(source)) {
      throw new Error(`local repo not found: ${source}`);
    }
    cpSync(source, workspace, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        // .DS_Store excluded so sourcing from a live macOS working tree
        // (via local_path) doesn't leak it into the baseline/diff.
        return (
          base !== "node_modules" && base !== ".build" && base !== ".git" && base !== ".DS_Store"
        );
      },
    });
    // Reuse the source's installed deps so verify doesn't re-install per run.
    // The demo repo's .gitignore keeps this out of git.
    const sourceModules = path.join(source, "node_modules");
    if (existsSync(sourceModules) && !existsSync(path.join(workspace, "node_modules"))) {
      symlinkSync(sourceModules, path.join(workspace, "node_modules"), "dir");
    }
    git(workspace, ["init", "-b", "main"]);
    git(workspace, ["add", "-A"]);
    git(workspace, ["commit", "-m", "baseline", "--quiet"]);
  } else {
    git(path.dirname(workspace), [
      "clone",
      "--depth",
      "1",
      "--branch",
      opts.repo.default_branch,
      opts.repo.url,
      workspace,
    ]);
  }

  return workspace;
}

/**
 * Inject the constrained agent configuration into a workspace:
 * .claude/settings.json (allowlist + Stop hook), the Stop hook script, and
 * the MCP config pointing the `verify` server at this workspace.
 */
export function injectAgentConfig(opts: { controlRepo: string; workspace: string }): {
  mcpConfigPath: string;
} {
  const templateDir = path.join(opts.controlRepo, "agent-config");
  const claudeDir = path.join(opts.workspace, ".claude");
  mkdirSync(path.join(claudeDir, "hooks"), { recursive: true });

  const fill = (text: string) =>
    text
      .replaceAll("__CONTROL_REPO__", opts.controlRepo)
      .replaceAll("__WORKSPACE__", opts.workspace);

  writeFileSync(
    path.join(claudeDir, "settings.json"),
    fill(readFileSync(path.join(templateDir, "settings.json"), "utf8")),
  );
  writeFileSync(
    path.join(claudeDir, "hooks", "stop-verify.mjs"),
    fill(readFileSync(path.join(templateDir, "hooks", "stop-verify.mjs"), "utf8")),
  );
  const mcpConfigPath = path.join(claudeDir, "mcp-config.json");
  writeFileSync(mcpConfigPath, fill(readFileSync(path.join(templateDir, "mcp.json"), "utf8")));

  // Keep the injected config out of the diff/PR.
  writeFileSync(path.join(claudeDir, ".gitignore"), "*\n");

  return { mcpConfigPath };
}

/**
 * Stage everything and return the staged diff against the baseline.
 * `.claude/` is excluded: injectAgentConfig overwrites it, and the .gitignore
 * it drops there only hides *untracked* files — target repos that commit
 * their own .claude config would otherwise leak the harness config into the
 * PR. The exclusion also carries into the PR commit, which commits this index.
 */
export function stagedDiff(workspace: string): string {
  git(workspace, ["add", "-A", "--", "."]);
  // Do not name .claude in the add pathspec: Git rejects an explicitly named
  // ignored path, even when it is an exclusion. Reset keeps harness config out
  // of the staged diff for both ignored and tracked target configurations.
  git(workspace, ["reset", "-q", "--", ".claude"]);
  return git(workspace, ["diff", "--cached"]);
}

/** Paths (repo-relative) touched by the staged diff. Call after stagedDiff. */
export function stagedFiles(workspace: string): string[] {
  return git(workspace, ["diff", "--cached", "--name-only"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
