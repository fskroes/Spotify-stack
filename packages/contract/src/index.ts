/**
 * @fleet/contract — the wire contract: the shapes the fleet writes down and
 * reads back (the append-only ledger, the in-flight store, and the co-sign
 * result emitted as a JSON line).
 *
 * One source of truth: the zod schemas here are the only declaration of these
 * shapes; every reader parses through them. Pure — no I/O, no Node imports, no
 * dependency but zod.
 *
 * The tolerant reader ([ADR-0001](../../../docs/adr/0001-tolerant-reader-wire-contract.md))
 * no longer spans two machines at different commits — it spans time. The ledger
 * is append-only, so today's reader must still parse rows written by every past
 * version of the runner, including fields nothing produces any more.
 *
 * Primary surface: the inferred types, `parseLedgerJsonl`, `parseCosignStdout`,
 * `dedupeInflight`, and the known-value narrowing helpers. The raw schemas are
 * exported as a secondary surface for composition and round-trip tests.
 */
export * from "./schemas.js";
export * from "./parse.js";
export * from "./dedupe.js";
export * from "./producer-usage.js";
export * from "./cli-envelope.js";
