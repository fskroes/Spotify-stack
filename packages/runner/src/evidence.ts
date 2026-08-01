import path from "node:path";

/**
 * The canonical per-run evidence directory — `fleet/evidence/<runId>/`.
 *
 * The ledger is a compact projection; this is the record it was taken from
 * (`docs/README.md`, fourth seam). Git-ignored, so a private target's prose
 * lives here by construction and never reaches the public repo.
 *
 * One expression, because two stores now write here — model-usage evidence
 * (ADR-0002) and retained kills (ADR-0015) — and a second copy of this join
 * would be free to drift from the first.
 */
export function runEvidenceDir(evidenceRoot: string, runId: string): string {
  return path.join(evidenceRoot, "fleet", "evidence", runId);
}
