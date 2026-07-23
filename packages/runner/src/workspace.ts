import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildIndex,
  buildRepoMapFromIndex,
  buildRunKnowledgeFile,
  checkKnowledgeDrift,
  parseKnowledgeArtifact,
  type KnowledgeDriftReport,
} from "@fleet/knowledge";
import { resolveLocalSource, type FleetRepo } from "./fleet.js";
import { knowledgeArtifactPath } from "./knowledge.js";

/**
 * The compiled-knowledge file injected into a run's workspace. Named as a
 * dotfile at the repo root so it reads as harness scaffolding, and kept out of
 * the reviewable diff (see stagedDiff) exactly as `.claude/` is.
 */
export const RUN_KNOWLEDGE_FILE = ".fleet-knowledge.md";

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
    const source = resolveLocalSource(opts.repo, opts.controlRepo);
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

export interface InjectKnowledgeResult {
  /** False when no compiled artifact exists for the target — the run proceeds
   *  cold; knowledge is an enhancement, never a precondition. */
  injected: boolean;
  /** Repo-relative path of the written file, present only when injected. */
  relPath?: string;
  /** The written body, so the caller can archive it as run evidence. */
  content?: string;
  /** Commit the injected prose was compiled at (its stamped SHA). */
  artifactSha?: string;
  /** Drift of the stored prose against the workspace tree at injection time. */
  drift?: KnowledgeDriftReport;
}

/**
 * Inject the target's compiled knowledge into the workspace as
 * `.fleet-knowledge.md`, the secondary consumer of the #80 knowledge layer.
 *
 * When a compiled artifact exists, one fresh index built from the workspace
 * tree is used twice — for the structural map and for the drift check (the
 * Stage-4 `fleet ask` pattern) — then the file is written from
 * `buildRunKnowledgeFile`. This never spends: it renders the *existing* prose,
 * flagging staleness rather than recompiling (recompile is the CLI's opt-in
 * pre-step). Missing artifact → `{ injected: false }` and the run runs cold.
 */
export async function injectKnowledge(opts: {
  controlRepo: string;
  workspace: string;
  repo: FleetRepo;
}): Promise<InjectKnowledgeResult> {
  const artifactPath = knowledgeArtifactPath(opts.controlRepo, opts.repo.name, opts.repo.visibility);
  if (!existsSync(artifactPath)) return { injected: false };

  const artifact = parseKnowledgeArtifact(readFileSync(artifactPath, "utf8"));
  const index = await buildIndex(opts.workspace);
  // The index is built from the throwaway workspace, so buildIndex names it after
  // that timestamped dir. Relabel with the target's real name before rendering,
  // so neither the file title nor the map header leaks run-dir naming to the agent.
  index.repo = opts.repo.name;
  const map = buildRepoMapFromIndex(index);
  const drift = checkKnowledgeDrift(artifact, index);
  const content = buildRunKnowledgeFile(map, artifact.prose, drift);

  writeFileSync(path.join(opts.workspace, RUN_KNOWLEDGE_FILE), content);
  return { injected: true, relPath: RUN_KNOWLEDGE_FILE, content, artifactSha: artifact.sha, drift };
}

/**
 * Stage everything and return the staged diff against the baseline.
 * `.claude/` and `.fleet-knowledge.md` are excluded: both are injected by the
 * harness (injectAgentConfig, injectKnowledge), and the .gitignore .claude
 * drops only hides *untracked* files — a target that commits its own .claude
 * config would otherwise leak the harness config into the PR. The knowledge
 * file is a root dotfile the target never commits, but the same reset keeps it
 * out of the diff regardless, so a scoped run never trips scope-violation on
 * it. The exclusions carry into the PR commit, which commits this index.
 */
export function stagedDiff(workspace: string): string {
  git(workspace, ["add", "-A", "--", "."]);
  // Do not name these in the add pathspec: Git rejects an explicitly named
  // ignored path, even when it is an exclusion. Reset keeps harness-injected
  // files out of the staged diff for both ignored and tracked configurations,
  // and out of stagedFiles, so scope enforcement never sees them.
  git(workspace, ["reset", "-q", "--", ".claude"]);
  git(workspace, ["reset", "-q", "--", RUN_KNOWLEDGE_FILE]);
  return git(workspace, ["diff", "--cached"]);
}

/** Paths (repo-relative) touched by the staged diff. Call after stagedDiff. */
export function stagedFiles(workspace: string): string[] {
  return git(workspace, ["diff", "--cached", "--name-only"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
