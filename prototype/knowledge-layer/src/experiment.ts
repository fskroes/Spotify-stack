import { runClaude, totalTokens, type ClaudeResult } from "./claude.js";

/** Both arms of the experiment, in report order. The one list every verb reads. */
export const ARMS = ["cold", "primed"] as const;

export type Arm = (typeof ARMS)[number];

export interface Question {
  id: string;
  /** The #52 question class this exercises. */
  questionClass: "placement" | "wiring" | "story-brief";
  text: string;
}

/**
 * Identical for both arms — only the starting knowledge differs.
 *
 * The last rule is load-bearing for measurement, not for the reader: a run that
 * delegates its deliverable to a file write or a sub-agent leaves the recorded
 * answer a stub, and the run is then unscoreable however well it did the work.
 * That happened once (see the comparison's threats to validity).
 */
const ANSWER_SHAPE = [
  "Answer for a developer who will act on this immediately. Requirements:",
  "- Name concrete files (repo-relative paths) and symbols; a reader must not have to re-explore the repo.",
  "- Everything you name as existing must actually exist. Mark anything you would create as new.",
  "- If you do not know something, say so explicitly instead of inventing it.",
  "- Be concise: at most 60 lines.",
  "- Put the complete answer in your reply. Do not write it to a file and do not summarise work done elsewhere.",
].join("\n");

/**
 * Both arms get the same framing and the same latitude to explore. The only
 * difference is whether the artifact is present — an asymmetric instruction
 * ("rely on the artifact", "explore as much as you need") would confound the
 * token comparison by measuring the instruction rather than the artifact.
 */
const PREAMBLE = [
  "You are answering a question about the codebase in your current working directory.",
  "Open whatever files you need to answer well.",
].join("\n");

export function buildQuestionPrompt(arm: Arm, question: Question, artifact: string): string {
  const head =
    arm === "cold"
      ? [PREAMBLE]
      : [
          PREAMBLE,
          "",
          "A pre-compiled knowledge artifact for this exact repository is included below: a generated",
          "prose layer plus a ranked map of declarations, both stamped at the repo's current commit.",
        ];

  const body =
    arm === "cold"
      ? []
      : ["", "---- KNOWLEDGE ARTIFACT ----", artifact, "---- END ARTIFACT ----"];

  return [...head, "", ANSWER_SHAPE, ...body, "", "QUESTION:", question.text].join("\n");
}

export interface ArmRun {
  arm: Arm;
  questionId: string;
  answer: string;
  /** Cumulative tokens over every iteration of the run. */
  tokens: number;
  /** Context size of the final iteration only — what the `json` envelope reports. */
  finalIterationTokens: number;
  usage: ClaudeResult["usage"];
  costUsd: number;
  turns: number;
  durationMs: number;
  /** Tokens injected up front — zero for cold, the artifact's size for primed. */
  artifactTokens: number;
}

export function runArm(opts: {
  arm: Arm;
  question: Question;
  repoDir: string;
  artifact: string;
  model: string;
  artifactTokens: number;
}): ArmRun {
  const result = runClaude({
    cwd: opts.repoDir,
    prompt: buildQuestionPrompt(opts.arm, opts.question, opts.artifact),
    model: opts.model,
    allowedTools: "Read Grep Glob",
    maxTurns: 40,
    stream: true,
  });

  return {
    arm: opts.arm,
    questionId: opts.question.id,
    answer: result.result,
    tokens: result.streamTokens,
    finalIterationTokens: totalTokens(result.usage),
    usage: result.usage,
    costUsd: result.total_cost_usd,
    turns: result.num_turns,
    durationMs: result.wallMs,
    artifactTokens: opts.artifactTokens,
  };
}
