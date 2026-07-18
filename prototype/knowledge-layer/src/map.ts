import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fitToBudget } from "./budget.js";
import { extractSymbols, languageFor } from "./parse.js";
import { rankFiles } from "./rank.js";
import { selectDefinitions } from "./select.js";
import type { FileSymbols, RepoIndex, RepoMap, RankedFile } from "./types.js";

/** Files bigger than this are generated or vendored more often than they are read. */
const MAX_FILE_BYTES = 400_000;

function git(repoDir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 }).toString();
}

function trackedFiles(repoDir: string): string[] {
  return git(repoDir, "ls-files")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

interface ReadResult {
  symbols: FileSymbols[];
  /** Files a grammar claimed but could not be read or parsed. */
  skipped: string[];
}

function readSymbols(repoDir: string, files: string[]): ReadResult {
  const symbols: FileSymbols[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const spec = languageFor(file);
    if (!spec) continue;
    const path = join(repoDir, file);
    try {
      if (statSync(path).size > MAX_FILE_BYTES) {
        skipped.push(file);
        continue;
      }
      symbols.push(extractSymbols(file, readFileSync(path, "utf8"), spec));
    } catch {
      // The map is lossy by construction, but a silent skip and a grammar
      // regression look identical — so the count is carried out, not swallowed.
      skipped.push(file);
    }
  }
  return { symbols, skipped };
}

/** No single file gets more than this many declaration lines in the map. */
const MAX_LINES_PER_FILE = 24;

function renderFile(file: RankedFile): string {
  const { kept, dropped } = selectDefinitions(file.definitions, MAX_LINES_PER_FILE);
  const lines = kept.map((d) => `  ${d.line}: ${d.signature}`);
  if (dropped > 0) lines.push(`  … ${dropped} more declarations`);
  return `${file.file}\n${lines.join("\n")}\n`;
}

/**
 * Layer 1 of the knowledge artifact: an ephemeral, rank-ordered, token-budgeted
 * view of what the repo defines, derived from the working tree at HEAD.
 * Never stored — rebuilt on every use (#53).
 */
export function buildRepoMap(repoDir: string, opts: { budgetTokens: number }): RepoMap {
  const sha = git(repoDir, "rev-parse", "HEAD").trim();
  const { symbols, skipped } = readSymbols(repoDir, trackedFiles(repoDir));
  const scores = rankFiles(symbols);

  const candidates: RankedFile[] = symbols
    .map((s) => ({ file: s.file, score: scores.get(s.file) ?? 0, definitions: s.definitions }))
    .filter((f) => f.definitions.length > 0);

  const budgeted = fitToBudget(
    candidates.map((f) => ({ score: f.score, text: renderFile(f), file: f })),
    opts.budgetTokens,
  );

  const files = budgeted.kept.map((entry) => entry.file).sort((a, b) => b.score - a.score);

  return {
    repo: basename(repoDir),
    sha,
    generatedAt: new Date().toISOString(),
    budgetTokens: opts.budgetTokens,
    usedTokens: budgeted.usedTokens,
    filesIncluded: files.length,
    filesOmitted: budgeted.omitted,
    filesSkipped: skipped,
    files,
  };
}

export function renderMap(map: RepoMap): string {
  const header = [
    `# Repo map — ${map.repo} @ ${map.sha.slice(0, 7)}`,
    `# ${map.filesIncluded} files shown, ${map.filesOmitted} omitted, ~${map.usedTokens} tokens (budget ${map.budgetTokens})`,
    "# Ranked by dependency centrality. Format: path, then `line: declaration`.",
    "",
  ].join("\n");

  return header + map.files.map(renderFile).join("\n");
}

/**
 * Every tracked file and every parsed symbol name — the ledger the grounding
 * check holds an answer against. Unbudgeted on purpose: this is a checker, not
 * context.
 */
export function buildIndex(repoDir: string): RepoIndex {
  const files = trackedFiles(repoDir);
  const symbols = new Set<string>();
  for (const fileSymbols of readSymbols(repoDir, files).symbols) {
    for (const d of fileSymbols.definitions) symbols.add(d.name);
  }
  return { sha: git(repoDir, "rev-parse", "HEAD").trim(), files: new Set(files), symbols };
}
