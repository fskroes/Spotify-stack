/**
 * The prototype's four verbs: build the map, compile the prose, run the two
 * arms, grade what came back — plus `drift`, which holds a stored prose layer
 * against a freshly built index.
 *
 * Everything it produces lands in `evidence/`, which is git-ignored: the runs
 * name a private fleet target and this repo is public.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { estimateTokens } from "./budget.js";
import { ARMS, runArm, type Arm, type ArmRun } from "./experiment.js";
import { checkGrounding } from "./grounding.js";
import { buildIndex, buildRepoMap, renderMap } from "./map.js";
import { compileProse } from "./prose.js";
import { QUESTIONS } from "./questions.js";

const HERE = dirname(new URL(import.meta.url).pathname);
const EVIDENCE = join(HERE, "..", "evidence");

function arg(name: string, fallback?: string): string {
  const value = optionalArg(name) ?? fallback;
  if (value === undefined) throw new Error(`missing --${name}=`);
  return value;
}

/** One parser for every flag, so `--out=a=b` means the same thing everywhere. */
function optionalArg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}

function repoArg(): string {
  return resolve(arg("repo").replace(/^~/, process.env.HOME ?? "~"));
}

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  process.stderr.write(`wrote ${path}\n`);
}

function log(line: string) {
  process.stderr.write(`${line}\n`);
}

const command = process.argv[2];

if (command === "map") {
  const map = buildRepoMap(repoArg(), { budgetTokens: Number(arg("budget", "6000")) });
  const out = optionalArg("out");
  if (out) write(out, renderMap(map));
  else process.stdout.write(renderMap(map));
  log(
    `sha=${map.sha.slice(0, 7)} files=${map.filesIncluded} omitted=${map.filesOmitted} skipped=${map.filesSkipped.length} tokens=${map.usedTokens}/${map.budgetTokens}`,
  );
} else if (command === "prose") {
  const repo = repoArg();
  const artifact = compileProse(repo, {
    mapBudget: Number(arg("map-budget", "15000")),
    maxLines: Number(arg("max-lines", "200")),
    model: arg("model", "opus"),
  });
  write(join(EVIDENCE, `${arg("name", "target")}-prose.md`), artifact.markdown);
  log(`compile tokens=${artifact.run.usage.input_tokens}+${artifact.run.usage.output_tokens} turns=${artifact.run.num_turns}`);
} else if (command === "experiment") {
  const repo = repoArg();
  const name = arg("name", "target");
  const model = arg("model", "sonnet");
  const mapBudget = Number(arg("map-budget", "6000"));

  const prose = readFileSync(join(EVIDENCE, `${name}-prose.md`), "utf8");
  const map = buildRepoMap(repo, { budgetTokens: mapBudget });
  const artifact = `${prose}\n\n${renderMap(map)}`;
  const artifactTokens = estimateTokens(artifact);
  write(join(EVIDENCE, `${name}-map.txt`), renderMap(map));
  log(`artifact ≈${artifactTokens} tokens (prose ${estimateTokens(prose)} + map ${map.usedTokens})`);
  if (map.filesSkipped.length > 0) log(`warning: ${map.filesSkipped.length} file(s) unparsed: ${map.filesSkipped.join(", ")}`);

  const only = optionalArg("only");
  const arms = (arg("arms", "cold,primed").split(",") as Arm[]);
  const runs: ArmRun[] = [];

  for (const question of QUESTIONS) {
    if (only && question.id !== only) continue;
    for (const arm of arms) {
      log(`running ${arm} / ${question.id} …`);
      const run = runArm({ arm, question, repoDir: repo, artifact, model, artifactTokens });
      runs.push(run);
      write(join(EVIDENCE, "runs", `${question.id}-${arm}.md`), run.answer);
      write(join(EVIDENCE, "runs", `${question.id}-${arm}.json`), JSON.stringify(run, null, 2));
      log(`  tokens=${run.tokens} turns=${run.turns} cost=$${run.costUsd.toFixed(4)} ${(run.durationMs / 1000).toFixed(0)}s`);
    }
  }
} else if (command === "drift") {
  // #53's recompile trigger, made concrete: the stored prose is held against a
  // map rebuilt from the repo's current SHA. Claims the fresh index can no
  // longer confirm are the drift; the ratio is what a threshold would fire on.
  const repo = repoArg();
  const name = arg("name", "target");
  const prosePath = join(EVIDENCE, `${name}-prose.md`);
  const prose = readFileSync(prosePath, "utf8");
  const stampedSha = /^sha:\s*(\S+)/m.exec(prose)?.[1] ?? "(none)";
  const index = buildIndex(repo);
  const report = checkGrounding(prose, index);

  const stale = report.claims.filter((c) => c.verdict === "not-found");
  log(`prose stamped at ${stampedSha.slice(0, 7)}, repo now at ${index.sha.slice(0, 7)}`);
  log(`${report.verified}/${report.verified + report.notFound} claims still confirmed (${report.groundedRatio.toFixed(3)})`);
  process.stdout.write(
    [
      `prose_sha: ${stampedSha}`,
      `repo_sha: ${index.sha}`,
      `confirmed: ${report.verified}`,
      `unconfirmed: ${report.notFound}`,
      `grounded_ratio: ${report.groundedRatio.toFixed(3)}`,
      `unconfirmed_claims: ${stale.map((c) => c.value).join(" ") || "—"}`,
      "",
    ].join("\n"),
  );
} else if (command === "grade") {
  const repo = repoArg();
  const name = arg("name", "target");
  const index = buildIndex(repo);
  log(`index: ${index.files.size} files, ${index.symbols.size} symbols @ ${index.sha.slice(0, 7)}`);

  const rows: string[] = [];
  for (const question of QUESTIONS) {
    for (const arm of ARMS) {
      const path = join(EVIDENCE, "runs", `${question.id}-${arm}.md`);
      let answer: string;
      try {
        answer = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const run = JSON.parse(readFileSync(path.replace(/\.md$/, ".json"), "utf8")) as ArmRun;
      const report = checkGrounding(answer, index);
      rows.push(
        [
          question.id,
          arm,
          String(run.tokens),
          run.costUsd.toFixed(4),
          `${(run.durationMs / 1000).toFixed(0)}s`,
          String(run.turns),
          `${report.verified}/${report.verified + report.notFound}`,
          report.groundedRatio.toFixed(2),
          String(report.proposed),
          report.claims
            .filter((c) => c.verdict === "not-found")
            .map((c) => c.value)
            .join(" ") || "—",
        ].join(" | "),
      );
    }
  }

  const table = [
    "| question | arm | tokens | cost | wall | turns | grounded | ratio | proposed | not-found |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r} |`),
  ].join("\n");
  write(join(EVIDENCE, `${name}-grading.md`), `${table}\n`);
  process.stdout.write(`${table}\n`);
} else {
  process.stderr.write(
    [
      `unknown command: ${command ?? "(none)"}`,
      "usage:",
      "  cli.ts map        --repo=<dir> [--budget=N] [--out=path]",
      "  cli.ts prose      --repo=<dir> --name=<target> [--map-budget=N] [--max-lines=N] [--model=opus]",
      "  cli.ts experiment --repo=<dir> --name=<target> [--model=sonnet] [--map-budget=N] [--only=qid] [--arms=cold,primed]",
      "  cli.ts drift      --repo=<dir> --name=<target>",
      "  cli.ts grade      --repo=<dir> --name=<target>",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
