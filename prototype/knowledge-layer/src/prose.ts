import { runClaude, totalTokens, type ClaudeResult } from "./claude.js";
import { buildRepoMap, renderMap } from "./map.js";

/**
 * The prose layer's shape. Sections are fixed so the artifact is comparable
 * across targets — this is a compile step in onboarding, not an essay.
 */
const SECTIONS = [
  "## What this product is — one paragraph, in the product's own vocabulary.",
  "## Architecture at a glance — the layers/directories and what each owns.",
  "## Key seams — the wiring points a change hangs off (entry points, services, storage, UI, external APIs). Name the file for each.",
  "## Conventions — naming, file layout, testing, and how a new feature is normally added here.",
  "## Feature landing zones — for the kinds of change this product plausibly gets, which files/directories get touched. Be concrete.",
  "## Verify gate — how this repo is built and tested.",
  "## Unknowns — what you could not determine from the repo. Say it plainly.",
];

export function buildCompilePrompt(mapText: string, maxLines: number): string {
  return [
    "You are compiling a durable knowledge artifact for a codebase you are onboarding into an agent fleet.",
    "It will be read by (a) a human asking 'where would feature X land?' before any code is written, and",
    "(b) background coding agents that must skip cold exploration. Compile it once; it is stored and reused.",
    "",
    "A deterministic map of the repository's declarations is below. Use it as your spine, and read whatever",
    "files you need (README, docs, entry points, the highest-ranked files) to explain intent the map cannot carry.",
    "",
    "Rules:",
    `- At most ${maxLines} lines. Density over completeness.`,
    "- Every file path and symbol you name MUST exist in the repo exactly as written. It will be checked mechanically.",
    "- Explain intent and wiring, not syntax. Never restate the map.",
    "- If you do not know something, put it under Unknowns rather than guessing.",
    "- Output the markdown body only — no preamble, no fences around the whole document.",
    "",
    "Sections, in this order:",
    ...SECTIONS,
    "",
    "---- REPO MAP ----",
    mapText,
  ].join("\n");
}

export interface ProseArtifact {
  markdown: string;
  run: ClaudeResult;
}

export function compileProse(
  repoDir: string,
  opts: { mapBudget: number; maxLines: number; model: string },
): ProseArtifact {
  const map = buildRepoMap(repoDir, { budgetTokens: opts.mapBudget });
  const run = runClaude({
    cwd: repoDir,
    prompt: buildCompilePrompt(renderMap(map), opts.maxLines),
    model: opts.model,
    allowedTools: "Read Grep Glob",
    maxTurns: 60,
  });

  const frontmatter = [
    "---",
    `repo: ${map.repo}`,
    `sha: ${map.sha}`,
    `compiled_at: ${new Date().toISOString()}`,
    `compiler_model: ${opts.model}`,
    `map_budget_tokens: ${opts.mapBudget}`,
    `compile_tokens: ${totalTokens(run.usage)}`,
    `compile_cost_usd: ${run.total_cost_usd.toFixed(4)}`,
    "---",
    "",
  ].join("\n");

  return { markdown: frontmatter + run.result.trim() + "\n", run };
}
