/**
 * The mechanical half of the #52 rubric. An answer (or a stored prose layer) is
 * held against what the repo actually contains at a pinned SHA: every file and
 * symbol it names either exists, is proposed as new, or is a fabrication.
 */
import type { Claim, GroundingReport, RepoIndex } from "./types.js";
import { supportedExtensions } from "./parse.js";

const CHECKABLE_EXTENSIONS = [...supportedExtensions, ".md", ".json", ".yaml", ".yml", ".plist", ".h", ".m"];

/** Paths, backticked or bare: a slash-or-extension token that ends in a known extension. */
const FILE_PATTERN = /[A-Za-z0-9_./+-]+\.[A-Za-z]{1,6}\b/g;
/** Code-shaped identifiers, only inside backticks — prose words are not claims. */
const BACKTICK_PATTERN = /`([^`\n]+)`/g;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?$/;
/** A line proposing new code is making a plan, not a claim about what exists. */
const CREATION_PATTERN = /\b(new|create|creates|creating|add|adds|adding|introduce|introduces|introducing)\b/i;

function lineContaining(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

/**
 * Mechanical half of the #52 rubric: does every file and symbol the answer
 * names actually exist at the target's pinned SHA? Claims the answer proposes
 * creating are reported separately rather than counted as fabrications.
 */
export function checkGrounding(answer: string, index: RepoIndex): GroundingReport {
  const claims: Claim[] = [];
  const seen = new Set<string>();

  const record = (value: string, kind: Claim["kind"], at: number, exists: boolean) => {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    const proposed = !exists && CREATION_PATTERN.test(lineContaining(answer, at));
    claims.push({ value, kind, verdict: exists ? "verified" : proposed ? "proposed" : "not-found" });
  };

  for (const match of answer.matchAll(FILE_PATTERN)) {
    const value = match[0].replace(/^[./]+/, "").replace(/[.,;:)]+$/, "");
    const ext = value.slice(value.lastIndexOf(".")).toLowerCase();
    if (!CHECKABLE_EXTENSIONS.includes(ext)) continue;
    const exists = index.files.has(value) || [...index.files].some((f) => f.endsWith(`/${value}`));
    record(value, "file", match.index, exists);
  }

  for (const match of answer.matchAll(BACKTICK_PATTERN)) {
    const raw = match[1].trim();
    if (!IDENTIFIER_PATTERN.test(raw)) continue;
    if (raw.includes(".") && CHECKABLE_EXTENSIONS.includes(raw.slice(raw.lastIndexOf(".")).toLowerCase())) continue;
    // `SyncService.runCycle()` is grounded when every hop of it is a known symbol.
    const parts = raw.replace(/\(\)$/, "").split(".");
    const exists = parts.every((part) => index.symbols.has(part));
    record(raw, "symbol", match.index, exists);
  }

  const verified = claims.filter((c) => c.verdict === "verified").length;
  const notFound = claims.filter((c) => c.verdict === "not-found").length;
  const proposed = claims.filter((c) => c.verdict === "proposed").length;
  const checked = verified + notFound;

  return { claims, verified, notFound, proposed, groundedRatio: checked === 0 ? 1 : verified / checked };
}
