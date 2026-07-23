import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { run } from "@fleet/runner";
import {
  buildIndex,
  buildKnowledgeProsePrompt,
  buildRepoMap,
  buildRepoMapFromIndex,
  checkKnowledgeDrift,
  compileKnowledgeArtifact,
  parseKnowledgeArtifact,
  renderMap,
} from "@fleet/knowledge";
import { loadTask } from "@fleet/runner/task";
import { resolveFleetRepo, resolveLocalSource, resolveOwner, targetRepos, type FleetRepoVisibility } from "@fleet/runner/fleet";
import type { LedgerEntry, PrLiveState } from "@fleet/contract";
import { defaultLedgerPath, fleetRecord, formatRecordLine, readLedger } from "@fleet/runner/ledger";
import { readUnionLedger } from "@fleet/runner/ledger-union";
import { writeLedgerHtml } from "@fleet/runner/ledger-html";
import { serveLedger } from "@fleet/runner/ledger-serve";
import { cosign, formatCosignResult } from "@fleet/runner/cosign";
import { knowledgeArtifactPath } from "./knowledge-artifact.js";
import { compileKnowledgeProse } from "./knowledge-compile.js";

const controlRepo = process.cwd();

/** Accept a task id (looked up under tasks/) or a path to a task file. */
function resolveTaskPath(taskArg: string): string {
  if (existsSync(taskArg)) return path.resolve(taskArg);
  // tasks/private holds git-ignored project tasks (see tasks/private/README.md);
  // searched first so a local task can shadow a public one of the same id.
  for (const dir of ["tasks/private", "tasks/examples", "tasks/onramp", "tasks"]) {
    const candidate = path.join(controlRepo, dir, `${taskArg}.md`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`task not found: ${taskArg} (looked for a file and under tasks/)`);
}

function gh(args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync("gh", args, { encoding: "utf8", cwd: opts.cwd ?? controlRepo });
}

/** Runs `git` in the control repo. Used for the union ledger read: `git fetch`
 *  + `git show` of origin/main's committed ledger, never a working-tree write. */
function git(args: string[]): string {
  return execFileSync("git", ["-C", controlRepo, ...args], { encoding: "utf8" });
}

/**
 * Async `gh` for `gh run download` — spawn-based so a slow artifact pull never
 * blocks the serve event loop. Rejects with stderr so the sync layer can tell a
 * gone artifact from a transient failure.
 */
function ghAsync(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { cwd: controlRepo });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `gh exited with code ${code}`)),
    );
  });
}

function resolveKnowledgeRepo(target: string): { repoDir: string; visibility: FleetRepoVisibility } {
  const { repo, visibility } = resolveFleetRepo(controlRepo, target);
  const repoDir = resolveLocalSource(repo, controlRepo);
  if (!existsSync(repoDir)) {
    throw new Error(
      `target "${target}" has no local source at ${repoDir}; set local_path in fleet/repos.local.yaml or add demo-repos/${target}`,
    );
  }
  return { repoDir, visibility };
}

function formatKnowledgeDrift(target: string, report: ReturnType<typeof checkKnowledgeDrift>): string {
  const revision = report.dirty ? `${report.currentSha.slice(0, 7)} + working tree changes` : report.currentSha.slice(0, 7);
  const lines = [
    `# Knowledge drift — ${target} @ ${revision}`,
    `# Stored prose @ ${report.artifactSha}`,
    `baseline: ${report.baseline.toFixed(3)}`,
    `current:  ${report.current.toFixed(3)}`,
    `delta:    ${report.delta.toFixed(3)}`,
    `drift:    ${report.recompileRequired ? "recompile required" : "within baseline tolerance"}`,
  ];
  const unconfirmed = report.grounding.claims.filter((claim) => claim.verdict === "not-found");
  if (unconfirmed.length > 0) {
    lines.push("unconfirmed claims:");
    for (const claim of unconfirmed) lines.push(`- ${claim.kind}: ${claim.value}`);
  }
  return `${lines.join("\n")}\n`;
}

const program = new Command()
  .name("fleet")
  .description("Background coding agent fleet (Spotify Honk-style reference implementation)");

const knowledge = program
  .command("knowledge")
  .description("Build deterministic structural knowledge from local fleet targets");

knowledge
  .command("map")
  .description("Render a deterministic structural map without network or model calls")
  .argument("<target>", "repo name from fleet/repos.yaml")
  .option("--budget <tokens>", "positive token budget", "15000")
  .action(async (target: string, options: { budget: string }) => {
    if (!/^\d+$/.test(options.budget)) throw new Error("--budget must be a positive integer");
    const budgetTokens = Number(options.budget);
    if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) {
      throw new Error("--budget must be a positive integer");
    }

    process.stdout.write(renderMap(await buildRepoMap(resolveKnowledgeRepo(target).repoDir, { budgetTokens })));
  });

knowledge
  .command("compile")
  .description("Compile grounded knowledge prose from a target's structural map")
  .argument("<target>", "repo name from fleet/repos.yaml")
  .action(async (target: string) => {
    const { repoDir, visibility } = resolveKnowledgeRepo(target);
    const index = await buildIndex(repoDir);
    const map = buildRepoMapFromIndex(index);
    const prose = compileKnowledgeProse(repoDir, buildKnowledgeProsePrompt(map));
    const artifact = compileKnowledgeArtifact(prose, index);
    const artifactPath = knowledgeArtifactPath(controlRepo, target, visibility);

    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, artifact.markdown);
    console.log(`knowledge compiled: ${target} → ${path.relative(controlRepo, artifactPath)}`);
  });

knowledge
  .command("drift")
  .description("Check stored knowledge prose against the target's current structural index")
  .argument("<target>", "repo name from fleet/repos.yaml")
  .action(async (target: string) => {
    const { repoDir, visibility } = resolveKnowledgeRepo(target);
    const artifactPath = knowledgeArtifactPath(controlRepo, target, visibility);
    if (!existsSync(artifactPath)) {
      throw new Error(`knowledge artifact not found: ${artifactPath}; run fleet knowledge compile ${target} first`);
    }

    const index = await buildIndex(repoDir);
    const report = checkKnowledgeDrift(parseKnowledgeArtifact(readFileSync(artifactPath, "utf8")), index);
    process.stdout.write(formatKnowledgeDrift(target, report));
  });

program
  .command("run")
  .description("Run a task against one repo (the per-repo agent loop)")
  .argument("<task>", "task id or path to a task file")
  .requiredOption("--repo <name>", "repo name from fleet/repos.yaml")
  .option("--local", "copy the repo from demo-repos/ instead of cloning", false)
  .option("--pr", "push a branch and open a PR (default: dry-run)", false)
  .option("--engine <engine>", "claude | mock", "claude")
  .option("--mock-patch <path>", "patch file for the mock engine (or NONE)")
  .option("--judge <mode>", "claude | cli | approve | veto | veto-once (default: cli locally on your subscription, claude/SDK in CI)")
  .action(async (taskArg: string, options) => {
    const result = await run({
      controlRepo,
      taskPath: resolveTaskPath(taskArg),
      repoName: options.repo,
      local: options.local,
      dryRun: !options.pr,
      engine: options.engine,
      mockPatch:
        options.mockPatch && options.mockPatch !== "NONE"
          ? path.resolve(options.mockPatch)
          : options.mockPatch,
      judgeMode: options.judge,
    });
    console.log(`\nstatus:    ${result.status}`);
    console.log(`artifacts: ${path.relative(controlRepo, result.artifactsDir)}`);
    if (result.prUrl) console.log(`pr:        ${result.prUrl}`);
    if (result.status === "approved" && !options.pr) {
      console.log("\n(dry-run — diff saved to artifacts; use --pr to open a pull request)");
    }
    process.exitCode = ["approved", "no-changes"].includes(result.status) ? 0 : 1;
  });

program
  .command("dispatch")
  .description("Dispatch a task to GitHub Actions (fleet fan-out unless --repo)")
  .argument("<task>", "task id or path to a task file")
  .option("--repo <name>", "dispatch to a single repo instead of the whole fleet")
  .action((taskArg: string, options) => {
    const task = loadTask(resolveTaskPath(taskArg));
    if (options.repo) {
      gh(["workflow", "run", "agent-task.yml", "-f", `task_id=${task.id}`, "-f", `target_repo=${options.repo}`]);
      console.log(`dispatched agent-task.yml: ${task.id} on ${options.repo}`);
    } else {
      gh(["workflow", "run", "fleet-run.yml", "-f", `task_id=${task.id}`]);
      const repos = targetRepos(controlRepo, task.targets).map((r) => r.name);
      console.log(`dispatched fleet-run.yml: ${task.id} → matrix over [${repos.join(", ")}]`);
    }
    console.log("watch with: gh run list --limit 5");
  });

program
  .command("status")
  .description("Report Actions runs and PRs for a task as a markdown table")
  .argument("<task>", "task id or path to a task file")
  .action((taskArg: string) => {
    const task = loadTask(resolveTaskPath(taskArg));
    const repos = targetRepos(controlRepo, task.targets);
    const owner = resolveOwner();

    interface GhRun {
      displayTitle: string;
      status: string;
      conclusion: string;
      url: string;
    }
    let runs: GhRun[] = [];
    let actionsNote = "";
    try {
      runs = JSON.parse(
        gh(["run", "list", "--limit", "50", "--json", "displayTitle,status,conclusion,url"]),
      ) as GhRun[];
    } catch {
      actionsNote = "\n(GitHub Actions unavailable — no remote configured yet? Showing local artifacts only.)";
    }

    console.log(`## ${task.id} — ${task.title}\n`);
    console.log("| repo | run | pr |");
    console.log("|---|---|---|");
    for (const repo of repos) {
      // Per-repo dispatches carry both ids in the title; fleet-run matrix
      // runs are titled by task only.
      const match =
        runs.find((r) => r.displayTitle.includes(task.id) && r.displayTitle.includes(repo.name)) ??
        runs.find((r) => r.displayTitle.includes(task.id));
      const runCell = match ? `[${match.conclusion || match.status}](${match.url})` : "—";

      let prCell = "—";
      if (owner) {
        try {
          const prs = JSON.parse(
            gh([
              "pr", "list",
              "--repo", `${owner}/${repo.name}`,
              "--head", `agent/${task.id}`,
              "--state", "all",
              "--json", "url,state",
            ]),
          ) as { url: string; state: string }[];
          if (prs.length > 0) prCell = `[${prs[0].state}](${prs[0].url})`;
        } catch {
          prCell = "(gh error)";
        }
      }
      console.log(`| ${repo.name} | ${runCell} | ${prCell} |`);
    }
    if (actionsNote) console.log(actionsNote);

    // Local artifacts, if any.
    const artifactsRoot = path.join(controlRepo, "artifacts", task.id);
    if (existsSync(artifactsRoot)) {
      console.log(`\nlocal artifacts: artifacts/${task.id}/`);
      for (const repo of repos) {
        const resultFile = path.join(artifactsRoot, repo.name, "result.json");
        if (existsSync(resultFile)) {
          const parsed = JSON.parse(readFileSync(resultFile, "utf8")) as { status: string };
          console.log(`- ${repo.name}: ${parsed.status}`);
        }
      }
    }
  });

program
  .command("cosign")
  .description("The human decision on a shipped run: squash-merge its PR, or close it with a reason")
  .argument("<runId>", "run id from the ledger (fleet report / the operator)")
  .option("--merge", "squash-merge the run's PR and delete the branch", false)
  .option("--close", "close the run's PR without merging", false)
  .option("--reason <text>", "required with --close: why — lands as a PR comment")
  .option("--json", "print the structured result (for the operator app)", false)
  .action((runId: string, options: { merge: boolean; close: boolean; reason?: string; json: boolean }) => {
    if (options.merge === options.close) throw new Error("cosign needs exactly one of --merge or --close");
    if (options.reason && !options.close) throw new Error("--reason only applies to --close");
    const result = cosign({
      // Union of the local ledger and origin/main's committed copy, so a cloud
      // run's line (pushed to main, never to the local file) resolves here too.
      entries: readUnionLedger(defaultLedgerPath(controlRepo), git),
      runId,
      action: options.merge ? "merge" : "close",
      reason: options.reason,
      gh: (args) => gh(args),
    });
    console.log(options.json ? JSON.stringify(result) : formatCosignResult(result));
    process.exitCode = result.ok ? 0 : 1;
  });

/**
 * Live co-sign state for every shipped PR in the ledger, via gh. The ledger
 * can't know what a human did with a PR after the run, so this is fetched at
 * report time and only when asked (--cosign) — the auto-regenerated report
 * after each run stays offline. A PR gh can't resolve is simply omitted.
 */
function fetchCosigns(entries: LedgerEntry[]): Record<string, PrLiveState> {
  const urls = [...new Set(entries.filter((e) => e.status === "approved" && e.prUrl).map((e) => e.prUrl as string))];
  const cosigns: Record<string, PrLiveState> = {};
  for (const url of urls) {
    try {
      const pr = JSON.parse(gh(["pr", "view", url, "--json", "state,mergedAt,mergedBy"])) as {
        state: string;
        mergedAt: string | null;
        mergedBy: { login: string } | null;
      };
      cosigns[url] = {
        state: pr.state === "MERGED" ? "merged" : pr.state === "OPEN" ? "open" : "closed",
        mergedBy: pr.mergedBy?.login,
        mergedAt: pr.mergedAt ?? undefined,
      };
    } catch {
      console.error(`(co-sign state unavailable for ${url} — skipped)`);
    }
  }
  return cosigns;
}

/** The OS command that opens a URL in the default browser, per platform. */
function browserOpenCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}

/**
 * Open a URL in the default browser, fire-and-forget. Detached + unref'd so it
 * never blocks or holds the server's event loop, and any failure (headless box,
 * missing opener) is swallowed — the live server must run regardless.
 */
function openBrowser(url: string): void {
  const { cmd, args } = browserOpenCommand(process.platform, url);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best-effort — the URL is printed anyway.
  }
}

program
  .command("report")
  .description("The fleet record: shipped vs. killed before review, kills with reasons")
  .option("--days <n>", "window in days", "30")
  .option("--html", "render the Fleet Ledger as a self-contained HTML page instead of text", false)
  .option("--cosign", "with --html/--serve: fetch live PR merge state from GitHub (needs gh)", false)
  .option("--out <path>", "output file for --html", "artifacts/ledger.html")
  .option("--serve", "serve the Fleet Ledger live, auto-reloading as runs land", false)
  .option("--port <n>", "port for --serve", "4173")
  .option("--open", "with --serve: open the live ledger in your browser", false)
  .action(async (options: { days: string; html: boolean; cosign: boolean; out: string; serve: boolean; port: string; open: boolean }) => {
    const days = Number.parseInt(options.days, 10);
    const ledgerPath = defaultLedgerPath(controlRepo);
    const entries = readLedger(ledgerPath);

    if (options.serve) {
      const { url } = await serveLedger({
        ledgerPath,
        controlRepo,
        port: Number.parseInt(options.port, 10),
        renderOpts: { days },
        // Re-read the ledger each poll so newly shipped PRs are picked up.
        fetchCosigns: options.cosign ? () => fetchCosigns(readLedger(ledgerPath)) : undefined,
        // Cloud review: fold origin/main's committed ledger into every view, and
        // pull a cloud run's Actions artifact on demand when it is opened.
        git,
        downloadGh: ghAsync,
      });
      console.log(`Fleet Ledger live at ${url}`);
      console.log(
        options.cosign
          ? "Co-sign polling on — fetching live PR merge state from GitHub every 60s."
          : "Co-sign polling off (offline). Add --cosign to poll GitHub merge state.",
      );
      console.log("Cloud runs sync from origin/main; their evidence downloads on demand when reviewed.");
      console.log("watching fleet/ledger.jsonl — Ctrl-C to stop");
      if (options.open) openBrowser(url);
      return;
    }

    if (options.html) {
      const outPath = path.resolve(controlRepo, options.out);
      const cosigns = options.cosign ? fetchCosigns(entries) : undefined;
      const n = writeLedgerHtml(defaultLedgerPath(controlRepo), outPath, { days, cosigns });
      console.log(`Fleet Ledger written to ${path.relative(controlRepo, outPath)} (${n} run${n === 1 ? "" : "s"} in the ledger, ${days}-day window${cosigns ? `, co-sign state for ${Object.keys(cosigns).length} PR${Object.keys(cosigns).length === 1 ? "" : "s"}` : ""}).`);
      return;
    }

    if (entries.length === 0) {
      console.log("No fleet runs recorded yet (fleet/ledger.jsonl is empty).");
      return;
    }
    const record = fleetRecord(entries, { days });
    console.log(formatRecordLine(record));
    if (record.infra > 0 || record.neutral > 0) {
      console.log(
        `(${record.infra} engine failure${record.infra === 1 ? "" : "s"} counted as infra, ` +
          `${record.neutral} no-change run${record.neutral === 1 ? "" : "s"} neutral.)`,
      );
    }
    if (record.kills.length > 0) {
      console.log("\nKilled before anyone reviewed them:");
      for (const kill of record.kills) {
        const day = kill.ts.slice(0, 10);
        console.log(`- ${day}  ${kill.task} on ${kill.repo} [${kill.mode}] — ${kill.status}: ${kill.reason ?? "(no reason recorded)"}`);
      }
    }
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`fleet: ${err.message}`);
  process.exit(1);
});
