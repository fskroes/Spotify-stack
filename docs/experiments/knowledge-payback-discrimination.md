# Discriminating knowledge-payback e2e (issue #91)

**Status:** designed, harnessed, and **run four times** — 004 on
`demo-feed-service`, #93 on a private commented target (both 2026-07-23), the
**held-out-oracle variant A** (2026-07-25, see
[Result](#result-2026-07-25-variant-a-held-out-oracle)), and **e2e #2 design G**
(2026-07-27, see [Result](#result-2026-07-27-e2e-2-design-g-gold-prime-held-out-oracle)).
All four tied on outcome with priming as overhead; variant A and #100 additionally
removed the "gate-teaches" confound and still tied, and isolated *why*. This
document is the target-neutral method: the question, the discrimination model, the
harness, and how to read a result. The concrete candidate analysis for the chosen
private fleet target lives with that target's private task definition (git-ignored
`tasks/private/`), because this repo is public and scrubbed of target names.

> **After four ties, see [`knowledge-payback-regime-map.md`](knowledge-payback-regime-map.md)**
> — a zero-spend step back from task-by-task discrimination to the regime space:
> which axes these runs varied vs held fixed, why a repo-compiled artifact
> structurally disfavours *outcome* payback on coherent targets, and the verdict
> (close outcome-on-coherent-targets; keep a re-scoped *cost*-payback bet + a
> judge-gated one).

## The question

The knowledge layer (map #80; run-time injection seam #89/PR #90) renders a
target's compiled prose into `<workspace>/.fleet-knowledge.md` before an agent
run. It is *built*, but its payback is **unproven**.

The first real-spend e2e (2026-07-23, `004-upstream-failure-mode-tests` on
`demo-feed-service`, 3× primed / 3× cold) produced **identical outcomes** in both
arms — 6/6 verify-passed, 0 vetoes — while priming cost **16–65% more**. It was
*non-discriminating*: the cold arm already succeeds perfectly, so there is
nothing for knowledge to flip. On that task, priming is pure overhead.

#91 asks for a **discriminating** experiment: a task where the **cold arm
reliably fails, vetoes, or degrades**, and we measure whether priming flips it —
and at what cost. Either result is publishable: a flip is the first evidence of
payback; a tie even here refines *where* the layer pays back.

## What makes a task discriminate

A run's fate on a well-gated repo is governed by its gates. That yields three
failure classes, only one of which a knowledge artifact can reliably move:

1. **Loud / self-correcting** — the wrong solution fails to compile or fails a
   test *the agent runs mid-iteration*. The agent sees the red and fixes it.
   Knowledge changes the *path* (fewer iterations, lower cost) but rarely the
   *outcome*: both arms converge green. Discrimination shows up only as a cost /
   iteration delta, if at all.
2. **Silent-wrong** — the solution compiles and passes existing tests but
   violates a convention no gate encodes (e.g. omits a rollback that nothing
   tests). Caught only by the **judge**, a softer signal. This is where an
   artifact can flip a *veto*.
3. **Non-local / expensive-to-discover** — the correct solution depends on a
   fact that is **not present in any file the task forces the agent to open**.
   Cold must discover it by reading widely (expensive) or miss it. This is the
   artifact's sweet spot, and the class the chosen task targets.

### The self-teaching obstacle

The hardest confound is that a well-documented target **self-teaches**. When the
correct pattern is inline at the "landing zone" — the file the task forces the
agent to open — the artifact is **redundant**, because the cold agent reads
ground truth for free. Auto-derived subsystems (a single source of truth both
sides compute off) are worse still: a mistake there is compile-forced, i.e. class
1, with no non-local fact to carry.

This is why a discriminating task must hinge on a **genuinely non-local**
coupling: a fact that lives in a file you would *not* open to do the obvious
version of the task, so cold either pays to discover it or gets it wrong. A task
whose scope **excludes** the file carrying that fact turns the coupling into a
mechanically-checkable failure: an over-eager edit trips `scope-violation` before
verify or judge. That mechanical lever is what makes the cold failure
reproducible rather than a matter of luck.

The candidate search, the specific target, and the chosen task's two independent
cold-failure modes are recorded in the private companion. The short version: the
chosen task adds a persisted field behind a versioned storage schema, where the
naive "bump the schema" instinct edits an out-of-scope file (killed as
`scope-violation`) **and** is independently wrong, while the field-without-a-
default variant fails a required data-migration test. Priming carries the one
convention that avoids both.

## Honest risks (why this might still tie)

- **Self-teaching.** If the target already demonstrates the winning pattern on a
  neighbouring field the agent is editing, a cold agent may copy it and pass.
  This is the strongest reason the arms could tie.
- **Scope-hint leakage.** A scope list that includes the model + its migration
  *test* but not the migration *source* is itself a hint that no schema bump is
  needed. A sharp cold agent infers "additive field" and passes.
- **Artifact ambiguity.** If the compiled prose states the winning rule loosely
  (or flags the pitfall under *unknowns* rather than as a crisp rule), priming
  could even **mislead** toward the trap — a "bet weakened" result, still
  publishable.

Given these, the **expected value is a narrow gap, not a clean flip**. That is
acceptable: #91 explicitly accepts "fewer vetoes / better diffs / lower cost at
equal quality," and a null result is evidence about *where* the layer pays back.
The execution session should treat cost/iteration deltas as signal, not only
green↔red.

## How to run it

Everything is turnkey in `scripts/knowledge-payback-e2e.sh`. The harness is
target-agnostic — pass the task and target explicitly (the private companion
records the exact invocation for the #91 run):

```sh
# 1. Validate the plumbing with zero spend (toggles, arm-assertion, restore):
scripts/knowledge-payback-e2e.sh --task <id> --target <name> --dry-run --runs 3

# 2. Real run (spends on the subscription; asks for confirmation):
scripts/knowledge-payback-e2e.sh --task <id> --target <name> --runs 3
```

The harness, per arm × rep:

- **Toggles the artifact** — the cold arm moves `knowledge/private/<target>.md`
  aside so the run logs *"no compiled knowledge … running cold"*; the primed arm
  keeps it so the run logs *"injected knowledge → …"*.
- **Asserts the arm actually took effect** from that log marker, and refuses to
  record a mislabeled run (a mismatch, or both markers present, is fatal).
- Never passes `--pr` (dry-run dispatch, no PR) or `--recompile-knowledge` (the
  only knowledge spend), and does not source `.env` (a stray `ANTHROPIC_API_KEY`
  there flips the CLI to metered API billing; the harness refuses if one is set).
- **Captures evidence** per run — `result.json` + `model-usage.json` — under
  `fleet/evidence/knowledge-payback/<ts>/<arm>/<rep>/`.
- **Restores** the artifact (EXIT-trapped; INT/TERM restore-then-exit), then
  **byte-verifies** it against a pre-run sha256 and asserts `git status` on it is
  clean.
- Emits **`SUMMARY.tsv`**: `arm, rep, runId, status, verify, unmetGates, vetoes,
  verdict, agentUsd, judgeUsd, totalUsd, wallSec`, plus a per-arm aggregate that
  flags loudly if billing was not observed (the cost dimension #91 needs).

### Reading the result

- **Discriminating (payback):** cold shows more `scope-violation` / `failed`
  verify / vetoes than primed, **or** cold's mean `totalUsd` / wall is higher at
  equal outcome (it took the trap detour and recovered).
- **Discriminating (bet weakened):** primed costs more with no outcome benefit,
  or primed is *misled* into the trap more than cold.
- **Null (tie):** both arms pass identically at comparable cost — evidence that
  even a non-local coupling self-teaches on a well-documented repo, and that the
  layer's payback lies elsewhere (under-documented / large-context targets).

## Result (2026-07-23, issue #93)

The discriminating run was executed on a private, meticulously-commented target —
the candidate whose private analysis predicted self-teaching as the dominant tie
risk. Task: add a persisted field to a shared model behind a versioned storage
schema + migration plan, with the migration *source* file held **out of scope**
so an over-eager schema bump would trip `scope-violation`. 3× primed / 3× cold,
real subscription spend.

| arm | verify passed | vetoes | unmetGates | mean total USD |
|---|---|---|---|---|
| primed | 3/3 | 0 | 0 | **$1.07** |
| cold | 3/3 | 0 | 0 | **$0.62** |

**Harness bucket: Discriminating (bet weakened).** The two axes split:

- **Outcome tied.** All six runs — primed and cold alike — produced the
  *identical* correct diff: the one-line additive inline default on the model
  (`var … = false`) plus the required migration test, both files in scope,
  neither touching the out-of-scope migration source. **The cold arm self-taught
  the winning pattern in all three reps** — it took neither predicted trap (no
  out-of-scope schema bump → no `scope-violation`; no missing-default → no
  migration-test failure). This is exactly the *self-teaching* risk the design
  named as the strongest reason to tie: a neighbouring field on the same model is
  already inline-defaulted with a migrate-lightweight comment, and the cold agent
  copied ground truth for free.
- **Cost diverged.** Primed cost more in all 3 reps: per-rep +124% / +43% / +42%;
  comparing arm means, $1.07 vs $0.62 = **+72%** (inflated by rep 1's ~2× primed
  outlier — the per-rep median gap is +43%). No outcome benefit bought that spend.

Because cost was *not* comparable, this is **not** the harness's *null (tie)*
bucket (which requires both arms passing at comparable cost); and it is not
*payback* (cold never failed, vetoed, or took the trap detour — and cold cost
*less*). It is *bet weakened* in its milder, **overhead** form — priming cost
more for no benefit — rather than the stronger *misled-into-the-trap* form
(primed also produced the correct diff, so priming did not actively mislead).

Substantively this **reproduces and strengthens the 004 finding**
(`demo-feed-service`, +16–65% overhead): even a *deliberately non-local* coupling
is discovered for free on a well-documented target, so the designed
outcome-discrimination never fired and only the overhead remained (here +72%).
It is a valid, publishable answer — it refines *where* the layer pays back:
**not on well-documented, self-teaching targets. Look to under-documented or
large-context targets**, where cold cannot read ground truth at the landing zone.
Per-run IDs, diffs, and cost breakdown are in the private companion and the
machine-local evidence dir.

## Result (2026-07-25, variant A: held-out oracle)

Both prior runs share one confound: the discriminating test is *in the repo*, so
the agent iterates against it via the Stop→verify loop. A cold agent can be
"taught" by the very gate meant to catch it — red test, fix, green. Variant A
removes that: the oracle is **held out** — absent during the agent's stop-verify
loop, injected only *after* the agent finishes, then verify runs once as the sole
authoritative judgment. A cold miss of the coupling therefore stays red; the gate
cannot teach it. 1× primed / 1× cold, real subscription spend, `--judge approve`.

Target: the private mobile target. Task `brc-ferry-pref` — a saved route must
restore the ferry-routing preference it was **saved under** across a reopen,
rather than adopting the live session's value. The coupling is genuinely
non-local: save builds a snapshot in one function, reopen rehydrates in another,
and the preference is silently dropped between them. Scope = implementation files
only (no test files), so the agent gets **zero in-loop signal** about the
round-trip. The compiled prose names the persistence landing zone
(`routeStorage.ts`) and the reducer, but **never** names the snapshot round-trip,
the rehydrate function, or the dropped preference.

| arm | held-out verify | out-tokens | cache-read | total USD | fix site |
|---|---|---|---|---|---|
| cold | **passed** | 6068 | 345k | $1.10 | `RideRouteSnapshot` round-trip (1 file) |
| primed | **passed** | 7825 | 708k | $1.06 | `SavedRoute` wrapper in `routeStorage.ts` (2 files) |

**Harness bucket: Null (tie) — even with the confound removed.** Three findings:

- **Outcome tied, and it is not a gate-teaching artifact.** With the oracle held
  out, the cold agent still shipped a fix that passes it. It reconstructed the
  non-local coupling unaided and produced the textbook diff: optional
  `allowFerries` on the snapshot, populated on save, restored on reopen behind a
  backward-compat guard mirroring `setAllowFerries` (ref + dispatch).
- **Priming measurably steered the fix *site*, not the *outcome*.** This is the
  new signal. The cold arm put the field on the `RideRouteSnapshot` round-trip
  type — the actual coupling. The primed arm put it on the `SavedRoute` wrapper in
  `routeStorage.ts` — **exactly the "Local persistence → routeStorage.ts" landing
  zone the prose named first** — threading it through `SaveRouteInput`/
  `buildSavedRoute` with a metadata-flag fallback (2 files, more elaborate). So
  the injected knowledge *did* exert an observable causal pull on the agent — but
  into an equally-correct alternative implementation, not the predicted trap and
  not a better outcome. Priming changed the **how**, never the **whether**.
- **Root cause of the tie, refined: the coupling was *type-visible*.**
  `RideRouteSnapshot` lacks the field while `RouteState`/`preferences` has it —
  TypeScript itself advertises the gap at the landing zone the task forces open.
  The cold agent greps the snapshot type, sees the asymmetry, and closes it. So
  "non-local" (spanning two functions) was **necessary but not sufficient** for
  discrimination: the type system self-taught the coupling for free, the same way
  a neighbouring inline-defaulted field self-taught #93.

Cost: essentially tied in dollars ($1.06 vs $1.10; cache reads are cheap), though
primed spent +29% output tokens and 2× cache reads carrying the injected doc — a
faint overhead echo of 004/#93, not a payback.

**This is the cleanest of the three no-payback results**, because it forecloses
the two standing objections to the prior ties at once: it removes the
gate-teaches confound (held-out oracle) *and* the scope-hint-leakage confound (no
test in scope), and the arms *still* tie. It also sharpens the payback-regime
hypothesis into something testable:

> Run-time knowledge payback requires the missing fact to be **type-invisible** —
> a coupling carried by string keys, dynamic dispatch, or a runtime contract with
> **no shared type** advertising it — *in addition to* being non-local and
> doc-dark. Where the type system encodes the coupling, the compiler teaches the
> cold agent for free and priming only reroutes the fix.

Caveat: n=1 per arm (vs 3× in the prior runs). The tie is backed by a mechanistic
explanation (type-visible coupling) rather than repetition, so it reads as
directional evidence for the refined hypothesis, not a powered estimate. The next
experiment should target a *type-invisible* coupling to test that hypothesis
directly. Raw diffs + `model-usage.json` for both arms are preserved in the
session scratchpad (`results/`); the task spec and held-out oracle live in the
git-ignored `tasks/private/` + session scratchpad (target-name scrub).

## Next experiment (2026-07-26, e2e #2: a type-invisible coupling)

Invoked as `/implement #99`. **Authored + zero-spend pre-flight only — no
agent/judge spend.** This is the direct test the variant-A hypothesis asked for:
a coupling **no shared type advertises**, on the same large + doc-dark central
file (1609 lines) made mechanically judgeable by the #95 subdir-aware gate.

The coupling. Route-level metadata flags are OR-aggregated from per-segment
metadata in a hand-written merge function (`mergeRouteMetadata`). The merge
enumerates each flag it lifts — `merged.flags.hasFerry = … || …` — over a
`merged` object already fully built by `createEmptyRouteMetadata`. So adding a
new per-segment advisory and **omitting its OR line produces no compile error**:
the field already exists on `merged`, and the per-segment→route mapping is a
manual enumeration, not a type-forced one. Task `brc-unpaved-advisory` asks for a
route-level "unpaved surface" advisory that is on iff any segment is unpaved —
modelled on the existing ferry advisory. Scope = one implementation file, no test
files (zero in-loop signal). The discriminating oracle is **held out** (variant-A
protocol): a multi-segment route whose later segment carries the advisory,
asserting the route-level flag; injected only after the agent finishes.

Zero-spend pre-flight proved the coupling is genuinely invisible to the compiler
and the in-loop gate:

| config | typecheck | existing suite | held-out oracle |
|---|---|---|---|
| baseline (clean) | pass | 219/219 | **red** (`undefined`) |
| naive fix: add the advisory per-segment, **skip the merge OR** | pass | 219/219 | **red** (`false`) |
| correct fix: + one merge-OR line | pass | — | **green** |

A plausible naive fix type-checks **and** clears every in-scope gate, failing
**only** the held-out oracle — exactly the type-invisibility the hypothesis
requires. One sub-finding fell out: the advisory flag must be **optional**. A
*required* flag makes `tsc` flag every `flags` object literal — including two in
out-of-scope test files — so a required coupling is self-teaching and turns the
in-scope gate red on its own. Type-invisibility needs the flag optional (or the
merge to be the sole gap).

Honest reading — **pass vs tie hinges on what the prime actually carries.** The
currently-compiled artifact names the file ("ferry handling → the central file")
and the protected append loop, but **never names the merge, route-level
aggregation, or the per-segment→route OR**. Handed that artifact, a primed agent
gets *no* targeted signal on this coupling, so the honest prediction is a **fourth
tie** — but for a new reason: the knowledge layer, as compiled, does not extract
fine-grained aggregation-seam facts. That makes the real run a decision between
two designs (recorded in the private companion): **C** — inject the as-compiled
artifact (likely tie; a clean data point on what the compiler carries); or **G** —
inject a one-sentence "gold" prime that *explicitly* states the merge contract,
testing the upper bound "**if** the knowledge carries the type-invisible fact,
does it flip the outcome?" G is the only configuration in the program that could
turn #80's "unproven" into a genuine payback signal (primed-green / cold-red).

Target-name-scrubbed task spec + held-out oracle live in the git-ignored
`tasks/private/`; the concrete source-level analysis and G/C spend estimate live
in `knowledge/private/` (also git-ignored). The real run is filed as a separate
spend-gated ticket and does not run until the user confirms and picks G or C.

## Result (2026-07-27, e2e #2 design G: gold prime, held-out oracle)

Executed as `/implement #100`, end to end: the one-sentence gold prime (the
merge-aggregation fact the as-compiled artifact omits) hand-inserted into the
artifact after the ferry landing-zone line — frontmatter/sha untouched, grounding
unchanged — then primed vs cold with a character-for-character identical
`fleet run` (the only variable is the artifact's presence). Each arm's produced
diff was judged once by the **held-out oracle** in a pristine target checkout,
`npm run mobile:test` as sole authority. Real subscription spend, `--local`,
`--judge approve` (stub). Both arms' in-loop verify (tsc + the existing 219-test
suite) passed and both were auto-approved; the oracle was absent from both agents'
stop→verify loops.

| arm | held-out oracle | new field | fix site | out-tokens | cache-read | total USD |
|---|---|---|---|---|---|---|
| primed | **GREEN** | `hasUnpavedSurface` | the central file, incl. the `mergeRouteMetadata` OR line | 3426 | 396k | **$1.00** |
| cold | **RED** (`undefined`) | `hasUnpaved` | the central file, incl. the `mergeRouteMetadata` OR line | 2845 | 454k | **$0.48** |

**Mechanical bucket (oracle as sole authority, per the runbook table): PAYBACK** —
primed-green / cold-red. But the mechanism disqualifies it as *genuine* payback.
The honest reading is a **confounded fourth tie on the coupling**, for three
reasons:

- **Both arms solved the type-invisible coupling.** Cold, unprimed, added the very
  `mergeRouteMetadata` OR line the gold prime described
  (`merged.flags.<flag> = … || …`). The single fact the gold prime carried and the
  as-compiled artifact omits — the hand-written per-segment→route OR — did **not**
  discriminate: the cold agent reconstructed it unaided (the task's own Verification
  section nudges it to "reason about where per-segment metadata is combined into the
  route," and the neighbouring ferry OR sits three lines up). On the coupling itself
  the arms tie — exactly the fourth tie the runbook's honest prediction warned of.
- **The red is a field-NAME miss, not the aggregation miss under test.** The
  zero-spend pre-flight defined the modelled type-invisible miss as oracle-**`false`**
  (field present at the route level, its OR dropped). Cold's oracle failure is
  **`undefined`** — the route metadata carries no `hasUnpavedSurface` at all, because
  cold named its (fully aggregated) field `hasUnpaved`. Cold did not commit the
  modelled miss; it diverged on a name, orthogonal to the coupling.
- **The winning name is specified only by the oracle.** "unpaved" appears nowhere in
  the target; the directions-response schema knows only `hasFerry*`.
  Neither the task spec, the codebase, nor the gold sentence pins the property key.
  `hasUnpavedSurface` (primed) and `hasUnpaved` (cold) are both faithful readings of
  the task title "unpaved surface"; the held-out oracle arbitrarily rewards the
  former. At n=1 per arm, which synonym each agent coined is noise, and the gold
  prime — silent on naming — has no causal path to it.

**Corrected bucket: null (tie) on the coupling, with an oracle artifact manufacturing
a spurious green/red, and priming as ~2× cost overhead** ($1.00 vs $0.48; +20%
out-tokens). This is emphatically **not** the program's first genuine payback signal;
recording it as one would be a false positive. It instead reproduces the standing
finding a fourth time — even a genuinely type-invisible, doc-dark coupling
self-teaches on this well-structured target — and it surfaces a **latent oracle flaw
to fix before any re-run**: an oracle that pins an otherwise-unspecified field name
conflates "learned the coupling" with "guessed the contract key," so it cannot on its
own certify payback. A clean re-run must either (a) fix the exact field name in the
task spec so the oracle isolates the aggregation, or (b) assert on behaviour keyed off
a name the codebase already establishes. Both `model-usage.json` and the raw diffs are
preserved under the git-ignored evidence dir + session scratchpad; per-arm runIds
`280b93bc` (primed) / `ecd5af05` (cold).

## Scope boundary

The design session (#91) **designed, authored, and harnessed only** — nothing
was spent. The execution session (#93, 2026-07-23) launched the 004 + #93
real-spend runs and recorded their SUMMARYs; the variant-A session (2026-07-25)
compiled the private target's knowledge artifact (~$0.79) and ran the two
held-out-oracle arms above (~$1.06 + $1.10, subscription). The e2e #2 session
(#99, 2026-07-26) **authored and pre-flighted only** — task spec, held-out
oracle, and a local zero-spend type-invisibility proof (typecheck + jest against
a naive and a correct patch, target restored pristine); **no agent/judge spend**,
and the real run is deferred to a separate spend-gated ticket. The #100 execution
session (2026-07-27) then ran design G's two real-spend arms (~$1.00 primed + $0.48
cold, subscription, no compile spend) and recorded the held-out-oracle result above;
the gold prime was inserted into a scratchpad copy and the artifact restored
byte-identical, and the target was left pristine at `dbb154c`. Raw evidence lives
under the git-ignored `fleet/evidence/knowledge-payback/<ts>/` and the session
scratchpad.
