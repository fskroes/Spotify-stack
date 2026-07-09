#!/usr/bin/env node
/* eslint-disable */
// (This file is injected into target-repo workspaces; the disable directive
// keeps it inert under whatever lint config the target repo uses.)
/**
 * Claude Code Stop hook — Spotify part 3: "Using Claude Code's stop hook, all
 * relevant verifiers run before pull requests open."
 *
 * When the agent tries to finish, run the deterministic verifiers. If they
 * fail, exit 2 with the summary on stderr — Claude Code feeds that back to
 * the agent and the session continues. A bounded attempt counter prevents
 * infinite block loops on unfixable failures.
 *
 * The runner replaces __CONTROL_REPO__ and __WORKSPACE__ with absolute paths.
 */
import { execFile } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const CONTROL_REPO = "__CONTROL_REPO__";
const WORKSPACE = "__WORKSPACE__";
const MAX_BLOCKS = 3;

// Read the hook payload from stdin (not strictly needed beyond being a good
// citizen — the attempt counter, not stop_hook_active, bounds our loop, so
// verification is enforced on every stop attempt).
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
try {
  JSON.parse(raw);
} catch {
  /* tolerate empty/invalid payloads */
}

const counterFile = path.join(WORKSPACE, ".claude", ".stop-verify-attempts");
function attempts() {
  try {
    return Number(readFileSync(counterFile, "utf8")) || 0;
  } catch {
    return 0;
  }
}

try {
  await promisify(execFile)(
    "node",
    [path.join(CONTROL_REPO, "packages", "mcp-verify", "src", "cli.js"), WORKSPACE],
    { maxBuffer: 32 * 1024 * 1024, timeout: 9 * 60 * 1000 },
  );
  // Green: allow the stop and reset the counter.
  try {
    unlinkSync(counterFile);
  } catch {
    /* ignore */
  }
  process.exit(0);
} catch (err) {
  const n = attempts() + 1;
  if (n > MAX_BLOCKS) {
    // Give up blocking — the runner's belt-and-braces verify will still fail
    // the run and prevent a PR.
    console.error(`stop-verify: still failing after ${MAX_BLOCKS} blocked stops; allowing stop.`);
    process.exit(0);
  }
  writeFileSync(counterFile, String(n));
  const summary = `${err.stdout ?? ""}`.trim() || `verify could not run: ${err.message}`;
  console.error(
    `Verification is failing — you must fix the problems below before finishing (attempt ${n}/${MAX_BLOCKS}).\n${summary}`,
  );
  process.exit(2);
}
