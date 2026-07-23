/**
 * @fleet/contract — the wire contract: everything the runner tells the
 * operator, on any transport (the ledger server's HTTP responses, and the
 * co-sign result emitted as a JSON line over SSH stdout).
 *
 * One source of truth: the zod schemas here are the only declaration of these
 * shapes; the runner imports its types from this package and the operator
 * parses every response through it. Pure and browser-safe — no I/O, no Node
 * imports, no dependency but zod.
 *
 * Primary surface: `Endpoints`, the inferred types, `parseLedgerJsonl`,
 * `parseCosignStdout`, `dedupeInflight`, and the known-value narrowing
 * helpers. The raw schemas are exported as a secondary surface for
 * composition and round-trip tests.
 */
export * from "./schemas.js";
export * from "./parse.js";
export * from "./dedupe.js";
export * from "./endpoints.js";
export * from "./producer-usage.js";
export * from "./cli-envelope.js";
