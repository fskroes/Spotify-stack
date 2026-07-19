# Pre-Compiled Knowledge vs. Cold Exploration: The #54 Prototype

Status: prototype evidence (wayfinder ticket #54, part of map #50)

Target repo: **a private fleet target** — a macOS mail app, 73 Swift source files, pinned at one
commit. It is not named here (this repo is public and names no private target); its identity is not
load-bearing for any finding below.

Last updated: 2026-07-18

## The bet under test

Map #50 rests on one unproven claim: **a pre-compiled knowledge artifact answers a feature
question better and cheaper than cold exploration.** Prior art (#51) found the closest real-world
analogue — Spotify's Honk — *declines* this bet on purpose, running background agents with no code
search and no repo knowledge at all. So the claim needed evidence before the spec (#55) could
assume it.

This prototype builds the artifact in the form decided in #53, asks the three must-handle question
classes from #52 with and without it, and measures both sides.

## Verdict

**The bet holds on cost, decisively. On quality it is a modest win, not a transformation.**

- **Tokens: 4.2× cheaper.** 10.07M (cold) → 2.39M (primed) across the three questions.
- **Money: 2.7× cheaper.** $3.39 → $1.27.
- **Wall clock: 2.3× faster.** 396s → 172s. Every primed answer landed inside the #52
  "time-to-oriented ≤ 2 minutes" projection; the cold arm missed it on two of three.
- **Grounding: primed wins both questions where the comparison is valid.** Mechanically verified
  claims: 0.86 → 1.00 (q1), 0.87 → 0.92 (q2). q3's quality axis is void — the cold run recorded a
  stub instead of its brief (see threats to validity); its cost figures still stand.
- **Read the answers, they are close in substance.** Both arms produce answers a developer could
  act on, and the cold arm sometimes goes deeper on a specific point. The artifact's win is that it
  reaches the same altitude without the spelunking, and names fewer things that do not exist.
- **The human legs pass, 3/3 on both.** *Actionable* and *honest* were read after the fact (see
  Grading). One reader, three answers — the weakest evidence here, and it changes nothing about the
  verdict. What it did surface is where the artifact is thinnest: the **wiring** class.

The honest summary: **pre-compiled knowledge mostly buys speed, cost, and precision — not
insight.** That is enough to justify the layer, because the #52 value projection was
time-to-oriented and zero dead-ends, not "better answers than a thorough explorer."

## Results

| question | arm | tokens | cost | wall | turns | grounded | ratio |
| --- | --- | --- | --- | --- | --- | --- | --- |
| q1 placement | cold | 2,116,963 | $0.846 | 127s | — | 30/35 | 0.86 |
| q1 placement | **primed** | **257,274** | **$0.256** | **36s** | 3 | 33/33 | **1.00** |
| q2 wiring | cold | 1,004,336 | $0.570 | 78s | — | 40/46 | 0.87 |
| q2 wiring | **primed** | **713,039** | **$0.434** | **34s** | 8 | 49/53 | **0.92** |
| q3 story-brief | cold | 6,944,859 | $1.971 | 191s | — | void | void |
| q3 story-brief | **primed** | **1,420,059** | **$0.578** | **102s** | 15 | 38/41 | 0.93 |
| **total** | cold | **10,066,158** | **$3.387** | **396s** | | | |
| **total** | **primed** | **2,390,372** | **$1.268** | **172s** | | | |

Tokens are cumulative across every iteration of a run (cache reads included), summed from the
`stream-json` transcript. The `json` result envelope reports only the *final* iteration and
undercounts an exploring run by an order of magnitude — a measurement trap worth remembering. The
envelope's `num_turns` is unreliable too (it reports 1 for runs that clearly used tools), so wall
clock is measured by the harness instead.

**The saving grows with question difficulty.** Placement saved 8.2× in tokens; the story→brief,
where the cold arm explored hardest, saved 4.9×; the wiring question — the one whose answer is
inherently a file-by-file walk — saved only 1.4×, because the primed arm still has to open the same
files. The artifact does not remove reading; it removes *searching*.

### An earlier sweep, and why it was thrown away

The first sweep gave the primed arm an instruction the cold arm did not have ("rely on the
artifact; open files only where it is genuinely insufficient") — a frugality hint that would have
measured the instruction rather than the artifact. The prompts were made symmetric and everything
re-run. The gap did **not** shrink: 4.0× → 4.2× on tokens, and grounding moved from a tie to a
primed win on all three questions. The confound was real but was not producing the result.

### Amortisation

Compiling the prose layer cost **272k tokens / $0.785 / 7 turns**, once, at onboarding. Average
saving per question is $0.706, so **the compile pays for itself on the second question** and is
free from there on. The map layer costs no model tokens at all — it is a deterministic tree-sitter
pass, about a second of CPU for this repo.

Injecting the artifact costs ~8,964 tokens up front per question (prose 2,936 + map 5,989).

## Method

Two arms, identical in everything except starting knowledge:

| | cold | primed |
| --- | --- | --- |
| Question text | identical | identical |
| Answer requirements | identical | identical |
| Tools | `Read Grep Glob` | `Read Grep Glob` |
| Model | `sonnet` | `sonnet` |
| Starting knowledge | none | the artifact, injected up front |

Both arms run as headless `claude -p --output-format stream-json` processes with the target repo as
the working directory. The prototype code is in
[`prototype/knowledge-layer/`](../prototype/knowledge-layer/README.md); every answer, run envelope,
the artifact, and the grading table are written to `prototype/knowledge-layer/evidence/`, which is
git-ignored because it names the private target — regenerate it locally to re-read the answers.

**Questions** (one per #52 class, all about behaviour the target does *not* have yet, so no answer
can be recited):

1. `q1-placement` — where would "mute this thread" land?
2. `q2-wiring` — how does an email get from the provider to the list the user sees today?
3. `q3-story-brief` — story: a Sunday-evening weekly review → produce a dispatch-ready task brief.

**Grading.** The *grounded* leg of the #52 rubric is mechanical: every file path and code-shaped
symbol an answer names is checked against the repo's real files and tree-sitter-extracted symbols
at the pinned SHA. Claims the answer explicitly proposes creating are counted separately as
`proposed` rather than as fabrications.

The *actionable* and *honest* legs are **pass/fail calls only the human can make** — this is a HITL
ticket. That reading has since been done, against the three primed answers:

| leg | q1 placement | q2 wiring | q3 story→brief |
| --- | --- | --- | --- |
| actionable | pass | pass | pass |
| honest | pass | pass | pass |

So the quality claim no longer rests on the grounded leg alone. It now rests on **one reader's
judgement of three answers about one repo**, which is weaker evidence than the mechanical leg, not
stronger — read it as "nothing here fails the bar," not as a measurement.

**The one finding worth more than the six passes.** The wiring answer passed both legs and still
read as *confidently shallow* — organised and correct, but thinner than its presentation suggested.
That is the same cell that saved the least (1.4×) and scored the lowest grounding (0.92), so three
independent signals land on the same class. The diagnosis that fits: a ranked structural map
carries what depends on what, never what happens in what order. Placement is answered by structure;
wiring is answered by narrative, and the artifact carries no narrative. The spec takes this up as a
mandatory data-flows section in the prose layer, flagged there as a hypothesis to re-test on the
next targets rather than a settled requirement.

## The artifact

Built exactly as #53 decided — two fused layers:

**Layer 1, the map** (`evidence/<target>-map.txt`, git-ignored): tree-sitter parses every tracked source
file; definitions and references become a file graph; PageRank orders it (rank flows toward
depended-on code); a greedy token budget decides what fits, with a per-file declaration cap so one
900-line service cannot eat the budget. Ephemeral by construction — rebuilt from the working tree
on every use, never stored.

**Layer 2, the prose** (`evidence/<target>-prose.md`, git-ignored): compiled once by `claude -p` (opus) with
the full map as its spine and read access to the repo, into a fixed section shape — what the
product is, architecture, key seams, conventions, feature landing zones, verify gate, unknowns.
SHA-stamped in frontmatter, versioned in the control repo. It came out at 86 lines / ~2.9k tokens,
comfortably inside the ~200-line cap #53 borrowed from Anthropic's guidance.

### Empirical budget numbers (#53 left these to this ticket)

Map coverage of the target's 73 source files, by budget:

| Map budget | Files covered | Actual tokens |
| --- | --- | --- |
| 1,000 (aider default) | 7 / 73 | 1,000 |
| 3,000 | 14 / 73 | 2,992 |
| 6,000 | 29 / 73 | 5,989 |
| 15,000 | 73 / 73 | 13,571 (whole repo, uncapped) |

**Recommendation for #55: aider's 1k default is far too small for ideation.** It covers under 10%
of a small repo's files. The runs above used a 6k map (29/73 files) and still beat cold exploration
4×; the whole repo fits in 13.6k. Since a single cold question costs 1–7M tokens, spending 14k to
carry the entire structural surface is trivially worth it. Suggested starting points: **whole-repo
map when it fits under ~15k tokens, otherwise budget at ~15k**, and prose at ~200 lines.

### The drift check, and a threshold (#53's other deferred item)

#53 defined drift as *"prose names things the fresh map no longer confirms"* and left the mechanic
and the threshold to this ticket. The mechanic is the grounding checker pointed at the artifact
instead of at an answer: `cli.ts drift` rebuilds the index from the repo's current SHA and holds
every claim in the stored prose against it.

Run against the prose **at its own compile SHA** — the no-drift baseline — it scores **0.923**
(96/104 claims confirmed). The floor is not 1.0 because the checker cannot see framework symbols
(`URLSession`, `ASWebAuthenticationSession`, `LSUIElement`) or build settings. It did, however,
independently catch the one genuinely stale claim in the artifact: an API the target renamed, which
the prose's own Unknowns section had flagged.

**So a threshold must be relative, not absolute.** Recommendation for #55: record the grounding
ratio at compile time as the artifact's baseline, and trigger recompile when a later check falls
more than ~0.05 below it. An absolute threshold anywhere near 1.0 would fire constantly on
framework vocabulary alone.

## Threats to validity

Recorded plainly, because the result is a decision input.

1. **The "cold" arm was not cold.** Claude Code loads per-project auto-memory, and the target has
   14 accumulated memories (product framing, ADR history, a SwiftData migration pitfall). The cold
   answers cite it explicitly ("per memory: property additions orphan stores"). Disabling it
   requires `--bare`, which forces API-key billing, so the runs kept it. This makes the baseline
   *stronger* than true cold exploration — the artifact beat a hand-accumulated knowledge layer,
   not a blank slate. It also means the cost gap on a genuinely unknown repo is probably wider.
2. **The grounding checker is approximate in both directions.** It *under*-counts grounding
   because it only knows repo symbols: most `not-found` claims are framework symbols (`Timer`,
   `ModelContext`) or hostnames parsed as file paths, not fabrications. It also *over*-counts,
   in three specific ways: a dotted claim like `A.b()` passes if `A` and `b` each exist anywhere;
   a file claim passes on basename suffix match, so a wrong directory still verifies; and the
   proposed/not-found split keys off words like "add" or "new" appearing anywhere on the line, so
   a fabrication in a sentence about adding something is scored `proposed` and leaves the
   denominator. Both arms are scored by the same lenient rules, so the comparison stands; the
   absolute ratios should not be read as precision measurements.
3. **One repo, one model pairing.** Swift, 73 files, arms on sonnet, compile on opus. A larger repo
   or a different pairing may move the numbers. The direction (structural map + prose beats cold
   exploration on cost) is the transferable finding; the multipliers are not.
4. **Three questions, one run each.** No repetition, so per-question variance is unmeasured.
5. **`num_turns` in the envelope is unreliable** (it reported 1 for runs that clearly used tools).
   Wall clock is measured by the harness, not taken from the CLI.
6. **q3's cold run recorded a stub, so its quality axis is void.** The run spent 6.9M tokens and
   191s, then answered with a postscript — "the brief already delivered stands as dispatch-ready" —
   to a brief that appears nowhere in the recorded output, having tried to write a file the tool
   allowlist denied. Its 7 scored claims are not comparable to the primed arm's 41, so the grounded
   cells are voided rather than reported. The token and cost figures are unaffected: the work was
   really done and really paid for.

   Two things follow. The narrow one is a harness bug, now fixed at the source: the answer shape
   demands the complete deliverable in the reply and forbids delegating it to a file. The broader
   one is not a defect at all — a three-minute, seven-million-token wait that ends in "the brief
   already delivered" is a vivid instance of the drained-user failure mode this layer exists to
   prevent. One anecdote, not a measurement, but worth recording rather than tidying away.

## What this hands to #55

- **The bet is proven enough to build on** — sell it as *cost, speed, and precision*, not as
  deeper insight.
- **Budget numbers**: whole-repo map under ~15k tokens; prose ~200 lines. Aider's 1k default is a
  run-time-agent number, not an ideation number.
- **The compile is cheap and amortises immediately** (~$0.79, pays back on the second question),
  which supports #53's "compile at onboarding, recompile on drift" cadence.
- **A relative drift threshold** (~0.05 below the compile-time baseline), because the absolute
  floor sits near 0.92 for vocabulary reasons alone.
- **The prose layer is what carries conventions.** The primed answers named test files, ADR habits,
  and the `xcodegen generate` gate because the prose said so; the map alone would not have. This is
  the part that makes an answer *dispatch-ready*, and it is the part that goes stale — so the drift
  check matters most for prose, exactly as #53 assumed.
- **Open question for the spec**: the fleet's own agents already have auto-memory. The spec should
  say how a compiled artifact and accumulated memory compose, rather than pretending the agent
  starts blank.
- **The measurement this ticket did *not* do.** Everything above measures the *ideation* consumer —
  a human asking a question. The run-time consumer is unmeasured: do fleet runs that receive the
  artifact ship better pull requests than runs that don't? That is the harder experiment (the unit
  is a shipped run, not an answer, and the judge/verify gates are the scoreboard), and it is the one
  Honk's testability objection actually targets — #51 recorded their position that dynamic context
  "makes it less testable and predictable." A static, versioned, SHA-stamped artifact is the answer
  to that objection *in principle*; nothing here demonstrates it in practice.
- **Where the measurement harness belongs.** #50 lists it as unspecified. The cheapest useful form:
  fold a short version of this comparison into target onboarding — compile the artifact, ask two or
  three questions both ways, record the row. Each new target then arrives carrying its own evidence,
  and the case rests on a table across languages and repo sizes rather than one Swift app. Note for
  whoever writes it: tokens are the least persuasive column. Wall clock, and whether an answer sent
  the reader back into the repo, are what a reader actually feels.
