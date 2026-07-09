#!/usr/bin/env node
/**
 * CLI entry: `node cli.js [workspace-dir]`.
 * Prints the verify summary to stdout; exits 1 when verification fails.
 * Used by the Stop hook and by CI as a standalone gate.
 */
import { runVerify } from "./verify.js";

const cwd = process.argv[2] ?? process.cwd();
const result = await runVerify(cwd);
console.log(result.summary);
process.exit(result.ok ? 0 : 1);
