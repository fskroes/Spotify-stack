# The judge's cage: build specification

Status: **spec** — the build handoff for [ADR-0011](./adr/0011-the-runner-owns-the-judges-reads.md).
Written 2026-07-29, before any of it existed, and not revised into agreement with
what was later built — [ADR-0011](./adr/0011-the-runner-owns-the-judges-reads.md)'s
Status section is where build state is recorded. What this document does gain is
answers: where a stage settled a question the spec left open, the answer is
recorded beneath the section that asked it, dated.

ADR-0011 is the source of truth for *what was decided and why*. This document
does not restate the decision or re-argue the rejected options; read the ADR
first. What follows is only the part the ADR deliberately left open: how to
build it.

## 1. What is being built

One read capability, implemented once by the runner, rooted at the run's
workspace, reachable by the judge over either transport and identical on both.
Everything else follows from "identical on both" — that is the invariant the
whole design serves, because the capability fork is what ADR-0011 exists to end.

Four things change:

| | |
|---|---|
| New | `packages/judge-read` — the tool declaration, the root check, the reader, and the MCP server that fronts them |
| Changed | `packages/judge` — `JudgeInput` gains a required `workspace`; both clients gain the tool surface |
| Changed | `packages/contract` — the verdict record gains runner-observed read paths and a judge capability |
| Changed | `packages/runner` — pre-flight handshake, `judgeName` carries capability, `engine-failed` on an unavailable tool |

## 2. The unknown that gates the build

**Can one Anthropic SDK request carry both `output_config.format` and `tools`?**

The SDK path enforces the verdict's shape through structured output
(`zodOutputFormat(VerdictSchema)` in `packages/judge/src/index.ts`), and
ADR-0011 gives up that enforcement for nothing — collapsing to one transport was
rejected precisely to keep it. Adding tools to that same request is therefore
load-bearing, and the documented compatibility list for structured outputs names
citations and prefilling as incompatible while saying nothing about tool use.
Unstated is not the same as supported.

**What the installed SDK's types already settle, at no cost**
(`@anthropic-ai/sdk@0.110.0`, checked 2026-07-29):

- `output_config` and `tools` are **sibling optional fields on the same
  `MessageCreateParamsBase`** — not a discriminated union, not mutually
  exclusive. `parse<Params extends MessageCreateParamsNonStreaming>` takes the
  whole parameter set, so passing both type-checks.
- `ParsedMessage.parsed_output` is `ParsedT | **null**`, and `ParsedContentBlock`
  passes non-text blocks — `tool_use` among them — through unparsed. The SDK
  therefore models "structured-output request that stopped on a tool call" as a
  *representable state*, not an error.

That makes the third branch below unlikely, but it does not close the question:
types describe what the client will send, not what the server will accept.

**The probe does not gate the build.** If the combination is rejected, the SDK
path runs its tool loop and then issues one final tool-free request carrying
`output_config` — which needs no capability beyond ordinary tool use, and so is
always available. What the probe buys is therefore one round trip per verdict,
not the feasibility of the design. Everything except the SDK transport can be
built before the answer arrives.

**One build hazard this uncovered.** `judgeWithEvidence` does
`VerdictSchema.safeParse(response.parsed_output)` and throws when it fails
(`packages/judge/src/index.ts`). A tool-use stop yields `parsed_output: null`,
so bolting the read tool onto the existing call unchanged turns **every verdict
where the judge actually reads something** into `engine-failed` — the tool would
appear to work, and the runs that used it would be the ones that died.

**A second consequence for the seam.** `JudgeClient`'s only method is `parse`,
which is single-shot and does not loop. The loop cannot live inside the client,
so either `JudgeClient` gains a second method or the loop wraps it. Decide this
in stage 4, and note that the CLI client implements the same interface — a
`parse` that must now also service tool calls is the point where the two
transports are most likely to quietly diverge again.

**Everything else needs one live probe:** a single `messages.create` against a
throwaway schema and a throwaway tool, no workspace, no judge prompt — the
cheapest possible question. It has three possible answers and the spec branches
on them:

- **Both accepted, structured output arrives on the final turn** → §6.2 as
  written.
- **Both accepted but structured output only on the tool-free turn** → the SDK
  path runs the tool loop first and issues one final tool-free request carrying
  `output_config`. Costs one extra round trip per verdict; changes nothing else.
- **Rejected outright** → the spec is blocked and ADR-0011 needs a supersession,
  not an edit. The fork would then be unclosable at equal capability without
  either downgrading verdict parsing or dropping the SDK path.

This is a real API call and therefore real spend. It needs a go-ahead.

### Answer (2026-07-29, issue #104): the first branch. Both accepted, structured output on the final turn.

Probed live against `claude-opus-4-8` at `max_tokens: 2048` and
`thinking: {type: "adaptive"}` — the judge's own configuration, read out of
`packages/judge/src/index.ts` by the probe rather than restated — on
`@anthropic-ai/sdk@0.110.0`. Two requests, ~$0.01. The throwaway probe and its
recorded result are in the git-ignored `artifacts/judge-probe/`.

| Request | Carried | `stop_reason` | `parsed_output` |
|---|---|---|---|
| 1 | `output_config.format` + `tools` | `tool_use` | `null` |
| 2 | tool result, both fields still on | `end_turn` | the schema-shaped object |

**So the SDK loop ends in the same request**, and §6.2 stands as written: no
final tool-free call, no extra round trip per verdict. The third branch is
closed — ADR-0011 needs no supersession on this point.

The result is only as good as the tool having actually been called, so the probe
made that a precondition rather than an assumption: the schema demanded a code
generated per run, available from nowhere but the tool, and the probe reports
`VOID` instead of a branch if no `tool_use` block appears. Request 2's parsed
output carried that code back. `tool_choice` was left at its default throughout,
because the judge never forces it and a forced call is a different request shape
than the one this answer has to transfer to.

**The build hazard above is now measured, not predicted.** Request 1 is exactly
the `parsed_output: null` that `judgeWithEvidence`'s `VerdictSchema.safeParse`
throws on. Bolting the read tool onto that call unchanged turns every verdict
where the judge actually reads something into `engine-failed`. The loop has to
consume the tool-use turn before anything parses a verdict out of it.

## 3. The read module: `packages/judge-read`

### 3.1 Why the boundary is here

The failure ADR-0011 ends is *two reviewers with different powers under one
name*. A design where each transport declares its own tools re-creates that
failure the first time someone edits one adapter — so the module's job is to
make divergence impossible rather than merely discouraged.

The mechanism: **one exported array is the tool surface, and neither adapter may
name a tool literally.** The MCP server registers by iterating it. The SDK
client passes it, mapped, as its `tools` parameter. Adding, renaming, or
reshaping a tool means editing the array, which changes both transports in the
same commit. This is the same shape `agent-config/mcp.json` and
`packages/mcp-verify` already use for the agent's cage — one declaration, one
executor, thin transport.

Named for what it owns, not how it travels: `mcp-judge-read` would encode one
transport into the name of the thing whose entire purpose is being
transport-independent.

Plain JS with no build step, like `packages/mcp-verify` — it is imported by
TypeScript (`packages/judge`) and executed as a node entry point (the MCP
server), and `mcp-verify` already proves that combination works in this
workspace.

### 3.2 Exports

```
packages/judge-read/
  package.json          @fleet/judge-read
  src/read.js           JUDGE_READ_TOOLS, createRootedReader — no MCP, no SDK
  src/server.js         MCP stdio server; iterates JUDGE_READ_TOOLS
```

- **`JUDGE_READ_TOOLS`** — frozen array of `{name, description, inputSchema}`.
  The single declaration. Descriptions are written for the model and are part of
  the surface: both transports must show the judge the same words, or the two
  reviewers differ in what they believe they can do.
- **`createRootedReader(workspace)`** → `(name, input) => Promise<{text, isError}>`.
  Closes over the resolved root. Every read in the system goes through it.

### 3.3 The tool surface, v1

Two tools:

| Tool | Input | Returns |
|---|---|---|
| `read_file` | `path` (workspace-relative), optional `offset`, `limit` | file text, or an error |
| `find` | `glob` (workspace-relative pattern) | matching paths, workspace-relative |

**`find` is not optional.** ADR-0011 rejected restricting reads to paths named in
the task or diff, on the ground that it reimposes text-only blindness one layer
down. A read-by-path-only surface reaches the same place by a different route:
the judge could then only open files it could already name, and the false green
the ADR was built on required *finding* a file the diff never mentions. Shipping
`read_file` alone would build the cage and keep the blindness.

Deliberately absent from v1: grep, and anything that writes. Content search is
defensible under "reads the workspace" but is not needed for the catch class
ADR-0011 protects; add it later with a measured reason. Any write capability is
a cage widening and needs its own ADR.

### 3.4 The root check

The check this spec's second invariant test exists to hold:

1. Resolve the workspace to its realpath once, at reader construction. Cache it.
2. Reject any input `path` that is absolute, or contains a null byte, before
   touching the filesystem.
3. Resolve the *parent* directory to its realpath (the target itself may not
   exist, and `realpath` throws on ENOENT).
4. If the target is a symlink, resolve it too — a symlink inside the workspace
   pointing out of it is the escape the naive check misses.
5. Contain by `path.relative(root, resolved)`: reject when the result is empty,
   starts with `..`, or is absolute. **Not** `startsWith(root)` — that admits
   `/workspaces/ws-evil` for a root of `/workspaces/ws`.

Two caps, set here so the build does not have to invent them:

- **256 KiB per read**, truncated with a notice in the returned text. ADR-0007
  excluded transcripts from the archive as large and outside the review
  contract; a read tool that can pull a 50 MB file into a verdict prompt is the
  same problem arriving by a different door.
- **40 reads per judge invocation**, after which the tool returns `isError`.
  Bounds cost and keeps the recorded path list legible to a human at co-sign.

Both are knobs, not decisions — tune them on evidence.

## 4. How the workspace reaches the judge

`judgeWithEvidence` currently takes `{taskMarkdown, diff, verifySummary}`. It
gains `workspace: string`, **required**.

Required, not optional, is the whole point. An optional field that a caller
forgets produces a judge with no root and therefore no reads — a silently
text-only reviewer recorded under a name that claims otherwise, which is
verbatim the condition ADR-0011 exists to end. Making it required moves that
from a runtime surprise to a compile error, the same "forced to be decided
about" shape `RUN_FACTS` uses with `satisfies` and `docs-drift.test.ts` uses
with its nav lock.

What it costs, since the ADR is right that a fourth field is not free:

- `packages/runner/src/run.ts` — one line. `workspace` is already in scope at
  both `judgeOnce` call sites.
- Every unit test constructing a `JudgeInput` now needs a directory. Most want a
  `mkdtemp` fixture; the stub judge modes ignore the field entirely.
- **The throwaway probes under `artifacts/judge-probe/` stop compiling.** They
  called the judge at its own seam with no workspace, which is exactly what made
  them cheap. Re-running them after the change is new spend, and the ADR's
  evidence does not depend on it — the recorded rows stand as written.

## 5. The two transports

### 5.1 CLI (`createCliJudgeClient`)

Today the CLI judge runs with every built-in tool and the runner's working
directory, which is the control repo. Four flag changes close that:

| Flag | Why |
|---|---|
| `--tools ""` | Removes every built-in tool, so the judge's only reach is what the runner hands it |
| `--mcp-config <path>` | The judge-read server, workspace filled in as `mcp-verify` does with `VERIFY_CWD` |
| `--strict-mcp-config` | Already passed. Stops being decoration the moment `--mcp-config` appears: it is now what keeps any other MCP configuration out |
| `--allowedTools mcp__judge__read_file mcp__judge__find` | The judge has no injected `.claude/settings.json`, unlike the agent, so nothing else grants the MCP tools |

`--tools ""` alone is the stopgap ADR-0011 rejected — it buys symmetry by giving
up the only catch class that matters. `--tools ""` *plus a rooted read server*
is not that stopgap; it is the cage. The flag that was the whole of the rejected
option is one component of the accepted one.

The first probe against this invocation must confirm two things the flags do not
guarantee on their own: that MCP tools are actually callable in `-p` mode
without a permission prompt, and that `--tools ""` does not also suppress MCP
tools. If a permission mode turns out to be required, prefer the narrowest that
works over `--dangerously-skip-permissions`, which would hand back everything
`--tools ""` just took away.

Two hardening items to check but not assume: `--setting-sources ""`, which would
stop the judge inheriting user and project settings from the operator's machine;
and the judge's `cwd`, which should be the workspace so a relative path in a
tool argument cannot mean something in the control repo. Neither is a fence on
its own — ADR-0011 rejected configuration-as-confinement for exactly that reason
— but neither should be left pointing at the control repo either.

#### Probe result, 2026-07-29 (#105)

Both questions above are answered by a run, not by reading: one `-p` invocation
carrying the exact flag set, against a two-file throwaway workspace, on
`--model sonnet` — 7.3s, one turn.

- **MCP tools are callable in `-p` mode with no permission prompt.**
  `--allowedTools mcp__judge__read_file mcp__judge__find` is sufficient on its
  own. **No permission mode was needed** — not the blanket skip, and not a
  narrower one either. The probe called both tools and returned the value of a
  constant it could only have obtained by opening the file.
- **`--tools ""` does not suppress MCP tools.** It removes the built-in set and
  leaves the MCP surface intact, which is the combination §5.1 depends on.

`--setting-sources ""` shipped, and is stronger than "hardening" reads: the
judge's working directory is the *agent's* workspace, whose
`.claude/settings.json` carries a Stop hook that runs the whole verify suite.
Inherited, the judge would re-run verification at the end of every verdict.

The demonstration run behind #105's acceptance: a diff that adds one file, and a
task whose end state also requires a re-export in `src/index.ts` — a file the
diff never names. The judge vetoed, quoting that file's actual export list.
Neither the task nor the diff contains it.

### 5.2 SDK (`createJudgeClient`)

The SDK path has no `tools` parameter today and is text-only by construction.
It gains a tool loop: pass `JUDGE_READ_TOOLS` mapped to the API's tool shape,
loop while `stop_reason === "tool_use"`, dispatch each `tool_use` block through
the same `createRootedReader` instance, return all `tool_result` blocks in one
user message. The loop lives in `packages/judge`, not in `judge-read` — the
module owns the capability, the client owns the conversation.

Bound the loop the same way the read cap is bounded, and treat exhaustion as a
failure rather than a fallthrough to a text-only answer.

The read module is called **in-process** here. There is no subprocess, which is
why §6 treats the two transports asymmetrically.

#### Probe result, 2026-07-29 (#106)

#106 shipped on fakes alone, and the review on it found a production-fatal bug
they could not see — so the loop was measured the way every stage before it was:
one live run of the shipped `judgeWithEvidence`, against the workspace shape
§5.1 used, with only an instrumented transport added. Two runs, same result.
Four turns, six tool calls (`find` twice, then `read_file` four times), and a
veto quoting a nonce the entry point exported and nothing else could supply.

Three server-side assumptions the loop rests on, each of which a fake asserts
rather than tests:

- **Thinking blocks round-trip.** The assistant turn goes back whole, real
  signatures included, and the server accepts it. Signature verification is
  server-side, so the unit fake's literal `"sig"` had established nothing.
- **`is_error: true` is accepted** on a request still carrying `tools` and
  `output_config`. Forced, not waited for: the run refused no reads of its own,
  so a real assistant turn was replayed with the first result turned into an
  error. A control carrying ordinary results ran on failure, and the first
  attempt needed it — that attempt answered one of the turn's two tool calls and
  was rejected for the other, which is a malformed replay and not a finding
  about `is_error`.
- **A text block on a tool-use turn was not observed** — in either run. That is
  the case that made the SDK's `parse` helper throw and drove the switch to
  `create`. Not observed is not absent: the switch stays, now as defence rather
  than as a measured necessity, and this line is the honest state of it.

Two things the run settled that nobody had asked:

- **A tool-use turn can carry more than one call.** Both runs opened with two
  `find`s in one turn. Answering all of them in a single user message is what
  the API requires, not merely what the loop happens to do.
- **`output_config` does not constrain the verdict's enum.** `zodOutputFormat`
  flattens `z.enum(["approve", "veto"])` into a *description* string, so the
  server enforces the object's shape and not that field's values. Nothing is
  false-green: `VerdictSchema.safeParse` rejects a stray value and the run
  fails as an unparseable verdict. But the enforcement lives client-side, which
  is not what "structured output" implies to the next reader.

## 6. Detecting an unavailable read tool

ADR-0011 mandates `engine-failed` and deliberately does not say how the runner
notices. The constraint it does state: a broken tool and a diff needing no reads
both record zero paths, so detection must be positive and must happen at launch.

**Primary — a pre-flight handshake the runner owns.** Before invoking the judge,
the runner spawns `packages/judge-read/src/server.js` itself, with the same env
the MCP config carries, sends MCP `initialize` and `tools/list`, asserts the
returned names equal `JUDGE_READ_TOOLS` exactly, and kills it. Any deviation is
`engine-failed` *before any model spend*. This is positive (a passing handshake
proves the server launches and exposes the surface), it is at launch, and it
costs no tokens.

**The gap it leaves, and what closes it.** A handshake proves the server *can*
launch, not that the CLI *did* wire it. The server therefore writes a marker
file at startup — path passed in the same env block, pointing into the run's
artifact directory — and the runner asserts the marker exists after the judge
returns. Two positive checks, neither of which a zero-read verdict can fake.

**Do not use `num_turns` from the CLI envelope** as evidence of tool use. It
reported 1 for runs that had clearly used tools during the knowledge-layer
measurements ([spec §10](./knowledge-layer-spec.md)), and the judge dataset row
that captured it did so as a raw record, not as a check to build on.

**The SDK path needs neither mechanism.** There is no subprocess: an unavailable
reader is a module that fails to load or a call that throws, and `run.ts` already
turns a throwing judge into `engine-failed`. Say this in a comment where the
asymmetry lives, or the next reader will add a handshake that cannot fail.

## 7. What gets recorded

### 7.1 The verdict record

`@fleet/contract` gains the record shape, per ADR-0001 — declared once, read
tolerantly:

```
readPaths?: string[]        // runner-observed, workspace-relative
judge?: { model, capability }
```

Three rules, each of which the build gets wrong by default:

1. **`readPaths` is not on `VerdictSchema`.** `VerdictSchema` is what the model
   returns. A judge that reports its own reads can invent them, and the point of
   recording paths is letting a reviewer tell a grounded veto from a confident
   invention. The runner records what it actually served.
2. **Absent means *not recorded*; empty means *read nothing*.** Historical
   verdicts have no field, and a reader must not render them as a judge that
   chose to read nothing. This is the same distinction `unmetGates` already
   documents in `schemas.ts`, and the same trap.
3. **Paths are workspace-relative, always.** An absolute path names a private
   target's directory layout, and `verdict.json` feeds the PR body that a human
   sees at co-sign. **This is a new scrub surface** — `scripts/check-scrub.sh`
   should be reviewed against it before the field ships, not after.

### 7.2 `judgeName` carries capability

`run.ts:703` writes `"claude-opus-4-8"` for both transports today. A model name
cannot distinguish two reviewers running the same model with different powers,
which is the condition ADR-0011 ends.

`pr.ts` renders `judgeName` into one line of prose, so keep it a string there
and compose it — `"claude-opus-4-8 + rooted-read"` — while recording the
structured `{model, capability}` pair in evidence. Capability values:
`rooted-read`, `text-only`, and a stub marker. **`text-only` stays in the
vocabulary** even after nothing emits it: past verdicts were produced that way
and must keep saying so. Never re-label a historical record to match the current
build.

## 8. The two invariant tests

ADR-0011 names both. They are the reason the fork survived as long as it did —
neither was written down anywhere.

**Both transports expose the same tool surface.** Assert that the MCP server's
`tools/list` response and the array the SDK client passes are each derived from
`JUDGE_READ_TOOLS` and equal it — names, descriptions, and schemas. Descriptions
included: two judges told different things about the same tool are two different
reviewers again. The test should fail if either adapter names a tool literally.

**The root check rejects every path outside the workspace.** Table-driven, and
the table is the test's whole value:

- `../outside`, and `a/../../outside`
- an absolute path inside the workspace, and one outside it
- a symlink inside the workspace pointing outside
- a path under a sibling directory sharing the root's prefix (`/ws-evil` for
  root `/ws`) — the case `startsWith` admits
- a path that resolves inside the workspace and must be *accepted*, so the test
  cannot pass by rejecting everything

## 9. Build order

Each stage is independently verifiable. Stage 0 gates only stage 4.

| # | Stage | Done when |
|---|---|---|
| 0 | Probe §2 | One recorded answer on whether `output_config` and `tools` coexist in one request. Needs a go-ahead — real spend |
| 1 | `packages/judge-read` | `JUDGE_READ_TOOLS` + `createRootedReader`; the root-check table test passes. No model calls, no transports |
| 2 | MCP server | `src/server.js` iterating the array; `tools/list` handshake asserts the surface |
| 3 | CLI transport | Flags per §5.1; a local run's judge opens a workspace file and cites it |
| 4 | SDK transport | Tool loop per §5.2, branched on the stage-0 answer |
| 5 | Surface equality | The §8 invariant test — needs both adapters, so it cannot land before stage 4 |
| 6 | Detection | Pre-flight handshake + marker; a deliberately broken server produces `engine-failed`, not a text-only verdict |
| 7 | Recording | Contract field, workspace-relative paths, `judgeName` capability, scrub review |

Stages 1–2 are pure and deterministic — no model tokens, fully unit-testable,
and they carry the root check everything else depends on. Build them first even
though the transports are the headline.

Stage 6 before stage 7: a run that can silently degrade to text-only will record
a clean-looking zero-read verdict, and that record is worse than no record.

## 10. What this spec does not decide

- **Whether to build it now.** ADR-0011 is decided and unbuilt, and staying that
  way is legitimate — ADR-0009 rests there. If the answer is defer, it belongs
  in the ADR's Status section, not in silence.
- **Grep, or any content search.** Out of v1 by §3.3; adding it wants a reason
  from a real run, not from this document.
- **How often a rooted judge changes a verdict.** The ADR's evidence is four
  calls, every cell n=1 — enough to establish that a false green happened, which
  under ADR-0004 is enough to decide. It is not a rate, and nothing in this spec
  should be read as implying one exists.
- **Whether the judge should reach anything outside the workspace, ever.** No,
  today. That is a cage widening and would need its own ADR.

## 11. Provenance

| Source | Contributed |
|---|---|
| [ADR-0011](./adr/0011-the-runner-owns-the-judges-reads.md) | The decision, the six rejected options, and the consequences this spec builds against |
| [ADR-0004](./adr/0004-verification-tri-state-and-mandated-gates.md) | Why one demonstrated false green is enough to decide |
| [ADR-0001](./adr/0001-tolerant-reader-wire-contract.md) | Where the verdict's new fields are declared, and how they must be read |
| [ADR-0007](./adr/0007-per-run-artifact-archive.md) | The size argument behind §3.4's read cap |
| Judge dataset, `tasks/private/` (git-ignored) | The four recorded calls behind the ADR. Rows 3 and 4 are load-bearing; they name a private target and stay out of this repo |
