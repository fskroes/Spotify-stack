/**
 * Proving the judge can read, before and after it reviews.
 *
 * ADR-0011 mandates that a judge which cannot read fails the run rather than
 * degrading to a text-only review, and deliberately does not say how the runner
 * notices. The constraint it *does* state is the hard part: a broken read tool
 * and a diff that genuinely needed no reads both record zero reads, so
 * detection cannot be "did it read anything" — it has to be positive, and it
 * has to happen at launch.
 *
 * Two checks, because one leaves a real gap.
 *
 * {@link preflightJudgeRead} starts the read server itself and asks what it
 * exposes. It costs no tokens, so the run can afford to do it before the agent
 * runs rather than before the judge does — the agent's tokens are model spend
 * too. Most of its value is the launch: a server that cannot come up here
 * cannot come up for the judge either. The surface comparison on top of that is
 * narrower than it looks, and worth being honest about — the spawned process
 * loads the same module this one imports, so the two agree unless they are not
 * the same module: a stale install, a half-applied edit, a second copy of
 * `@fleet/judge-read` resolved from somewhere else. That is a real failure and
 * a rare one, and it is the only thing this comparison catches.
 *
 * {@link assertJudgeReadStartupMarker} closes the gap the handshake leaves. A
 * handshake proves the server *can* launch; it says nothing about whether the
 * judge's own process wired it. So the server writes a marker when it comes up,
 * carrying the surface it came up with, and the runner asserts it afterwards.
 * Neither check can be satisfied by a verdict that simply read nothing.
 *
 * The marker is an attestation against accident, not against an adversary:
 * anything that can write that path could write its contents. What makes the
 * judge not that thing is its cage — it holds two read tools and no way to
 * write anywhere (ADR-0011). Validating the contents is what makes the check
 * mean "a process holding this build's read surface started" rather than
 * "something touched a file".
 *
 * Both are for the CLI transport alone. The SDK transport calls the reader
 * in-process — there is no subprocess that can fail to appear, an unavailable
 * reader is a throw, and `run.ts` already turns a throwing judge into
 * `engine-failed`. A handshake there could not fail, and a check that cannot
 * fail reads to the next person like a guarantee.
 *
 * Nothing thrown from here names a path. These messages become the run's
 * `resultText`, which reaches the ledger and the co-sign surface, and a private
 * target's directory layout does not belong in either.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { JUDGE_READ_SERVER_NAME, JUDGE_READ_TOOLS, judgeReadServerLaunch } from "@fleet/judge-read";

/**
 * How long the handshake waits on a server that started but says nothing.
 *
 * A backstop, not the usual path: a server that dies takes its stdio with it,
 * which rejects the pending request immediately. This bounds the one case that
 * would otherwise hang a run before it ever reached the judge.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * Start the judge's read server, ask it what tools it has, and shut it down —
 * failing the run if the answer is anything but the shared declaration.
 *
 * The server spawned here is the one the judge will get: same command, same
 * arguments, same environment, all from `judgeReadServerLaunch`. A handshake
 * against a server assembled locally would prove something about a process the
 * judge never runs.
 *
 * The one thing it deliberately does *not* share is the marker path. This
 * handshake writes to a throwaway of its own, because a handshake that wrote
 * the judge's marker would pre-satisfy the check that exists to catch a judge
 * whose server never started — the two checks would collapse into one, and the
 * gap the marker exists to close would reopen silently.
 *
 * @param opts.log  Where the server's own stderr goes when the handshake fails.
 *   The console, never the record: a crashing server reports paths, and the
 *   thrown error below is what gets archived.
 */
export async function preflightJudgeRead(opts: { workspace: string; log?: (line: string) => void }): Promise<void> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "judge-read-preflight-"));
  try {
    const launch = judgeReadServerLaunch({ workspace: opts.workspace, markerPath: path.join(scratch, "startup.json") });
    const transport = new StdioClientTransport({ ...launch, stderr: "pipe" });
    // Attached before connect: the transport hands back a stream immediately so
    // that a server which dies during startup — the case worth diagnosing — does
    // not lose the sentence explaining why.
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: "fleet-runner-preflight", version: "0.1.0" });

    let advertised: unknown[];
    try {
      await client.connect(transport, { timeout: HANDSHAKE_TIMEOUT_MS });
      advertised = (await client.listTools(undefined, { timeout: HANDSHAKE_TIMEOUT_MS })).tools;
    } catch (error) {
      if (stderr.trim() !== "") opts.log?.(`⚠ judge read server stderr: ${stderr.trim()}`);
      throw new Error(
        "the judge's read server did not complete a pre-flight handshake, so this run cannot give the judge " +
          "the workspace it is supposed to review. Failing before the judge is called rather than reviewing blind " +
          `(${error instanceof Error ? error.message : String(error)}).`,
      );
    } finally {
      // Best-effort: the handshake's verdict is already decided, and a server
      // that will not shut down cleanly must not turn a passing check into a
      // failed run.
      await client.close().catch(() => {});
    }

    assertJudgeReadSurface(advertised);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The half of the handshake that is a judgement rather than a subprocess: what
 * a live server said it has, against what this build declares.
 *
 * Whole tools, not their names. A description is what tells the judge when to
 * reach for a tool, and a schema is what it may pass — so a second copy of the
 * module that renamed nothing but reworded a description is still two
 * reviewers, which is the condition ADR-0011 ends. Names alone would let that
 * through, and the divergent-copy case is the only one this comparison can
 * catch at all.
 *
 * Order is not part of the surface, so the comparison sorts. This is *not* the
 * §8 invariant that holds the two transports' surfaces against each other —
 * that one needs both adapters and lives outside this package, in
 * `test/judge-tool-surface.test.ts`. This check runs against a live server on
 * every run; that one runs in CI and proves neither adapter restates the
 * declaration. Neither substitutes for the other.
 */
export function assertJudgeReadSurface(advertised: unknown[]): void {
  /** Only the three fields the declaration owns: MCP fills in others. */
  const surface = (tools: unknown[]): string =>
    JSON.stringify(
      tools
        .map((tool) => tool as { name?: unknown; description?: unknown; inputSchema?: unknown })
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
        .sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1)),
    );

  if (surface(advertised) === surface([...JUDGE_READ_TOOLS])) return;
  // Names only in the message, never the schemas: this reaches the ledger, and
  // a wall of JSON there tells a reader nothing the names do not.
  throw new Error(
    "the judge's read server exposes a different tool surface than the one this build declares: " +
      `it offered [${toolNames(advertised).sort().join(", ")}] where ` +
      `[${JUDGE_READ_TOOLS.map((tool) => tool.name).sort().join(", ")}] was expected, or described the same names ` +
      "differently. A judge holding tools nobody declared, or told something other than what this build says " +
      "about them, is not the reviewer this run records.",
  );
}

/** Tool names out of an unvalidated `tools/list` answer, for a message. */
function toolNames(tools: unknown[]): string[] {
  return tools.map((tool) => String((tool as { name?: unknown } | null)?.name));
}

/**
 * Assert that the read server the judge was handed actually started, and came
 * up holding this build's read surface.
 *
 * Called after the judge returns, and the *only* check that can tell the two
 * zero-read runs apart: a judge whose diff needed no reads leaves this marker
 * behind, and a judge whose server never launched cannot.
 *
 * The contents are checked, not merely the file's existence. A file that exists
 * says "something wrote this path"; a file naming the server and listing the
 * tools it started with says "a process holding this build's declaration came
 * up". The second is what the run is entitled to assume afterwards, and the
 * distance between the two is the whole reason to look inside.
 *
 * Not the unmet-gate treatment, which ships the run and shouts. A gate is an
 * author's assertion about a target; the judge's read capability is a system
 * invariant nobody declares, so this throws and the run dies as
 * `engine-failed` (ADR-0011).
 */
export function assertJudgeReadStartupMarker(markerPath: string): void {
  const refuse = (why: string): never => {
    throw new Error(
      `${why}: this verdict was reached without a read server that this build can account for, whatever the ` +
        "verdict says about what it read. The run fails rather than recording a text-only review under a name " +
        "that claims otherwise.",
    );
  };

  let marker: { server?: unknown; tools?: unknown };
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    // One answer for absent and for unreadable. A marker nobody can parse
    // attests to as much as a marker nobody wrote.
    return refuse("the judge's read server left no readable startup marker, so it never ran");
  }

  if (marker?.server !== JUDGE_READ_SERVER_NAME) {
    refuse("the judge's startup marker was not written by the judge's read server");
  }
  const started = Array.isArray(marker.tools) ? marker.tools.map(String) : [];
  const declared = JUDGE_READ_TOOLS.map((tool) => tool.name);
  if (started.length !== declared.length || !declared.every((name) => started.includes(name))) {
    refuse(
      `the judge's read server started with [${started.sort().join(", ")}] where [${declared.sort().join(", ")}] was expected`,
    );
  }
}
