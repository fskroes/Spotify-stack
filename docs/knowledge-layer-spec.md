# Codebase-Knowledge Layer: Specification

Status: **spec** — the destination of wayfinder map #50, and the handoff document for the
follow-on build effort. Nothing described here is built. The prototype that proved the core bet
(#54) was throwaway code at `prototype/knowledge-layer/`, deleted once this spec landed; recover it
from commit `1bec92d` if the algorithms are wanted. It was never the implementation.

Last updated: 2026-07-18

## 1. What this is

A **repo-agnostic pre-compiled understanding of any onboarded fleet target**, serving two
consumers:

- **(a) Human ideation — the primary bar.** "What if the product did X — where and how does that
  land?" answered in ≤2 minutes without opening the repo.
- **(b) Run-time agents — the secondary beneficiary.** A dispatched run starts with the target's
  structure already in hand instead of exploring cold.

The repo-agnostic constraint is load-bearing: compilation belongs to **target onboarding**, never
to bespoke per-repo authoring. Anything that requires a human to write prose about a specific
target is out of bounds by construction.

Everything is held against the product-wide standing value — *does using this make me feel
productive, never drained*. Its projection here, from #52: **time-to-oriented ≤ 2 minutes** and
**zero dead-ends** (an answer never names something that doesn't exist, and never ends with the
human opening the repo to finish the job).

### 1.1 The question classes it must handle

Decided in #52; everything below is built to serve these three, and the prototype was scored on
them.

1. **Placement** — "where does feature X land?"
2. **Wiring** — "how is Z wired today?", the factual base that placement rests on.
3. **Story-driven change** — given a story or feature request, produce a **dispatch-ready task
   brief**: files and seams to touch, approach, constraints, verify gate — pasteable into a fleet
   task. This is the fleet-unique class, the ideation→dispatch on-ramp, and it subsumes placement.

Two further classes are **in spec but outside the must-bar** — build toward them, do not gate on
them. **Blast radius** ("what breaks if we change Y?") needs reference precision the artifact will
not have at stage 1 (§12). **Capability inventory** ("what does the product do today?") is largely
a prose-layer question and may fall out of §4.2 for free; if it does, it is a bonus, not a
commitment.

## 2. The bet, and what the evidence actually supports

The map rested on one unproven claim: a pre-compiled artifact answers a feature question better and
cheaper than cold exploration. #54 tested it against a private Swift target (73 files) across the
three #52 question classes. Full method, results and threats: [prototype
comparison](./knowledge-layer-prototype-comparison.md).

| | cold | primed | |
| --- | --- | --- | --- |
| tokens | 10.07M | 2.39M | 4.2× cheaper |
| cost | $3.39 | $1.27 | 2.7× cheaper |
| wall clock | 396s | 172s | 2.3× faster |
| grounding ratio | 0.86 / 0.87 | 1.00 / 0.92 | primed wins both valid questions |

Two grounding cells, not three: the third question's cold run recorded a stub — it spent 6.9M
tokens and answered with a postscript referring to a brief that appears nowhere in its output — so
its quality axis is void. Its cost figures stand; the work was really done and really paid for.

**Sell this as cost, speed and precision — not as deeper insight.** Both arms produced answers a
developer could act on; the cold arm sometimes went deeper on a single point. The artifact's win is
reaching the same altitude without the spelunking, and naming fewer things that don't exist. That
is exactly the #52 value projection, so it is sufficient — but the spec must not oversell it.

**The rubric's other two legs have since been read** (they are human pass/fail calls, not
measurements). All three primed answers pass *actionable* and *honest* — so the quality claim no
longer rests on the grounded leg alone, though it now rests on one reader's judgement of three
answers about one repo. The reading also produced the single most useful finding about artifact
*content* so far: the wiring answer passed both legs and still felt confidently shallow, which is
what §4.2's data-flows section exists to address.

Three findings constrain the design below:

1. **The artifact removes searching, not reading.** Savings scaled with how much search a question
   needed: 8.2× on placement and 1.4× on wiring, whose answer is inherently a file-by-file walk.
   (The story→brief's 4.9× points the same way but should not be leaned on — that is the question
   whose cold arm produced the stub above, so the ratio compares a deliverable against a
   non-deliverable.)
2. **The prose layer is what carries conventions**, and therefore what makes an answer
   dispatch-ready — and what goes stale. The map alone would not have named test conventions, ADR
   habits, or the target's build gate.
3. **The compile amortises immediately** (~$0.79 once; ~$0.71 saved per question), which is what
   makes "compile at onboarding, recompile on drift" affordable.

**Honk's testability objection is answered in principle, not in practice.** #51 recorded Spotify's
deliberate refusal of repo knowledge for background agents on predictability grounds. A static,
SHA-stamped, versioned artifact is as testable as their static prompts — but nothing in #54
demonstrates it for the *run-time* consumer. See §10.

## 3. Vocabulary

Proposed terms. They graduate into `CONTEXT.md` when the code lands, not before — the glossary
names what exists.

- **Knowledge artifact** — the two fused layers for one target, taken together. Note the collision
  to resolve at graduation: this repo already uses *artifact* for per-run evidence under
  `artifacts/runs/<runId>/`. Either qualify this one everywhere or pick another head noun; do not
  let both senses into `CONTEXT.md` unqualified.
- **Map layer** — the deterministic tree-sitter structural map. Ephemeral; rebuilt on every use.
- **Prose layer** — the fleet-generated intent layer. Compiled once, SHA-stamped, stored.
- **Compile** — producing the prose layer for a target. Costs model tokens; happens at onboarding.
- **Grounding ratio** — the fraction of file/symbol claims in a text that exist in a map rebuilt at
  the current SHA. Used two ways: to score an *answer* (the #52 rubric) and to score the *stored
  prose* (the drift check).
- **Drift** — the stored prose naming things a freshly rebuilt map no longer confirms.

## 4. Form: two fused layers

Decided in #53; budgets settled by #54.

### 4.1 Map layer

Deterministic, aider-shaped: tree-sitter extracts definitions and references per file → a file
dependency graph → PageRank (rank flows toward depended-on code) → greedy token-budget fill, with a
per-file declaration cap so one large service cannot eat the budget.

- **Ephemeral by construction.** Rebuilt from the target's working tree at every use — every
  ideation question, every dispatch. Never stored, therefore never stale.
- **Budget: whole repo when it fits under ~15k tokens, otherwise cap at 15k.** Aider's 1k default
  is a run-time-agent number, not an ideation number — it covered 7 of 73 files on the prototype
  target, whose entire structure fit in 13.6k. Against a 1–7M-token cold question, 14k to carry the
  whole structural surface is free.
- **Also the substrate for grounding.** The same index backs both the answer-scoring and drift
  checks, so the map is not only context — it is the mechanical half of the #52 rubric.

### 4.2 Prose layer

Fleet-*generated* — never hand-written, forced by the repo-agnostic constraint. Compiled by a model
with the full uncapped map as its spine plus read access to the repo, into a fixed section shape:
what the product is, architecture, key seams, **principal data flows**, conventions, feature
landing zones, verify gate, **unknowns**.

- **Budget: ~200 lines.** The prototype's came out at 86 lines / ~2.9k tokens.
- **The Unknowns section is mandatory**, and is the structural support for the rubric's *honest*
  leg: the artifact must state where it lacks a fact rather than inventing one. In the prototype it
  earned its place — it had already flagged the one claim the drift check later caught as stale.
- **The data-flows section is the one addition the prototype's own evidence asks for**, and it is
  the weakest-supported requirement here — see below.
- **SHA-stamped frontmatter**, including the grounding ratio at compile time (§6).

#### Why data flows get their own section

Three signals converge on the **wiring** class ("how is Z wired today?") being where the artifact
underdelivers, all from #54:

1. It saved the least — **1.4×**, against 8.2× on placement.
2. It scored the lowest grounding of the primed arm (0.92).
3. On the human read of the rubric's *actionable* and *honest* legs, it was the one answer that
   **passed both yet still felt confidently shallow** — organised and correct, but thinner than its
   presentation suggested.

The diagnosis that fits all three: a ranked structural map tells you what *depends on* what, which
is not the same as what *happens in what order*. Placement questions are answered by structure;
wiring questions are answered by narrative, and nothing in the artifact currently carries narrative.
Hence an explicit section tracing the handful of principal flows end to end — for the prototype
target, provider fetch → reconcile → store → filter → view.

**Hold this loosely.** It rests on one reader, one answer, one repo — the thinnest evidence in this
document, and the *actionable* and *honest* legs are pass/fail judgements, not measurements. It is
recorded because it is the only signal so far about *what the prose layer should contain* rather
than how big it should be. Stage 3 (§11) should treat it as a hypothesis to check against the next
two or three targets, and drop it if the wiring class stops being the weak cell.

### 4.3 Injection cost

~9k tokens per question in the prototype (prose 2.9k + map 6k); ~17k at the recommended whole-repo
map budget. This is the number to hold against per-question savings, and it is small.

## 5. Storage

Per #53: prose in the control repo, keyed by target name, git-versioned.

```
knowledge/<target>.md            # public targets — committed
knowledge/private/<target>.md    # private targets — git-ignored
```

This mirrors the existing `fleet/repos.yaml` ÷ `fleet/repos.local.yaml` and `tasks/` ÷
`tasks/private/` split, and the reason is the same: **this control repo is public and must never
name a private target's files.** The prototype's `evidence/` is git-ignored for exactly this
reason.

**Known consequence:** private targets trade versioning for privacy — the artifact whose
testability answers Honk's objection is, for them, not under version control. The SHA stamp still
makes staleness detectable, so the loss is history, not correctness. Whether private artifacts
should be versioned in a private sibling repo is left open (§12).

The map layer is never stored, so it needs no location.

## 6. Freshness

Split cadence, matched to rebuild cost (#53), with the mechanic and threshold settled by #54.

**Map:** rebuilt every use. No staleness story needed.

**Prose:** compiled at onboarding; recompiled only on drift or explicit request. The drift check is
the grounding checker pointed at the stored prose instead of at an answer: rebuild the index at the
target's current SHA, hold every claim in the prose against it, produce a ratio.

**The threshold is relative, not absolute.** At its own compile SHA — the no-drift baseline — the
prototype's prose scored **0.923**, not 1.0, because the checker cannot see framework symbols
(`URLSession`, `ModelContext`) or build settings. An absolute threshold near 1.0 would fire
constantly on vocabulary alone.

> Record the grounding ratio at compile time in the artifact's frontmatter as its baseline.
> Trigger recompile when a later check falls **more than 0.05 below that baseline**.

**Staleness tolerance is asymmetric by consumer** (#53):

- **Human ideation — never block.** Answer immediately from the stale prose, flagging drifted
  claims as unverified-at-current-SHA, and kick off recompile in the background. Blocking would
  break the ≤2-minute projection, which is the whole point.
- **Run-time agent — recompile before dispatch** when drift exceeds threshold. Runs are background,
  so latency is free, and an agent cannot judge stale guidance the way a human can.

## 7. Consumption seam A — human ideation

**Ships in the fleet CLI first**, as `fleet ask`:

```sh
fleet ask <target> "where would 'mute this thread' land?"
```

It resolves the target from the registry, rebuilds the map, loads the stored prose, runs the drift
check, injects both, answers, and prints drift flags alongside. Target resolution, `local_path`
handling and registry merge already exist for `fleet run` and should be reused, not reimplemented.

**Why the CLI and not the Operator app first:** the runner is where the artifact is produced and
where target resolution lives; the Operator is a tolerant reader of runner speech
([ADR-0001](./adr/0001-tolerant-reader-wire-contract.md)), so an
Operator view is a second consumer of a seam that must exist anyway. Building the CLI first gets
the primary bar into use in one stage instead of three. An Operator view is stage 6 (§11) and, when
built, reaches this through `@fleet/contract` like every other runner surface — never by reading
`knowledge/` off disk.

**Answers are scored against the #52 rubric**: *grounded* (mechanical, via the same index),
*actionable* and *honest* (human pass/fail calls). Note that #54 measured only the grounded leg;
the other two remain unmeasured, not merely unautomated.

## 8. Consumption seam B — run-time agents

The artifact reaches a dispatched run as **a file in the run workspace, excluded from the diff**,
plus a fixed preamble block in the task prompt naming that file.

```
<workspace>/.fleet-knowledge.md      # prose + rendered map, written before the agent starts
```

Three reasons for a file rather than prompt text alone:

1. **It survives resume.** `claudeEngine` re-invokes with `--resume` and no original prompt; a
   preamble injected only into the first prompt is gone by the second iteration, while a file in
   the workspace persists.
2. **It stays static and inspectable** — the artifact a run received can be archived with the run's
   other evidence, which is what makes the run-time consumer testable at all (§10).
3. **It keeps the prompt readable.** Task prompts are version-controlled human artifacts; a 17k
   blob pasted into them destroys that.

**The file must never enter the diff.** `stagedDiff` runs `git add -A`, so an untracked knowledge
file in the workspace would be staged, land in the diff, and trip `scope-violation` on every scoped
run — a mechanical false positive, not a judgement call.

The runner already solves this exact problem for `.claude/`. The invariant is that
runner-injected paths never enter the reviewable diff. `stagedDiff` enforces it in two steps:
stage all task changes (`git add -A -- .`), then explicitly unstage the injected paths
(`git reset -q -- .claude`) before computing the diff. It cannot name the injected path in the
`add` pathspec — the earlier `git add -A -- . ':(exclude).claude'` broke on targets that gitignore
their own `.claude`, because Git rejects an explicitly named ignored path. The knowledge file is the
same kind of thing (runner-injected, never the agent's work) and should extend the same unstage step
rather than invent a second mechanism. This makes the injected path part of the workspace contract,
which is where it belongs; a target-side `.gitignore` edit would be the target's file, not ours.

**Recompile-before-dispatch** (§6) runs as part of workspace preparation, before the agent starts.

### 8.1 Composition with accumulated memory

#54 surfaced this and left it to the spec: **the "cold" arm was never cold.** Claude Code loads
per-project auto-memory, and the target carried 14 accumulated memories that the cold answers cited
explicitly. Disabling it requires `--bare`, which forces API-key billing, so the runs kept it. The
artifact therefore beat a hand-accumulated knowledge layer, not a blank slate — the baseline was
*stronger* than advertised, and the gap on a genuinely unknown repo is probably wider.

The spec must not pretend the agent starts blank. The rule:

- **The artifact is authoritative on code facts at its stamped SHA** — files, symbols, seams,
  structure. It is mechanically grounded and SHA-stamped; memory is neither.
- **Memory is authoritative on episodic and preference knowledge** — what was tried before, what
  the human asked for, what went wrong last time. The artifact has no access to that and should not
  try to acquire it.
- **On conflict about a code fact, the artifact wins**, and the answer says so rather than
  silently picking a side.
- **The compile step must not read the fleet's own memory.** A compiled artifact that varies with
  whatever the session happened to accumulate is not reproducible, and reproducibility is the
  entire answer to Honk's objection. Compilation reads the repo and the map. Nothing else.

## 9. Onboarding integration

The `/onboard-target` skill (`.claude/skills/onboard-target/SKILL.md`) currently: inspects the
repo, registers it in `fleet/repos.local.yaml`, checks the verify gate, drafts a tests-first
on-ramp task, and hands run commands to the user without running them.

Two steps are added between registration and task drafting:

1. **Compile the prose layer** — `fleet knowledge compile <target>`, writing `knowledge/<target>.md`
   (or `knowledge/private/`) with SHA and baseline grounding ratio stamped.
2. **Record the evidence row** — §10.

The compile is the skill's first model-cost step, so it inherits the skill's standing rule: **hand
the command to the user, do not run it.** ~$0.79 and a few minutes is small but it is real spend on
a real target, and the repo's standing preference is to ask before launching anything that costs an
agent run.

The drafted on-ramp task also gets materially better: the prose layer names the target's real
conventions, test layout and verify gate, which is precisely what step 3 of the skill currently
asks a human to infer by skimming.

## 10. Measurement harness

#50 listed this as unspecified. **Fold a short version of the #54 comparison into onboarding**:
after compiling, ask two or three questions both ways and append one row to a committed table.

```
docs/knowledge-layer-evidence.md
```

Each new target then arrives carrying its own evidence, and the case rests on a table across
languages and repo sizes rather than one Swift app. Rows for private targets record the target as
`private-<language>-<n>` and carry no file names.

**Report wall clock and dead-ends first; tokens last.** Tokens are the least persuasive column —
what a reader feels is how long they waited and whether the answer sent them back into the repo.

Two measurement traps, both learned the expensive way in #54 and both worth encoding in the
harness:

- **Sum tokens across every iteration of the stream, including cache reads.** The `json` result
  envelope reports only the final iteration and undercounts an exploring run by an order of
  magnitude. `num_turns` in the envelope is unreliable too (it reported 1 for runs that clearly
  used tools) — measure wall clock in the harness.
- **Keep the arms symmetric.** The first #54 sweep gave the primed arm a frugality instruction the
  cold arm lacked, which would have measured the instruction rather than the artifact. It was
  thrown away and re-run. Any asymmetry between arms — tools, prompt, model — invalidates the row.

**The run-time half stays unmeasured, and the spec says so plainly.** Everything above measures the
ideation consumer. Whether fleet runs that receive the artifact ship *better pull requests* than
runs that don't is the harder experiment: the unit is a shipped run rather than an answer, and the
judge and verify gates are the scoreboard. It is also the one Honk's objection actually targets. It
needs a corpus of comparable tasks run both ways, which does not exist yet — so it is scoped as a
follow-on experiment, not a stage of this build.

## 11. Build stages

Each stage is independently useful and independently verifiable. `packages/knowledge`, a workspace
package, consumed by `packages/cli` and `packages/runner`.

| # | Stage | Delivers | Done when |
| --- | --- | --- | --- |
| 1 | Map layer | `fleet knowledge map <target> [--budget]` | Deterministic map for a TS and a Swift target; unit tests on parse/rank/select/budget; no model calls |
| 2 | Grounding + drift | `fleet knowledge drift <target>` | Ratio reproduces at a pinned SHA; baseline comparison implemented |
| 3 | Prose compile | `fleet knowledge compile <target>` | Artifact written with SHA + baseline ratio stamped; public/private paths respected |
| 4 | Ideation seam | `fleet ask <target> "…"` | Answers a #52 question class with drift flags; never blocks on stale prose |
| 5 | Run-time seam | Workspace injection + recompile-before-dispatch | Artifact present in workspace, excluded from diff, survives `--resume`; a scoped run does not trip scope-violation |
| 6 | Operator view | Ask surface in the desktop app | Reaches the artifact through `@fleet/contract`, tolerant-reader rules honoured |

Stages 1–2 are pure and deterministic — no model tokens, fully unit-testable, and they carry the
grounding machinery everything else depends on. Build them first even though stage 3 is the
headline.

**Port, don't lift.** The prototype was throwaway and is gone from the tree — it shipped native
tree-sitter grammars outside the pnpm workspace, was excluded from the root vitest run, and its
module boundaries were drawn for one experiment. Read its `src/` out of commit `1bec92d` as a
reference for the algorithms (parse → rank → select → budget, and the grounding checker); do not
restore it as code.

**Native-dependency risk, flagged early.** Tree-sitter grammars are native modules, and the runner
executes both on an SSH-dispatched Mac and in GitHub Actions on Linux. The prototype already needed
`npm install --legacy-peer-deps` to reconcile grammar peer ranges. Stage 1 must prove the build on
both platforms before stage 5 depends on it; a WASM-based tree-sitter build is the fallback if
native install proves fragile across the fleet's platforms.

## 12. Open questions

- **Private-target versioning.** Git-ignoring private artifacts costs the version history that
  answers Honk's testability objection. A private sibling repo would restore it, at the cost of
  another moving part.
- **Reference precision.** The prototype resolves references by name match, not by symbol. Good
  enough for ranking; not good enough for blast-radius questions — which #52 already placed outside
  the must-bar. If blast-radius is ever promoted, this is the blocker.
- **The grounding checker is approximate in both directions.** It under-counts (framework symbols
  read as fabrications) and over-counts (dotted claims pass if both halves exist anywhere; file
  claims pass on basename suffix, so a wrong directory still verifies). Both arms are scored by the
  same rules so comparisons hold, but absolute ratios must never be quoted as precision.
- **Multi-language and monorepo targets.** Every measurement so far is one language, 73 files. A
  target with several languages or a package graph may need per-package artifacts rather than one.
- **Recompile trigger ownership.** §6 says recompile on drift, but nothing yet says *who notices*
  outside a dispatch or an `ask` — a scheduled sweep across targets is the obvious answer and is
  unspecified.

## 13. Out of scope

- *Gating* on the blast-radius and capability-inventory question classes. They are in spec but
  outside the must-bar (§1.1) — no stage below is blocked on them.
- Embedding or semantic search over the target. #51 found it good for concept queries and
  infra-heavy; the tree-sitter substrate is the repo-agnostic choice and this spec commits to it.
- Any per-target hand-written prose. The repo-agnostic constraint forbids it.
- Editing target repos to carry their own knowledge files.

## 14. Provenance

| Ticket | Contributed |
| --- | --- |
| #51 | Prior art; aider-shaped map + generated prose; Honk's refusal and its testability argument — [research](./codebase-knowledge-prior-art-research.md) |
| #52 | Question classes; grounded/actionable/honest rubric; the value projection |
| #53 | Two fused layers; split freshness cadence; asymmetric staleness tolerance; control-repo storage |
| #54 | The bet, proven on cost/speed/precision; budget numbers; relative drift threshold; the memory-composition question — [comparison](./knowledge-layer-prototype-comparison.md) |

Ticket numbers are issues on this repo; resolve them with `gh issue view <n> --comments`.
