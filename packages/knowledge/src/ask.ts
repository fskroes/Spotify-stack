import type { KnowledgeDriftReport } from "./drift.js";
import { ungroundedClaims, type GroundingReport } from "./grounding.js";
import { renderMap } from "./map.js";
import type { RepoMap } from "./types.js";

/**
 * Build the ideation prompt for the human-facing `fleet ask` seam: the stored
 * prose layer and a freshly rebuilt structural map, framed to serve the three
 * #52 question classes without the reader opening the repository.
 *
 * When the prose has drifted past its baseline, the claims a current map no
 * longer confirms are named inline so the answer can flag them as unverified
 * rather than silently repeat a stale fact. The prompt never asks the model to
 * block or recompile — freshness is the human path, which answers immediately.
 */
export function buildAskPrompt(map: RepoMap, prose: string, question: string, drift: KnowledgeDriftReport): string {
  const lines = [
    "You are answering a product-ideation question about a fleet target without the reader opening its repository.",
    "Answer from the two grounded layers below: the compiled prose (intent, conventions, seams) and a structural map rebuilt from the target's current working tree.",
    "",
    "Serve whichever class the question calls for:",
    "- Placement — where a feature or change would land: the files and seams to touch.",
    "- Wiring — how something works today, traced through the code in the order things happen.",
    "- Story → dispatch-ready brief — given a story or feature request, produce a brief a fleet task can act on directly: files and seams to touch, the approach, the constraints to respect, and the verify gate to satisfy.",
    "",
    "Grounding discipline:",
    "- Name only files, symbols, and seams that appear in the structural map or the prose. Never invent a path or identifier to finish an answer.",
    "- When the two layers are insufficient, say so plainly. A wrong file name costs the reader more than an admitted gap.",
    "",
  ];

  // Only surface drift flags once the prose has fallen past its baseline: below
  // threshold the not-found set is checker vocabulary noise (framework symbols),
  // not real staleness, and would train the reader to ignore the warning.
  if (drift.recompileRequired) {
    const drifted = ungroundedClaims(drift.grounding);
    lines.push(
      `The stored prose was compiled at ${drift.artifactSha} and has drifted from the current tree (grounding ${drift.current.toFixed(3)} vs baseline ${drift.baseline.toFixed(3)}).`,
      "These claims in the prose no longer resolve against the current map. Treat them as unverified at the current SHA: if you rely on one, flag it as unverified rather than stating it as fact.",
      ...drifted.map((claim) => `- ${claim.kind}: ${claim.value}`),
      "",
    );
  }

  lines.push(
    "## Question",
    "",
    question,
    "",
    "## Compiled prose",
    "",
    prose.trim(),
    "",
    "## Structural map",
    "",
    renderMap(map).trimEnd(),
    "",
  );

  return lines.join("\n");
}

/**
 * Format the grounded leg of an answer: the mechanical dead-end count with the
 * grounded ratio, then every reference a map rebuilt at the current SHA could
 * not resolve. Dead-ends lead because a reference that sends the reader back
 * into the repo is the failure the #52 value projection is measured against.
 */
export function formatAnswerGrounding(report: GroundingReport): string {
  const ungrounded = ungroundedClaims(report);
  const header = `dead-ends: ${ungrounded.length} ungrounded reference${ungrounded.length === 1 ? "" : "s"} (grounded ratio ${report.groundedRatio.toFixed(3)}, ${report.verified}/${report.checked} resolved)`;
  if (ungrounded.length === 0) return header;
  return [header, ...ungrounded.map((claim) => `- ${claim.kind}: ${claim.value}`)].join("\n");
}
