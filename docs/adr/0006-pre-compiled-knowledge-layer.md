# Pre-compiled knowledge is grounded, checked, and non-blocking

> **Status (2026-07-26):** built and shipped for the **human ideation** consumer
> (`fleet ask`). The **run-time injection** consumer is built but its payback is
> **measured and negative on the targets tested so far** — see
> [The bet, and what measurement did to it](#the-bet-and-what-measurement-did-to-it).
> This ADR is kept as-is rather than rewritten, because the counter-evidence is
> the most useful thing in it.

A fleet target can be compiled ahead of time into [knowledge
prose](../../CONTEXT.md#knowledge-prose) stored under `knowledge/`, stamped with
the target SHA. Two consumers read it: a human asking a placement or wiring
question (`fleet ask`), and a dispatched agent primed with
`<workspace>/.fleet-knowledge.md` instead of exploring cold.

Three properties are load-bearing:

- **Repo-agnostic.** Compilation belongs to target onboarding. Anything that
  requires a human to hand-write prose about a specific target is out of bounds
  by construction — that is the thing that does not scale to a fleet.
- **Checked against a freshly rebuilt structural index**, never trusted on its
  own. The [grounding ratio](../../CONTEXT.md#grounding-ratio) is the fraction of
  checkable file and symbol claims the index confirms.
- **Non-blocking.** [Drift](../../CONTEXT.md#drift) *requests* recompilation; it
  never refuses to answer. Stale prose still answers, with its drift flagged.

## Considered options

**Embedding index / semantic search.** Rejected for the ideation consumer:
retrieval returns passages, and the question class here ("where does feature X
land?") needs a synthesized answer with named files and seams. Also
non-deterministic to rebuild and expensive to keep fresh per target.

**Pure structural map, no prose** (Aider repo-map, ctags/tree-sitter). Kept — as
the *substrate*, not the artifact. It is cheap, deterministic, and token-budgeted
(`fleet knowledge map --budget`), but it answers "what exists", not "how is this
wired". The prose layer sits on top of it and is grounded against it.

**Hand-curated context files (CLAUDE.md-style).** Rejected as the primary form: it
violates the repo-agnostic constraint and rots silently, which is precisely the
failure this repo's whole documentation stance is built against.

**Declining the bet entirely.** Worth recording that Spotify's Honk — the closest
real-world analogue and this repo's reference — runs background agents with *no*
code search and *no* repo knowledge, on purpose. Prior art research found the
industry's most relevant practitioner on the other side of this decision. That is
why the bet was prototyped and measured before being assumed.

**Blocking on drift.** Rejected: it would make the human path fail exactly when
the repo is moving fastest, which is when the question is most likely to be
asked. An answer with a flagged drift beats no answer.

**Absolute grounding threshold.** Rejected in favour of a *relative* comparison
against the compile-time baseline (drift at > 0.05 below it). Framework
vocabulary produces a stable false-negative floor that an absolute threshold
would flag forever.

## The bet, and what measurement did to it

The whole layer rests on one claim: *a pre-compiled artifact answers a question
better and cheaper than cold exploration.* It was tested twice, and the two halves
disagree.

**The ideation half held, decisively** (prototype, #54 — see
[`knowledge-layer-prototype-comparison.md`](../knowledge-layer-prototype-comparison.md)):
4.2× cheaper on tokens, 2.7× cheaper in money, 2.3× faster, every primed answer
inside the 2-minute time-to-oriented bar while cold missed it on two of three
questions. Quality was a modest win, not a transformation.

**The run-time half did not** (#91/#93 — see
[`experiments/knowledge-payback-discrimination.md`](../experiments/knowledge-payback-discrimination.md)).
Two real-spend experiments, the second deliberately designed to *discriminate* —
a task built so a cold agent should trip a scope violation or a failing migration
test:

| Experiment | Outcome | Cost of priming |
|---|---|---|
| `004` on `demo-feed-service`, 3×/3× | tied — 6/6 verify-passed, 0 vetoes | +16–65% |
| Discriminating task, private target, 3×/3× | tied — identical correct diff, both arms | +72% (median rep +43%) |

The cold arm **self-taught the winning pattern in all three reps** by copying a
neighbouring field on the same model. The designed trap never fired. Bucket:
**bet weakened, in its overhead form** — priming cost more for no benefit, but did
not actively mislead.

What this refines rather than refutes: the run-time consumer does not pay back on
**well-documented, self-teaching targets**. The remaining hypothesis is
under-documented or large-context targets, where a cold agent cannot read ground
truth at the landing zone. That is untested.

**Do not delete the injection seam on this evidence, and do not claim it pays
back either.** Two negative results on two targets is a bounded finding, and it is
recorded here so the next person does not re-derive it from scratch — or, worse,
assume the layer works because it exists.

## Consequences

- Private targets' prose is stored under `knowledge/private/` and is git-ignored,
  because this control repo is public. `knowledgeArtifactPath` enforces the split;
  target names must be a single path component.
- `fleet ask` rebuilds the structural index on every question, so the answer is
  grounded in the current tree even when the stored prose is stale.
- The grounding ratio is **intentionally approximate** — framework vocabulary can
  read as missing, and suffix file matches and name-level dotted symbols are
  overly permissive. It is a drift signal, not a correctness claim. Do not build a
  gate on it that assumes precision it does not have.
- The prototype that proved the ideation half was throwaway code, deleted once
  the spec landed. Recover it from commit `1bec92d` if the algorithms are wanted;
  it was never the implementation.
