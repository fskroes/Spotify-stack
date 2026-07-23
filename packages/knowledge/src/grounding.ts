import type { RepoIndex } from "./types.js";

/**
 * What `groundedRatio` measures: the share of referenced files and symbols that
 * exist in the structural index. It is broad structural coverage, not direct
 * behavioral evidence — a high ratio confirms the nouns are real, not that the
 * prose describing their behavior is correct.
 */
export const GROUNDING_BASIS = "structural-references" as const;

const CHECKABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".swift",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".plist",
  ".h",
  ".m",
]);

/** Paths, backticked or bare, that end in a source or common repository-file extension. */
const FILE_PATTERN = /[A-Za-z0-9_./+-]+\.[A-Za-z]{1,6}\b/g;
/** Code-shaped identifiers are claims only when prose puts them in backticks. */
const BACKTICK_PATTERN = /`([^`\n]+)`/g;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?$/;
/** Plans to create code do not claim that it exists at the indexed SHA. */
const CREATION_PATTERN = /\b(new|create|creates|creating|add|adds|adding|introduce|introduces|introducing)\b/i;

export interface GroundingClaim {
  value: string;
  kind: "file" | "symbol";
  verdict: "verified" | "proposed" | "not-found";
}

export interface GroundingReport {
  claims: GroundingClaim[];
  verified: number;
  notFound: number;
  proposed: number;
  /** Denominator of groundedRatio: verified + notFound (excludes proposed). */
  checked: number;
  groundedRatio: number;
}

/** The references a grounding pass could not resolve — a text's dead-ends. */
export function ungroundedClaims(report: GroundingReport): GroundingClaim[] {
  return report.claims.filter((claim) => claim.verdict === "not-found");
}

export interface GroundingBaselineComparison {
  baseline: number;
  current: number;
  delta: number;
  drifted: boolean;
}

function lineContaining(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

function fileExists(value: string, files: Set<string>): boolean {
  return files.has(value) || [...files].some((file) => file.endsWith(`/${value}`));
}

/**
 * Hold prose against an index rebuilt from a target's current working tree.
 * Dotted symbol claims deliberately use name-level matching, matching the map's
 * current reference precision rather than pretending to resolve ownership.
 */
export function checkGrounding(text: string, index: RepoIndex): GroundingReport {
  const files = new Set(index.files);
  const symbols = new Set(index.symbols.map((symbol) => symbol.name));
  const claims: GroundingClaim[] = [];
  const seen = new Set<string>();

  const recordGroundingClaim = (value: string, kind: GroundingClaim["kind"], at: number, exists: boolean) => {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    const proposed = !exists && CREATION_PATTERN.test(lineContaining(text, at));
    claims.push({ value, kind, verdict: exists ? "verified" : proposed ? "proposed" : "not-found" });
  };

  for (const match of text.matchAll(FILE_PATTERN)) {
    const value = match[0].replace(/^[./]+/, "").replace(/[.,;:)]+$/, "");
    const extension = value.slice(value.lastIndexOf(".")).toLowerCase();
    if (!CHECKABLE_EXTENSIONS.has(extension)) continue;
    recordGroundingClaim(value, "file", match.index, fileExists(value, files));
  }

  for (const match of text.matchAll(BACKTICK_PATTERN)) {
    const raw = match[1].trim();
    if (!IDENTIFIER_PATTERN.test(raw)) continue;
    if (raw.includes(".") && CHECKABLE_EXTENSIONS.has(raw.slice(raw.lastIndexOf(".")).toLowerCase())) continue;
    const parts = raw.replace(/\(\)$/, "").split(".");
    recordGroundingClaim(raw, "symbol", match.index, parts.every((part) => symbols.has(part)));
  }

  const verified = claims.filter((claim) => claim.verdict === "verified").length;
  const notFound = claims.filter((claim) => claim.verdict === "not-found").length;
  const proposed = claims.filter((claim) => claim.verdict === "proposed").length;
  const checked = verified + notFound;

  return { claims, verified, notFound, proposed, checked, groundedRatio: checked === 0 ? 1 : verified / checked };
}

/**
 * Compare a current grounding result to the compile-time baseline. The baseline
 * retains checker blind spots such as framework vocabulary, so only a fall of
 * more than five percentage points asks the prose compiler to run again.
 */
export function compareGroundingBaseline(current: number, baseline: number): GroundingBaselineComparison {
  if (!Number.isFinite(current) || current < 0 || current > 1) throw new Error("current grounding ratio must be between 0 and 1");
  if (!Number.isFinite(baseline) || baseline < 0 || baseline > 1) throw new Error("baseline grounding ratio must be between 0 and 1");

  const rawDelta = baseline - current;
  const delta = Math.max(0, Number(rawDelta.toFixed(6)));
  return { baseline, current, delta, drifted: rawDelta - 0.05 > Number.EPSILON };
}
