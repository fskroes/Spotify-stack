import type { KnowledgeDriftReport } from "./drift.js";
import { ungroundedClaims } from "./grounding.js";
import { renderMap } from "./map.js";
import type { RepoMap } from "./types.js";

/**
 * Compose the `.fleet-knowledge.md` body injected into a dispatched run's
 * workspace: the same two grounded layers `fleet ask` serves — a structural map
 * rebuilt from the run's own working tree and the stored prose — so the agent
 * starts with the target's shape in hand rather than exploring it cold.
 *
 * When the stored prose has drifted past its baseline, a banner leads the file
 * naming the claims a current map no longer confirms, mirroring how
 * `buildAskPrompt` flags drift inline: the run still gets the prose, its stale
 * claims merely marked unverified rather than silently trusted.
 */
export function buildRunKnowledgeFile(map: RepoMap, prose: string, drift: KnowledgeDriftReport): string {
  const lines: string[] = [
    `# Target knowledge — ${map.repo}`,
    "",
    "Compiled understanding of this repository, injected into your workspace so you",
    "start with its structure in hand. Two grounded layers: the compiled prose (intent,",
    "seams, conventions) and a deterministic structural map rebuilt from the current tree.",
    "",
  ];

  // Lead with the staleness banner so it is the first thing read, not buried
  // under the map. Below baseline tolerance the not-found set is checker
  // vocabulary noise, so the banner appears only once the prose has drifted.
  if (drift.recompileRequired) {
    const drifted = ungroundedClaims(drift.grounding);
    lines.push(
      "> **STALE — the compiled prose has drifted from the current commit.**",
      `> Compiled at ${drift.artifactSha}; grounding ${drift.current.toFixed(3)} vs baseline ${drift.baseline.toFixed(3)}.`,
      "> These claims no longer resolve against the current map. Treat them as unverified, not fact:",
      ...drifted.map((claim) => `> - ${claim.kind}: ${claim.value}`),
      "",
    );
  }

  lines.push(
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
 * The first-prompt block that names the injected file to the agent and states
 * the artifact-vs-memory authority rule (spec §8.1): the file is authoritative
 * on code facts at its stamped commit (which files and symbols exist, how the
 * seams fit); memory is authoritative on episodic and preference knowledge; on a
 * code-fact conflict the file wins and the agent says so. One line flags the
 * stale banner when the prose has drifted.
 */
export function buildRunPreamble(relPath: string, artifactSha: string, stale = false): string {
  const lines = [
    `A compiled knowledge artifact for this target has been written to \`${relPath}\` in your`,
    `workspace. It was compiled at commit ${artifactSha} and holds the repository's structure`,
    "(files, symbols, seams), conventions, and principal data flows — read it first instead of",
    "exploring the tree cold.",
    "",
    "Authority: the file is authoritative on code facts at its stamped commit — which files and",
    "symbols exist and how the seams fit. Your memory is authoritative on episodic and preference",
    "knowledge (what happened before, how the user likes things done). On a code-fact conflict the",
    "file wins over memory, and you say so explicitly rather than silently choosing one.",
  ];
  if (stale) {
    lines.push(
      "",
      "The file opens with a STALE banner: some claims no longer resolve against the current tree.",
      "Treat the banner's listed claims as unverified — confirm them in the code before you rely on them.",
    );
  }
  return lines.join("\n");
}
