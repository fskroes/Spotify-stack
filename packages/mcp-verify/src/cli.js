#!/usr/bin/env node
/**
 * CLI entry: `node cli.js [workspace-dir]`.
 * Prints the verify summary to stdout; exits 1 only when verification actually
 * failed. An inconclusive run (no verifiers exist here) is not a pass, but it
 * is not a failure either — it must not block, so it exits 0 and says so.
 * Used by the Stop hook and by CI as a standalone gate.
 */
import { runVerify } from "./verify.js";

const cwd = process.argv[2] ?? process.cwd();
const result = await runVerify(cwd);
console.log(result.summary);
process.exit(result.state === "failed" ? 1 : 0);
