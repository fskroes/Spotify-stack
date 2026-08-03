import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { ensureDependencies } from "./install.js";
import { type VerifierCheck } from "./verifiers.js";
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
 * Materialise a source repository's `HEAD` tree into an empty directory
 * ([ADR-0018](../../../docs/adr/0018-the-local-workspace-is-a-checkout.md)).
 *
 * Two plumbing calls against a scratch index, so nothing but the object store is
 * consulted: no exclusion list to keep current, no working-tree state, and no
 * `.gitattributes` `export-ignore` quietly dropping a target's `test/` the way
 * `git archive` would.
 *
 * `--show-prefix` is what makes one path cover both target shapes. It is empty
 * when `local_path` is a repository root — a real target — and
 * `demo-repos/<name>/` when it is a tracked directory inside the control repo,
 * which is what every `demo-repos/*` target is and why cloning the source is not
 * an option for them.
 */
function materialiseHead(source: string, into: string): void {
  let toplevel: string;
  let prefix: string;
  try {
    // stderr piped: the failure below is reported as a fleet error, and git's
    // "not a git repository" would otherwise print over the top of it.
    const revParse = (flag: string) =>
      execFileSync("git", ["rev-parse", flag], {
        cwd: source,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    toplevel = revParse("--show-toplevel");
    prefix = revParse("--show-prefix").replace(/\/$/, "");
  } catch {
    throw new Error(
      `local repo is not inside a git repository: ${source}\n` +
        "A run's base is a commit (ADR-0018); local mode reads git objects, not a directory.",
    );
  }

  const indexFile = `${into}.index`;
  // From the toplevel, never from `source` itself. `checkout-index --prefix` run
  // in a subdirectory resolves against that subdirectory and writes nothing at
  // all — silently, exit 0 — which for a demo target would produce an empty
  // workspace and a baseline commit with nothing in it.
  const plumbing = (args: string[]) =>
    execFileSync("git", [...GIT_IDENTITY, ...args], {
      cwd: toplevel,
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
      maxBuffer: 64 * 1024 * 1024,
    });

  try {
    plumbing(["read-tree", `HEAD:${prefix}`]);
    plumbing(["checkout-index", "--all", `--prefix=${into}${path.sep}`]);
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/**
 * Prepare an isolated workspace for a run.
 *
 * **A run's base is what it will be judged against.** A run that opens a PR is
 * based on the upstream branch that PR targets, so it shallow-clones — whether
 * or not it is `--local`. A dry run has no upstream to answer to, so `--local`
 * checks the source out at its own `HEAD` (ADR-0018) and gets an operator's
 * committed work without a network round trip.
 *
 * That split is the whole of it, and it replaces a defect rather than guarding
 * one. Basing every local run on the source's `HEAD` while `openPr` re-parented
 * the result onto `FETCH_HEAD` gave a shipping run two bases: the tree it
 * verified and the tree it was diffed against. Where they disagreed the
 * difference shipped as an unauthored change — see the 2026-08-03 run that
 * deleted 163 lines of another run's tests under a header that said "1 file".
 * With one base there is nothing to compare, so no check has to be right.
 *
 * So `--local` has no meaning on a `--pr` run, and does not get one. Reusing the
 * source's `node_modules` there would resolve dependencies from the source's
 * lockfile and mount them over a tree built from upstream's — a base and a
 * dependency set from two different commits, with `ensureDependencies` skipping
 * the install that would settle it. That is the same false green arriving
 * through the base, one layer over.
 *
 * Either way the workspace leaves here with its dependencies present — see
 * ensureDependencies for why that is the runner's job and not a verifier's.
 */
export function prepareWorkspace(opts: {
  controlRepo: string;
  repo: FleetRepo;
  taskId: string;
  local: boolean;
  /** This run intends to open a PR, so upstream is the base and `local` is moot. */
  pr?: boolean;
}): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const workspace = path.join(opts.controlRepo, ".tmp", "runs", `${opts.taskId}-${opts.repo.name}-${stamp}`);
  mkdirSync(workspace, { recursive: true });

  if (opts.local && !opts.pr) {
    const source = resolveLocalSource(opts.repo, opts.controlRepo);
    if (!existsSync(source)) {
      throw new Error(`local repo not found: ${source}`);
    }
    materialiseHead(source, workspace);
    git(workspace, ["init", "-b", "main"]);
    // `-f` stages ignored paths, and here that is the correct reading rather
    // than a loosening: the only thing on disk is what materialiseHead wrote
    // out of the source's HEAD, so forcing can commit nothing the source does
    // not already track. Without it the target's own `.gitignore` gets a
    // second vote — a file it tracks *and* ignores (vendored output is the
    // usual way) would be materialised and then dropped, leaving the
    // verification tree short a file the target ships. The `node_modules`
    // symlink is created after this commit and so is untouched by the force.
    git(workspace, ["add", "-A", "-f"]);
    git(workspace, ["commit", "-m", "baseline", "--quiet"]);

    // Reuse the source's installed deps rather than installing per run — this
    // is what makes ensureDependencies a no-op below, and it keeps the hermetic
    // e2e suite off the network. Safe since ADR-0013: the verdict of record is
    // no longer produced in this workspace, so a write reaching the source
    // through this symlink cannot reach a verification result.
    //
    // After the base exists, never before, and a target's `.gitignore` is not
    // what keeps it out: `node_modules/` matches a directory and this is a
    // symlink, so it would be committed, and the verification tree — built from
    // that commit — would materialise it and run the checks against the
    // source's dependencies, which the agent can write through exactly this
    // link. That is the tier-3 contamination ADR-0013 exists to end, arriving
    // through the base.
    const sourceModules = path.join(source, "node_modules");
    if (existsSync(sourceModules) && !existsSync(path.join(workspace, "node_modules"))) {
      symlinkSync(sourceModules, path.join(workspace, "node_modules"), "dir");
      // The same blind spot, from the other side: untracked and unignored, the
      // link would be swept into the staged diff by `git add -A`. Excluded in
      // this clone's own git dir rather than by editing the target's
      // `.gitignore` (which is the target's file and would land in the diff) or
      // by another reset in `stagedDiff` (which states harness rules the runner
      // enforces, and this link is one the runner only creates in local mode).
      writeFileSync(path.join(workspace, ".git", "info", "exclude"), "/node_modules\n");
    }
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

  // After the baseline commit, never before: an install writes into
  // `node_modules`, and a target that fails to gitignore it would otherwise
  // bake 100+ packages into the baseline it is diffed against. Remote mode has
  // no baseline commit of its own — the clone's HEAD is the base — so the same
  // ordering just means the install lands untracked, exactly where the
  // `npm-install` check used to put it.
  ensureDependencies(workspace);

  return workspace;
}

/**
 * Inject the constrained agent configuration into a workspace:
 * .claude/settings.json (allowlist + Stop hook), the Stop hook script, and
 * the MCP config pointing the `verify` server at this workspace.
 */
export function injectAgentConfig(opts: {
  controlRepo: string;
  workspace: string;
  /**
   * The target's eligible registered verifiers (ADR-0009), already filtered by
   * the runner. Carried into the session as a JSON env var rather than a file
   * the agent could edit: the MCP server reads it once at launch, so nothing
   * the agent writes afterward can add, drop, or redefine a check.
   */
  registered?: VerifierCheck[];
}): {
  mcpConfigPath: string;
} {
  const templateDir = path.join(opts.controlRepo, "agent-config");
  const claudeDir = path.join(opts.workspace, ".claude");
  mkdirSync(path.join(claudeDir, "hooks"), { recursive: true });

  // Doubly encoded on purpose: the inner stringify is the payload, the outer one
  // makes it a correctly-escaped JSON/JS string literal, so one substitution is
  // valid in both mcp.json (a JSON string value) and stop-verify.mjs (a JS one).
  const registeredLiteral = JSON.stringify(JSON.stringify(opts.registered ?? []));

  const fill = (text: string) =>
    text
      .replaceAll("__CONTROL_REPO__", opts.controlRepo)
      .replaceAll("__WORKSPACE__", opts.workspace)
      .replaceAll("__REGISTERED_VERIFIERS__", registeredLiteral);

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
