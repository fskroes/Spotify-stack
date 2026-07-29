/**
 * The judge's read capability — one declaration, one reader, no transport.
 *
 * ADR-0011: a judge may ground its verdict in the target's source rather than
 * only in its own prompt, but every read goes through a tool the runner
 * implements and roots at the run's workspace. The capability fork that ADR
 * ends was two transports carrying different powers under one name, so this
 * module's job is to make divergence impossible rather than merely
 * discouraged: {@link JUDGE_READ_TOOLS} is *the* surface, and an adapter that
 * wants to add, rename, or reshape a tool has to edit the array — which moves
 * both transports in the same commit.
 *
 * Plain JS with no build step, like `@fleet/mcp-verify`: this is imported by
 * TypeScript (`@fleet/judge`) and executed by node (the MCP server).
 */
import { createReadStream, readFileSync, realpathSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * ADR-0007 kept transcripts out of the per-run archive for being large and
 * outside the review contract. A read tool that can pull a 50 MB file into a
 * verdict prompt is that problem arriving by a different door, so a read is
 * capped — and a call budget bounds how many times the judge may try, which
 * also keeps the path list a human sees at co-sign legible.
 *
 * Knobs, not decisions: tune them on evidence from real runs.
 *
 * The per-read size cap and the call budget below are the values the spec
 * fixed so the build would not have to invent them. The match cap is an
 * invention, and says so: a search can match every file in a large workspace,
 * and an unbounded list of paths is the same oversized prompt the read cap
 * exists to prevent. It is not the spec's number and should not be read as one.
 */
const MAX_BYTES_PER_READ = 256 * 1024;
const MAX_MATCHES_PER_FIND = 200;

/**
 * How many tool calls one judge invocation may make.
 *
 * Exported, alone among the three, because a transport that runs its own
 * conversation has to bound that conversation and the only honest bound is
 * this number: a loop capped below it would cut off a judge spending its
 * budget one call per turn, and a loop capped at nothing would spin forever on
 * a judge that keeps calling after the budget refuses it.
 */
export const JUDGE_READ_MAX_CALLS = 40;

/**
 * @typedef {object} JudgeReadTool
 * @property {string} name
 * @property {string} description  Model-facing, and part of the surface: two
 *   judges told different things about the same tool are two different
 *   reviewers, which is the condition ADR-0011 exists to end.
 * @property {Record<string, any>} inputSchema  JSON Schema — the shape MCP puts
 *   on the wire and the shape the Anthropic API takes as `input_schema`, so
 *   neither transport has to translate the declaration into its own dialect.
 */

/**
 * The tools, with the code that runs them attached.
 *
 * Declaration and executor in one literal so a tool cannot exist on the wire
 * without an implementation, or the reverse. The exported surface is this array
 * with the handlers stripped — see {@link JUDGE_READ_TOOLS}.
 *
 * Deliberately absent from v1: grep (defensible, but not needed for the catch
 * class ADR-0011 protects) and anything that writes (a cage widening, which
 * needs its own ADR).
 */
const TOOLS = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace under review. `path` is " +
      "relative to the workspace root; paths outside it are refused. Use " +
      "`offset` (1-based first line) and `limit` (number of lines) to read " +
      "part of a large file. Read the source when the diff makes a claim the " +
      "task and the diff alone cannot settle.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path to the file." },
        offset: { type: "integer", minimum: 1, description: "1-based line to start at. Defaults to the first line." },
        limit: { type: "integer", minimum: 1, description: "How many lines to return. Defaults to as many as fit." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: readFileTool,
  },
  {
    name: "find",
    description:
      "List workspace files matching a glob pattern, relative to the " +
      "workspace root. Supports `*` (within one path segment), `**` (any " +
      "depth), and `?`. Use this to locate a file the diff does not name — " +
      "for example the build script or manifest that would have to list a " +
      "file the diff adds. This search does not descend into `.git` or " +
      "`node_modules`, though a file inside either can still be read by path.",
    inputSchema: {
      type: "object",
      properties: {
        glob: { type: "string", description: "Workspace-relative glob, e.g. `**/*.json` or `src/**/index.*`." },
      },
      required: ["glob"],
      additionalProperties: false,
    },
    handler: findTool,
  },
];

/**
 * The single declaration of the judge's tool surface: what both transports show
 * the judge, and nothing else. Frozen, and free of handlers — a function on a
 * tool entry does not survive either wire.
 *
 * @type {readonly JudgeReadTool[]}
 */
export const JUDGE_READ_TOOLS = deepFreeze(
  TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
);

/**
 * The name the read capability answers to when it travels as an MCP server:
 * the key under `mcpServers` in the config the runner writes, and therefore the
 * prefix Claude Code puts on the tool names it exposes to the judge
 * (`mcp__judge__…`). One constant because those two must agree — a config key
 * and an allowlist entry that drift apart produce a judge holding tools it is
 * not permitted to call, which looks exactly like a judge that chose not to
 * read.
 */
export const JUDGE_READ_SERVER_NAME = "judge";

/**
 * The environment variable the MCP server takes its root from.
 *
 * Declared here rather than in the server so the writer of the config and its
 * reader name the same key, and so a caller can wire the server without
 * importing a module that drags in an MCP transport.
 *
 * Env rather than the server's working directory, for the reason
 * `VERIFY_CWD` exists: it is read once at launch, before the judge's session
 * begins, so nothing that happens during the review can redirect where the
 * reads land.
 */
export const JUDGE_READ_WORKSPACE_ENV = "JUDGE_READ_WORKSPACE";

/**
 * The environment variable naming the file the MCP server writes the moment it
 * is able to serve reads.
 *
 * The marker exists because a handshake proves the server *can* launch, not
 * that the judge's process actually wired it — and a broken read tool and a
 * diff that genuinely needed no reads both record zero reads (ADR-0011). So
 * detection has to be positive, and this is the half of it that only a real
 * launch can satisfy: a verdict that read nothing cannot write this file, and
 * a server that never started cannot either.
 *
 * Carried in the same env block as the root, for the same reason: read once at
 * launch, before the session it attests to begins.
 */
export const JUDGE_READ_MARKER_ENV = "JUDGE_READ_MARKER";

/**
 * The environment variable naming the file the MCP server records served reads
 * in — each served path written as {@link JUDGE_READ_JOURNAL_SEPARATOR}-
 * terminated text, appended as the read is served.
 *
 * A file, because this transport's reader lives in a subprocess the runner
 * cannot see into. The SDK transport needs none of this: it calls the reader
 * in-process and collects the same paths off the same {@link ReadResult}s. What
 * both produce is identical, and it has to be — a verdict's account of what was
 * read must not depend on which transport billed it (ADR-0011).
 *
 * Carried in the same env block as the root and the marker, and read once at
 * launch, for the reason they are.
 */
export const JUDGE_READ_JOURNAL_ENV = "JUDGE_READ_JOURNAL";

/**
 * What separates one recorded path from the next: a null byte.
 *
 * **Not a newline, and this is load-bearing.** A POSIX filename may contain any
 * byte but `/` and NUL — a newline included — so a newline-delimited journal
 * turns a directory named `"a\n"` into two records, `a` and `/b`, the second of
 * which is an *absolute* path that was never read. That would make
 * workspace-relativity a property of the file format on this transport, when
 * the whole point is that it is a property of the containment check (cage spec
 * §7.1, rule 3). NUL is the one byte a path cannot carry, so the round trip
 * cannot invent a record or split a real one.
 */
export const JUDGE_READ_JOURNAL_SEPARATOR = "\0";

/**
 * The paths a read server recorded, in the order it first served each — or
 * `undefined` when the journal could not be read at all.
 *
 * The distinction is the one the whole field turns on. An empty journal is a
 * *claim*: this judge held the read tools and opened nothing, which is safe to
 * say only because the server truncates the journal at startup and the runner
 * separately proves the server started (the marker, cage spec §6). A journal
 * that has gone missing or unreadable establishes nothing — and answering `[]`
 * for it would put that claim on a verdict that never earned it, which is the
 * absent-rendered-as-empty trap this field is written to avoid.
 *
 * @param {string} journalPath
 * @returns {string[] | undefined}
 */
export function judgeReadJournalPaths(journalPath) {
  let raw;
  try {
    raw = readFileSync(journalPath, "utf8");
  } catch {
    return undefined;
  }
  // Terminated, not separated: the trailing empty segment after the final
  // record is dropped along with any other empty one, and a path is never
  // trimmed — leading and trailing whitespace is as much a part of a filename
  // as any other character.
  return distinctReadPaths(raw.split(JUDGE_READ_JOURNAL_SEPARATOR).filter((entry) => entry !== ""));
}

/**
 * One entry per file, in first-read order.
 *
 * Both transports collect through here, because both hit the same repeat: the
 * reader's own truncation notice tells a judge to read on at the next offset,
 * so paging one large file is several calls on one path. What a reviewer weighs
 * at co-sign is which files the verdict rests on, not how many requests it took
 * to see them.
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
export function distinctReadPaths(paths) {
  return [...new Set(paths)];
}

/**
 * How the read server is started — command, arguments, environment — declared
 * once, here.
 *
 * Two callers spawn this server and they must not describe two different
 * processes: the judge's MCP config hands the launch to the `claude` CLI, and
 * the runner's pre-flight handshake performs it itself before spending a token
 * on a judge whose reader may not come up (cage spec §6). A handshake against a
 * server configured differently from the judge's proves nothing about the
 * judge's, so neither caller builds this object.
 *
 * The command is this process's own executable rather than the string `node`.
 * The agent's config can afford the bare name because it is written for a
 * workspace the runner controls; the judge inherits the operator's environment,
 * and whatever `node` resolves to on their PATH is not necessarily the runtime
 * running the fleet.
 *
 * All three arguments are required. A launch missing its root is a judge
 * reading somewhere nobody chose; a launch missing its marker is a judge whose
 * reads cannot be proven to have been possible; a launch missing its journal is
 * a judge whose reads are served and then not accounted for, which puts a
 * verdict on the record with no way to tell what it rests on. An optional field
 * a caller forgets is how all three arrive quietly.
 *
 * @param {{ workspace: string, markerPath: string, journalPath: string }} where
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
export function judgeReadServerLaunch({ workspace, markerPath, journalPath }) {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.js", import.meta.url))],
    env: {
      [JUDGE_READ_WORKSPACE_ENV]: workspace,
      [JUDGE_READ_MARKER_ENV]: markerPath,
      [JUDGE_READ_JOURNAL_ENV]: journalPath,
    },
  };
}

/**
 * A tool's answer, in the shape both transports carry: MCP returns it as a
 * text content block with `isError`, and the SDK loop as a `tool_result`.
 *
 * `path` is the exception — it never reaches the judge. It is what the runner
 * records about the read it just served (cage spec §7.1), and it is produced
 * here because here is the only place that knows what was actually opened: the
 * resolved target, relative to the root it was proven to be inside. A path
 * taken from the judge's own input instead could be absolute, could point
 * through a symlink at something else, and could be a claim about a read that
 * never happened.
 *
 * @typedef {object} ReadResult
 * @property {string} text
 * @property {boolean} isError
 * @property {string} [path]  Workspace-relative path of the file this call
 *   served. Absent on a refusal (nothing was served) and on a search (nothing
 *   was opened).
 */

/**
 * The judge's reader, rooted at `workspace` and unable to leave it.
 *
 * The root is resolved once, here, and closed over: a reader cannot be pointed
 * somewhere else later, and every read in the system goes through one of these.
 * Throws if the workspace does not exist — a reader with no root is a judge
 * that will review blind, and ADR-0011 mandates that fail the run rather than
 * degrade quietly.
 *
 * One reader is one judge invocation: the call budget is spent per reader, so
 * constructing one per verdict is what keeps the budget meaningful.
 *
 * @param {string} workspace  The run's workspace directory
 * @param {{ maxBytes?: number, maxReads?: number, maxMatches?: number }} [limits]
 *   The caps are knobs rather than decisions — overridable so they can be tuned
 *   on evidence (and driven hard in tests) without the defaults ceasing to be
 *   the policy.
 * @returns {(name: string, input: Record<string, unknown>) => Promise<ReadResult>}
 */
export function createRootedReader(workspace, limits = {}) {
  const root = realpathSync(workspace);
  const maxBytes = limits.maxBytes ?? MAX_BYTES_PER_READ;
  const maxReads = limits.maxReads ?? JUDGE_READ_MAX_CALLS;
  const maxMatches = limits.maxMatches ?? MAX_MATCHES_PER_FIND;
  let spent = 0;

  return async function read(name, input) {
    // Charged before dispatch, so a refused path and an unknown tool cost the
    // same as a served read. Otherwise a judge that only ever asks for things
    // it may not have gets unbounded attempts at finding one that lands.
    if (spent >= maxReads) {
      return refusal(
        `read budget spent: this judge invocation may make at most ${maxReads} tool calls, ` +
          "and no further reads will be served. Decide on what you have already read.",
      );
    }
    spent += 1;

    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      // Names the surface it does have rather than a bare refusal: the judge
      // gets one chance to correct itself, and the list is derived, not typed
      // out a second time.
      return refusal(`no such tool "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}.`);
    }
    return tool.handler({ root, maxBytes, maxMatches }, input ?? {});
  };
}

/**
 * @typedef {object} ReadContext
 * @property {string} root      Resolved workspace root; every path lands inside it
 * @property {number} maxBytes  Per-call cap on the text handed back
 * @property {number} maxMatches  Per-call cap on how many paths a search lists
 */

/**
 * @param {ReadContext} ctx
 * @param {Record<string, unknown>} input
 * @returns {Promise<ReadResult>}
 */
async function readFileTool(ctx, input) {
  const resolved = await resolveInsideRoot(ctx.root, input.path);
  if (!("target" in resolved)) return resolved;
  const { target, served } = resolved;
  // What the judge asked for, echoed in its own words: a message about
  // `src/../src/index.ts` that answers about `src/index.ts` reads as an answer
  // to a different question. The *recorded* path is `served`, which is the file.
  const rel = String(input.path);

  const offset = positiveInteger(input.offset, 1);
  const limit = positiveInteger(input.limit, Number.POSITIVE_INFINITY);
  if (offset === null || limit === null) {
    return refusal("offset and limit, when given, must be positive whole numbers.");
  }

  try {
    if ((await stat(target)).isDirectory()) {
      return refusal(`"${rel}" is a directory, not a file. Use "find" to list what is inside it.`);
    }
  } catch {
    return refusal(`cannot read "${rel}": no readable file at that path in the workspace.`);
  }

  try {
    const result = renderWindow(await readWindow(target, { offset, limit, maxBytes: ctx.maxBytes }), rel, offset);
    // Only what was served. A window that came back as a refusal — a binary
    // file, an offset past the end — disclosed nothing, and recording it would
    // put a file on the verdict that the judge never saw a line of.
    return result.isError ? result : { ...result, path: served };
  } catch {
    // Unreadable for a reason `stat` could not see: a permission the runner
    // does not hold, or a file that changed under the read.
    return refusal(`cannot read "${rel}": the file could not be opened.`);
  }
}

/**
 * Read at most `limit` lines starting at `offset`, and at most `maxBytes` of
 * text, streaming: the cap has to hold for a file far larger than memory, which
 * is the case it exists for.
 *
 * @param {string} target
 * @param {{ offset: number, limit: number, maxBytes: number }} window
 * @returns {Promise<{ lines: string[], totalScanned: number, truncatedByBytes: boolean, moreLines: boolean, binary: boolean }>}
 */
async function readWindow(target, { offset, limit, maxBytes }) {
  const stream = createReadStream(target, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  /** @type {string[]} */
  const lines = [];
  let scanned = 0;
  let bytes = 0;
  let truncatedByBytes = false;
  let moreLines = false;
  let binary = false;
  try {
    for await (const line of reader) {
      // A utf8 decode never throws — it substitutes U+FFFD — so a binary file
      // would otherwise come back as mojibake the judge believes is source. A
      // null byte is the cheap tell, checked on the way past.
      if (line.includes("\0")) {
        binary = true;
        break;
      }
      scanned += 1;
      if (scanned < offset) continue;
      if (lines.length >= limit) {
        moreLines = true;
        break;
      }
      const size = Buffer.byteLength(line, "utf8") + 1;
      if (bytes + size > maxBytes) {
        truncatedByBytes = true;
        break;
      }
      lines.push(line);
      bytes += size;
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return { lines, totalScanned: scanned, truncatedByBytes, moreLines, binary };
}

/**
 * Turn a window into the text the judge sees. Every way of returning less than
 * the whole file says so in that text: a judge reasoning about a file it
 * believes it read in full is a confident verdict about content it never saw.
 *
 * @param {Awaited<ReturnType<typeof readWindow>>} window
 * @param {string} rel
 * @param {number} offset
 * @returns {ReadResult}
 */
function renderWindow(window, rel, offset) {
  const { lines, totalScanned, truncatedByBytes, moreLines, binary } = window;
  if (binary) return refusal(`"${rel}" is not UTF-8 text; this tool reads text files only.`);
  if (lines.length === 0) {
    if (totalScanned === 0) return { text: `"${rel}" is empty.`, isError: false };
    if (offset > totalScanned) {
      return refusal(`offset ${offset} is past the end of "${rel}", which has ${totalScanned} lines.`);
    }
    // One line longer than the whole per-read cap: nothing to hand back, and
    // saying "empty" would be a lie about a file that is anything but.
    return refusal(`the first line of "${rel}" at offset ${offset} is larger than a single read may return.`);
  }

  const last = offset + lines.length - 1;
  const notice = truncatedByBytes
    ? `\n\n[truncated at the per-read size cap: lines ${offset}–${last} of "${rel}". Read on with offset ${last + 1}.]`
    : moreLines
      ? `\n\n[lines ${offset}–${last} of "${rel}"; more lines follow. Read on with offset ${last + 1}.]`
      : "";
  return { text: lines.join("\n") + notice, isError: false };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number | null}  null when the input was given but unusable
 */
function positiveInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * List workspace files matching a glob.
 *
 * Containment here is structural rather than checked per result: the walk
 * starts at the root, never descends through a symlinked directory, and yields
 * paths relative to the root — so there is no path it can produce that is
 * outside. What it does *not* do is decide what may be opened; a matched
 * symlink pointing out of the workspace is listed, and refused by the root
 * check when the judge tries to read it. One escape, refused in one place.
 *
 * @param {ReadContext} ctx
 * @param {Record<string, unknown>} input
 * @returns {Promise<ReadResult>}
 */
async function findTool(ctx, input) {
  const glob = input.glob;
  const unusable = refuseUnusableInput("glob", glob);
  if (unusable) return unusable;
  // `..` never means anything useful in a pattern rooted at the workspace, and
  // refusing it outright is clearer to the judge than silently matching nothing.
  // `read_file` has no equivalent rule: there, `..` is resolved and then
  // contained, because a path that only escapes after normalisation has to be
  // caught by the root check rather than by inspecting its text.
  if (String(glob).split("/").includes("..")) {
    return refusal("glob may not step outside the workspace; patterns are rooted at the workspace directory.");
  }

  const pattern = globToRegExp(String(glob));
  /** @type {string[]} */
  const matches = [];
  let capped = false;

  /** @param {string} dir  Directory to walk, relative to the root ("" is the root itself) */
  async function walk(dir) {
    if (capped) return;
    const entries = await readdir(path.join(ctx.root, dir), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (capped) return;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      // A symlinked directory is not followed: it is the one way a walk rooted
      // at the workspace could produce a path that is not in it.
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(rel);
        continue;
      }
      if (!pattern.test(rel)) continue;
      if (matches.length >= ctx.maxMatches) {
        capped = true;
        return;
      }
      matches.push(rel);
    }
  }

  try {
    await walk("");
  } catch {
    return refusal(`could not list the workspace for pattern "${glob}".`);
  }

  // Every line that is not a path is bracketed, so a reader — model or human —
  // can tell the answer from the commentary about it.
  if (matches.length === 0) return { text: `[no files in the workspace match "${glob}".]`, isError: false };
  const notice = capped
    ? `\n\n[capped at ${ctx.maxMatches} matches; narrow the pattern to see the rest.]`
    : "";
  return { text: matches.join("\n") + notice, isError: false };
}

/**
 * Directories the walk never descends into. Neither is the target's source,
 * and `node_modules` is large enough to make every search slow for nothing.
 *
 * Unconditional, and said out loud in the tool's description rather than left
 * for the judge to infer from an empty result. An earlier version made the
 * skip conditional on the pattern mentioning the directory, which decided from
 * the pattern's raw text while matching decided from the compiled expression —
 * two answers to one question, which is the shape of bug this package exists
 * to avoid. Nothing here narrows what may be *read*: a path inside a skipped
 * directory still opens by name.
 */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/**
 * Translate a glob into an anchored regular expression over workspace-relative,
 * `/`-separated paths.
 *
 * Supports `**` (any depth, including none), `*` (within one segment), and `?`.
 * Everything else is a literal — no braces, no character classes: an
 * unsupported construct that silently means something else is worse for a
 * reviewer than a pattern that plainly matches nothing.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        source += "(?:[^/]*/)*"; // `**/` also matches zero directories
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Resolve a workspace-relative path to an absolute one **inside** the root, or
 * return the refusal to hand back to the judge.
 *
 * The order of the steps is the check. Rejecting absolute paths and null bytes
 * before touching the filesystem keeps the syscalls off inputs that are already
 * out of contract; resolving the *parent* rather than the target lets a missing
 * file be reported as missing (`realpath` throws on ENOENT); resolving the
 * target when it is a symlink catches the escape a naive check misses — a link
 * inside the workspace pointing out of it.
 *
 * Containment is `path.relative`, never `startsWith`: a string prefix test
 * admits `/workspaces/ws-evil` for a root of `/workspaces/ws`.
 *
 * Refusals never echo an absolute path. A refusal is prose the judge may quote
 * into a rationale, and a rationale is archived and shown to a human at
 * co-sign — a private target's directory layout does not belong there.
 *
 * The containment test also produces the recorded path, and that is not a
 * coincidence worth undoing: `inside` is `path.relative(root, resolved)` for a
 * target this function has just proven is under the root, so it cannot be
 * absolute and cannot begin with `..` — the two ways a recorded path could say
 * something about a private target's directory layout. Deriving it anywhere
 * else would make that a convention instead of a consequence.
 *
 * @param {string} root
 * @param {unknown} rel
 * @returns {Promise<{ target: string, served: string } | ReadResult>}
 *   The absolute path to open and the workspace-relative path to record, or the
 *   refusal to hand back to the judge.
 */
async function resolveInsideRoot(root, rel) {
  const unusable = refuseUnusableInput("path", rel);
  if (unusable) return unusable;
  rel = String(rel);

  const requested = path.resolve(root, rel);
  let resolved;
  try {
    resolved = path.join(await realpath(path.dirname(requested)), path.basename(requested));
    if ((await lstat(resolved)).isSymbolicLink()) resolved = await realpath(resolved);
  } catch {
    return refusal(`cannot read "${rel}": no such file in the workspace.`);
  }

  const inside = path.relative(root, resolved);
  if (inside === "" || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    return refusal(
      `"${rel}" resolves outside the workspace and was refused. ` +
        "Every path this tool reads is relative to the workspace under review.",
    );
  }
  // `/`-separated, like the paths `find` lists: one spelling on the record,
  // whichever platform produced it.
  return { target: resolved, served: inside.split(path.sep).join("/") };
}

/**
 * The rules every workspace-relative input shares, in the order the root check
 * needs them: refuse before any syscall touches an input that is already out of
 * contract. Both tools take one, so both ask here — two ladders saying the same
 * thing are two ladders that stop saying the same thing.
 *
 * @param {"path" | "glob"} what
 * @param {unknown} value
 * @returns {ReadResult | null}  null when the input is usable
 */
function refuseUnusableInput(what, value) {
  if (typeof value !== "string" || value === "") {
    return refusal(`${what} is required, and must be a workspace-relative string.`);
  }
  // Never echoed back: a null byte truncates the path below the check, and an
  // absolute path is the one input whose text is worth keeping out of a
  // rationale a human reads at co-sign.
  if (value.includes("\0")) return refusal(`${what} contains a null byte and was refused.`);
  if (path.isAbsolute(value)) {
    return refusal(`${what} must be relative to the workspace root; absolute ${what}s are refused.`);
  }
  return null;
}

/**
 * A no the judge is meant to read and act on, not a failure to route around —
 * the [refusal](../../../CONTEXT.md#refusal) shape, carried on `isError`
 * because that is what both transports put a tool's no on.
 *
 * @param {string} message
 * @returns {ReadResult}
 */
function refusal(message) {
  return { text: message, isError: true };
}

/**
 * Freeze an object and everything reachable from it. A shallow freeze would
 * leave an adapter free to edit a description or a schema in passing, which is
 * exactly the drift the single declaration exists to prevent.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(/** @type {any} */ (value)[key]);
  return value;
}
