import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fitToBudget } from "./budget.js";
import { extractSymbols, languageForPath } from "./parse.js";
import { rankFiles } from "./rank.js";
import { selectDefinitions } from "./select.js";
import type { ParsedFile, RankedFile, RepoIndex, RepoMap, SkippedFile } from "./types.js";

const defaultBudgetTokens = 15_000;
const definitionsPerFile = 24;

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function trackedFiles(repoDir: string): string[] {
  return git(repoDir, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function hasTrackedSourceChanges(repoDir: string, files: string[]): boolean {
  const sourceFiles = new Set(files.filter((file) => languageForPath(file)));
  const changedFiles = [
    ...git(repoDir, ["diff", "--name-only", "-z"]).split("\0"),
    ...git(repoDir, ["diff", "--cached", "--name-only", "-z"]).split("\0"),
  ];
  return changedFiles.some((file) => sourceFiles.has(file));
}

async function readParsedFiles(repoDir: string, files: string[]): Promise<{ parsedFiles: ParsedFile[]; filesSkipped: SkippedFile[] }> {
  const parsedFiles: ParsedFile[] = [];
  const filesSkipped: SkippedFile[] = [];

  for (const file of files) {
    const language = languageForPath(file);
    if (!language) continue;

    let source: string;
    try {
      source = readFileSync(path.join(repoDir, file), "utf8");
    } catch {
      filesSkipped.push({ file, reason: "unreadable" });
      continue;
    }

    try {
      parsedFiles.push(await extractSymbols(file, source, language));
    } catch {
      filesSkipped.push({ file, reason: "parse-failed" });
    }
  }

  return { parsedFiles, filesSkipped };
}

/** Rebuild the complete structural index from the target's tracked working tree. */
export async function buildIndex(repoDir: string): Promise<RepoIndex> {
  const files = trackedFiles(repoDir);
  const { parsedFiles, filesSkipped } = await readParsedFiles(repoDir, files);
  const symbols = parsedFiles.flatMap((file) => file.symbols);

  return {
    repo: path.basename(path.resolve(repoDir)),
    sha: git(repoDir, ["rev-parse", "HEAD"]).trim(),
    dirty: hasTrackedSourceChanges(repoDir, files),
    files,
    parsedFiles,
    symbols,
    filesSkipped,
  };
}

function renderFile(file: RankedFile): string {
  const selection = selectDefinitions(file.symbols, definitionsPerFile);
  const lines = selection.kept.map((symbol) => `  ${symbol.line}: ${symbol.signature}`);
  if (selection.dropped > 0) lines.push(`  … ${selection.dropped} more declarations`);
  return `${file.file}\n${lines.join("\n")}\n`;
}

/** Construct a deterministic structural map from one already-built target snapshot. */
export function buildRepoMapFromIndex(
  index: RepoIndex,
  options: { budgetTokens?: number } = {},
): RepoMap {
  const budgetTokens = options.budgetTokens ?? defaultBudgetTokens;
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) {
    throw new Error("budgetTokens must be a positive integer");
  }

  const scores = rankFiles(index.parsedFiles);
  const candidates: RankedFile[] = index.parsedFiles
    .filter((file) => file.symbols.length > 0)
    .map((file) => ({ file: file.file, score: scores.get(file.file) ?? 0, symbols: file.symbols }));
  const budgeted = fitToBudget(
    candidates.map((file) => ({
      ...file,
      text: renderFile(file),
    })),
    budgetTokens,
  );

  return {
    repo: index.repo,
    sha: index.sha,
    dirty: index.dirty,
    budgetTokens,
    usedTokens: budgeted.usedTokens,
    filesIncluded: budgeted.kept.length,
    filesOmitted: budgeted.omitted,
    filesSkipped: index.filesSkipped,
    files: budgeted.kept.map(({ text: _text, ...file }) => file),
  };
}

/** Build a fresh, deterministic map without retaining target content or map state. */
export async function buildRepoMap(
  repoDir: string,
  options: { budgetTokens?: number } = {},
): Promise<RepoMap> {
  return buildRepoMapFromIndex(await buildIndex(repoDir), options);
}

/** Render the map data without side effects so repeated maps produce identical stdout. */
export function renderMap(map: RepoMap): string {
  const revision = map.dirty ? `${map.sha.slice(0, 7)} + working tree changes` : map.sha.slice(0, 7);
  const header = [
    `# Repo map — ${map.repo} @ ${revision}`,
    `# ${map.filesIncluded} files shown, ${map.filesOmitted} omitted, ~${map.usedTokens} tokens (budget ${map.budgetTokens})`,
    "# Ranked by dependency centrality. Format: path, then `line: declaration`.",
  ];
  if (map.filesSkipped.length > 0) {
    header.push("# Skipped supported files:");
    for (const skipped of map.filesSkipped) header.push(`# - ${skipped.file} (${skipped.reason})`);
  }
  return `${header.join("\n")}\n\n${map.files.map(renderFile).join("\n")}`;
}
