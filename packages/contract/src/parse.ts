/**
 * Parsing at the seam — the only place wire bytes become trusted values.
 *
 * zod is an implementation detail of this package: nothing outside it should
 * ever catch a ZodError. Every failure surfaces as a WireParseError carrying
 * the endpoint (when known) and a dotted field path, pre-formatted for the
 * operator's error banner.
 *
 * The two transport postures live here too:
 *  - parseLedgerJsonl — JSONL posture: keep every good line, lose only the bad
 *    one, never throw. The ledger is append-only and historical; one corrupt
 *    line must not brick a report.
 *  - parseCosignStdout — SSH-stdout posture: find the one real record among
 *    banners and lifecycle noise, scanning from the end. Noise is expected
 *    there, not corruption, so it is skipped silently.
 */
import { z } from "zod";
import { CosignResultSchema, LedgerEntrySchema, type CosignResult, type LedgerEntry } from "./schemas.js";

export interface WireIssue {
  /** Dotted path with bracketed indices ("entries[3].timings.agentMs"); "" = the root value. */
  path: string;
  message: string;
}

export class WireParseError extends Error {
  readonly endpoint?: string;
  readonly issues: readonly WireIssue[];

  constructor(issues: readonly WireIssue[], endpoint?: string) {
    const first = issues[0];
    const head = first ? `${first.path ? `${first.path}: ` : ""}${first.message}` : "failed to parse";
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
    super(`${endpoint ?? "wire value"} — ${head}${more}`);
    this.name = "WireParseError";
    this.endpoint = endpoint;
    this.issues = issues;
  }
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function toWireIssues(error: z.ZodError): WireIssue[] {
  return error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message }));
}

export type WireResult<T> = { ok: true; value: T } | { ok: false; error: WireParseError };

/** Validate one wire value; returns the failure instead of throwing. */
export function safeParseWire<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context?: { endpoint?: string },
): WireResult<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: new WireParseError(toWireIssues(result.error), context?.endpoint) };
}

/** Validate one wire value; throws WireParseError on failure. */
export function parseWire<T>(schema: z.ZodType<T>, value: unknown, context?: { endpoint?: string }): T {
  const result = safeParseWire(schema, value, context);
  if (!result.ok) throw result.error;
  return result.value;
}

export interface SkippedLine {
  /** 1-based line number in the original text. */
  line: number;
  raw: string;
  issues: WireIssue[];
}

/**
 * Parse ledger JSONL text (a file's contents, or `git show` of a committed
 * copy). Never throws: a line that is not JSON, or is JSON that fails the
 * schema, lands in `skipped` (with its line number and issues) and the other
 * lines are unaffected. Order is preserved; blank lines are skipped silently.
 */
export function parseLedgerJsonl(text: string): { entries: LedgerEntry[]; skipped: SkippedLine[] } {
  const entries: LedgerEntry[] = [];
  const skipped: SkippedLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      skipped.push({ line: i + 1, raw, issues: [{ path: "", message: `invalid JSON: ${(err as Error).message}` }] });
      continue;
    }
    const result = safeParseWire(LedgerEntrySchema, value);
    if (result.ok) entries.push(result.value);
    else skipped.push({ line: i + 1, raw, issues: [...result.error.issues] });
  }
  return { entries, skipped };
}

/**
 * The last line of `output` that parses as JSON *and* satisfies the co-sign
 * result schema, scanning from the end. Null if none does — never throws.
 * Non-JSON lines (shell banners, pnpm output, hook-leaked stdout) are expected
 * noise on this transport and are skipped silently.
 */
export function parseCosignStdout(output: string): CosignResult | null {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = CosignResultSchema.safeParse(value);
    if (result.success) return result.data;
  }
  return null;
}
