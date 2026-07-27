# Knowledge-payback regime map (scoping, zero-spend)

**Status:** authored 2026-07-27, **no spend** (analysis only — no agent/judge
runs). Companion to `knowledge-payback-discrimination.md` (the method + the four
run results). That doc asks *"did this task flip?"* one task at a time. This doc
steps back after **four ties** (004, #93, variant A, #100) and asks the prior
question: **for which class of fact, target, and signal could run-time knowledge
priming ever pay back at all?** It characterizes the regime space, marks which
axes the four experiments actually varied versus held fixed, and closes with a
keep-open-vs-close recommendation for the run-time-payback bet (map #80) and a
re-read of the pending oracle-fix ticket (#102).

It stays target-neutral (this repo is public and scrubbed); the concrete
per-target instantiation of any experiment proposed here belongs in the
git-ignored `tasks/private/` + `knowledge/private/`, as before.

## 1. What "payback" actually requires

Priming pays back on a run only if there exists a fact **F**, required by the
correct solution, for which all three hold:

1. **Required** — the correct diff depends on F; a solution without F fails a
   gate, an oracle, or the judge.
2. **Not cold-acquirable** — the *cold* agent (no artifact, but full read access
   to the whole repo) does not obtain F within its bounded run: it either can't,
   or reliably doesn't, or pays materially to.
3. **Carried** — the artifact the primed agent receives actually contains F.

Every tie so far is a failure of clause **2**: the cold agent obtained F for
free. So the whole question reduces to *what makes a required fact
un-acquirable by an agent that can already read everything?* — and, separately,
whether the artifact can even carry such a fact (clause 3), because the artifact
is **compiled from that same repo**.

Two payback *shapes* satisfy the identity, and they are worth separating because
the experiments have only ever been able to detect one of them:

- **Outcome payback** — cold **fails / vetoes / ships a worse diff**; primed
  passes. Gate- or oracle-detectable. This is what all four runs were built to
  catch, and what "proving the bet" was taken to mean.
- **Cost payback** — both arms reach the same correct outcome, but **cold spends
  materially more** getting there (wide reading to reconstruct F), and the
  artifact compresses that discovery. Detectable only in the cost columns, and
  **only visible as cold-costs-more** — which no run has shown as a real effect.
  (Variant A's raw dollars were nominally cold-higher, $1.10 vs $1.06, but the
  record reads that ~$0.04 as noise / a cache-read artifact, with the token and
  cache-read overhead sitting on the *primed* arm — not a discovery cost cold
  paid.)

## 2. The axis-space, and what four runs did to it

| Axis | Range | Runs that varied it | Verdict |
|---|---|---|---|
| **A. Coupling type-visibility** | compiler advertises the gap → compiler silent | variant A (visible) → #100 (invisible) | **Not the lever** (n=1 each + mechanism, not a powered estimate). Making it type-invisible was necessary-not-sufficient; #100's invisible coupling still tied — cold re-derived the merge-OR by local reasoning. |
| **B. Locality / doc-darkness** | inline at the landing zone + documented → non-local + doc-dark | 004/#93 (local-ish, documented) → variant A/#100 (non-local, doc-dark) | **Not sufficient** (backed by all four, mechanistically). Non-local + doc-dark ties when the fact is still repo-derivable. |
| **C. Experiment hygiene** | gate teaches in-loop; scope/spec leaks → held-out oracle, no test in scope | variant A + #100 (both confounds removed) | Removed the *artificial* teachers; the arms **still tied**, so the tie is a property of the target, not the harness. |
| **D. Prime fidelity** | as-compiled artifact → hand-authored "gold" prime | #100 (design G, gold prime) | Even a gold prime that states F verbatim tied — cold re-derived F, and the one place primed "won" was a field-name artifact of the oracle (→ #102). |
| **E. Target reconstructability / structure** | coherent, well-factored, self-consistent → incoherent, arbitrary, trap-laden | **never varied — held fixed at "coherent" all four times** | **The untested axis.** Every target (three distinct codebases) is clean, well-commented, internally consistent. |
| **F. Signal channel** | gate/oracle (mechanical) → judge (soft, veto) | never — judge was stubbed (`approve`) or unmeasured | **Untested, and entangled** with the separately-unproven judge (maps #59/#71). |

The two most recent rows (variant A, #100) are **n=1 per arm** — the earlier ones
were 3×3 — so the A/D verdicts rest on a mechanistic explanation (a type-visible
gap the compiler advertises; a merge-OR three lines from the landing zone) rather
than a powered negative. Read them as *strongly directional*, not settled: the
map's verdict leans on the mechanism plus four independent ties, not on statistical
power at any single cell.

Axes A–D are the ones the program iterated on, one refinement per run. They are
all refinements of **where in the repo F lives** and **how sharply the artifact
names it**. But the cold agent can read the *entire* repo. So none of A–D
changes clause 2 as long as F is somewhere in the repo and the target is coherent
enough that a competent agent reconstructs it. Four ties are four confirmations
of exactly that.

The two axes never moved are **E** (target structure) and **F** (signal
channel). They are where the remaining question lives.

## 3. The structural bind: a repo-compiled artifact carries only repo-derivable facts

The knowledge artifact is **prose distilled from the target repo at a stamped
SHA**, and by spec (#55) the compile **reads no memory** — reproducibility is the
whole answer to the Honk testability objection. So, by construction:

> Every fact the artifact can carry was already in the repo.

Now overlay clause 2. The cold agent also has the whole repo. Therefore any fact
the artifact carries is, *in principle*, derivable by cold. Outcome payback then
requires a fact that is **in the repo, cheap for the artifact to state, yet
reliably NOT derived by a competent cold agent within its run.** That is a narrow
target: it is neither "expensive to find" (that's cost payback, clause 2 by
*cost*, not by *miss*) nor "not in the repo" (then the compiler can't extract it
either — clause 3 fails for the auto-compiled artifact).

This splits the frontier cleanly:

- **In-repo + robustly agent-missed.** The only way the *auto-compiled* layer
  could show *outcome* payback. Four carefully-built couplings were all derived,
  so on coherent targets these misses appear **rare**. Low-probability frontier.
- **Arbitrary / exogenous** (a magic constant with no local justification, an
  external consumer's required field name, a cross-repo contract, a business/
  regulatory rule, a workaround for a specific dependency bug). Genuinely
  un-acquirable by cold — but **the compiler can't extract it either**, because
  it isn't in the repo. Only a **hand-authored (gold) prime** can carry it, and a
  win there validates a *human-hint layer*, **not** the auto-compiled knowledge
  layer that map #80 actually built. #100 already probed the adjacent cell: a
  gold prime stating an *in-repo* fact tied, because cold re-derived it.
- **Repo-derivable but expensive to synthesize** (a data flow spanning many
  files; "what happens in what order," which a ranked structural map never
  carries and the prose layer's *principal-data-flows* section was added to hold,
  see #50/#54). Here cold *can* get F but **pays** for it. This is the **cost
  payback** cell — and it is the one the four runs could not even see, because
  every target was small/coherent enough that discovery was cheap, so the only
  cost signal was the fixed **overhead tax** the primed arm pays to carry the doc
  in context (from roughly tied on the smallest runs up to ~2× on #100 —
  $1.00 vs $0.48 — across the four runs). Cost payback needs a target where
  cold's discovery cost **exceeds that carry tax**.

## 4. The three candidate regimes, with verdicts

**R1 — Outcome payback, auto-compiled artifact, coherent target.**
Requires an in-repo-but-robustly-missed fact. Four ties + the §3 argument make
this the equilibrium *against* payback, not a gap in coverage. **Verdict: close.**
Chasing it task-by-task on coherent targets is whack-a-mole against a structural
headwind — across four runs, each coupling we could *describe* well enough to
build, a competent agent *derived* well enough to tie. The pattern is strong and
mechanistic, not a proven law: it would break if an in-repo fact turned out to be
robustly agent-missed, which none of the four exhibited.

**R2 — Outcome payback, gold prime, arbitrary/exogenous fact.**
The one configuration that could produce a clean primed-green/cold-red. But a win
here proves *"a human hint about a non-derivable fact helps,"* which was never in
doubt and is **not** the knowledge-layer bet (auto-compiled, repo-only). **Verdict:
out of scope for the layer bet.** Only worth running as an explicitly-labelled
*upper bound* — and only on a fact that is genuinely non-derivable (not #100's
in-repo coupling, which cold re-built).

**R3 — Cost payback, auto-compiled artifact, large/synthesis-heavy target.**
Live and **unfalsified** — no run has tested it, because no target was large
enough for cold's discovery to out-cost the carry tax. The artifact's
*principal-data-flows* prose is the designed carrier of exactly the
expensive-to-synthesize content this needs. **Verdict: keep open; this is the
honest surviving bet.** Re-scope the experiment to detect **cold-costs-more at
equal outcome**, on a large multi-file coupling.

**R4 — Judge-mediated (veto-flip) payback.**
The "silent-wrong" class from the method doc: a solution that compiles and passes
every gate but violates a convention only the judge catches, where the artifact
carries the convention. **Untested** (judge was `approve`/stubbed) and
**entangled** — a flip here is only trustworthy if the judge itself is (maps
#59/#71). **Verdict: park behind judge trust;** do not spend on it until the judge
is a proven discriminator, or the result is uninterpretable in the same way #100's
oracle was.

## 5. Re-read of #102 (fix oracle + re-run design G)

#102 fixes a real defect — the held-out oracle over-specified an unpinned field
name, so #100 conflated "learned the coupling" with "guessed the contract key."
That fix is correct and worth doing **for the record**. But the regime map says
the re-run's *expected* clean result is a **fifth tie on the coupling**: #100
already showed cold reconstructs the type-invisible merge-OR unaided even against
a gold prime, and fixing the oracle only removes the *spurious* red — it does not
give cold any less ability to derive F. The re-run therefore sits in **R1** — its
fact is in-repo and cold-derivable, so a gold prime does not move it out of R1
into R2 (R2 requires a *genuinely non-derivable* fact, which #100's coupling is
not). It is the cell this map recommends closing.

Recommendation for #102: **decouple the two halves.**
(1) Land the oracle fix as a correctness/record item (cheap, no agent spend —
pin the contract key in the task spec, or assert on a name the codebase already
establishes). (2) **Do not spend on the G re-run as an outcome-payback test.** If
any spend is authorized, redirect it to the **R3 cost-payback** experiment
below, whose result is informative regardless of which way it lands, rather than
to a fifth coherent-target coupling whose most-likely outcome is a tie we can
already predict.

## 6. Verdict

- **Outcome payback on coherent, well-structured targets (R1): close as
  unproven-and-structurally-disfavoured.** Not "we didn't find the right
  coupling" — rather, a repo-compiled artifact can only carry repo-derivable
  facts, and on a coherent target a competent cold agent **reliably** derives
  them, so the tie is the predicted equilibrium (not a theorem — the residual
  frontier is an in-repo fact the agent robustly *misses*, which four built
  couplings did not exhibit). Bank it as the sharpened finding of map #80.
- **Keep exactly two bets alive, both re-scoped off axis E/F rather than A–D:**
  - **R3 cost payback** — a large, synthesis-heavy, genuinely doc-dark target
    where cold's discovery cost beats the primed carry tax. This is the honest
    remaining knowledge-layer story and the recommended next design.
  - **R4 judge-mediated** — gated on a proven judge; not before.
- **R2 gold-prime is not the layer bet** — only ever an upper-bound sanity check,
  and only on a truly non-derivable fact.

The program's four-tie result is not a null we keep poking; it is a **positive
characterization**: the auto-compiled knowledge layer's payback, if it exists,
is a **cost** effect on **large/incoherent** targets, not an **outcome** effect
on the coherent targets we can most easily reason about.

## 7. What each live bet needs next (zero-spend design deliverables)

Neither requires spend to *design*; both are gated on explicit user go-ahead to
*run* (standing local-runs rule).

**For R3 (cost payback): AUTHORED + zero-spend PRE-FLIGHTED 2026-07-27 (design-G-style staging, no agent/judge spend).**
- A **target selector**: pick/on-board a target whose correct coupling requires
  synthesis across many files (candidate signal: the coupling's supporting facts
  are scattered, not within a screen of the landing zone), and large enough that
  a whole-repo read is not free. Record the candidate table privately.
- A **cost-first oracle**: the primary readout is `agentUsd` / out-tokens / wall
  in the **cold** arm minus the carry tax the primed arm pays — i.e. instrument
  to detect *cold-costs-more*, the inverse of every prior run. Outcome is
  expected to tie; that is fine, cost is the signal.
- A **carry-tax baseline**: measure the fixed overhead of injecting the artifact
  on a no-discovery task, so R3's cold-discovery cost is read against it.

  *Staged as e2e #3 (`brc-saved-route-metric`) on the private mobile target —
  chosen because it measured large-context + doc-dark (~15.9k LOC, ~3.3% comments,
  no in-subtree docs). Coupling = a derived route metric silently recomputed from
  geometry on reopen (`computeTotals`), so it renders in the saved-routes list but
  goes stale on the Review screen unless produced in the recompute path — a wide,
  no-landing-zone-giveaway coupling the as-compiled artifact's* Principal data flows
  *section carries natively (tests the layer, not a gold prime). Zero-spend pre-flight
  proved it invisible to both in-loop gates (naive fix: `tsc` clean + suite 219/219)
  and distinguished only by the held-out oracle (`0` vs recomputed `2.0`); one `tsc`
  confound (a required persisted field flagging an out-of-scope fixture) was caught and
  removed by pinning the field optional. Full record in
  [`knowledge-payback-discrimination.md`](knowledge-payback-discrimination.md)
  § "Next experiment (… e2e #3 …)"; the run remains spend-gated (~$13–24, n=5+3),
  private instantiation in `tasks/private/` + `knowledge/private/`.*

**For R4 (judge-mediated):**
- Blocked on a **judge-trust milestone** (maps #59/#71). The design deliverable
  is the entry condition: a judge demonstrated to discriminate a known
  silent-wrong diff from its correct sibling, before any priming arm is added.

**For #102 (record-keeping): LANDED 2026-07-27 (zero-spend).**
- The oracle fix shipped as a task-spec + oracle edit, no agent spend: the contract
  key is pinned in the spec (given to both arms) **and** the oracle splits an
  absent-field (`undefined`) naming miss from a present-but-`false` aggregation miss,
  so it isolates the coupling. Re-validated locally (tsc + jest, target restored
  pristine): baseline RED(`undefined`) / naive RED(`false`) / correct GREEN. Recorded
  in `knowledge-payback-discrimination.md` (§ "#102 — oracle fix"). Per §5 the design-G
  re-run still sits in R1 (cold-derivable fact) → most-likely a fifth tie, so it is
  **not** scheduled as an outcome-payback test.

## 8. Scope boundary

This document is **analysis only** — no agent runs, no judge runs, no compile
(~$0.79) triggered, no target touched. It proposes experiments; it runs none of
them. Every run it proposes remains spend-gated on explicit user confirmation,
per the standing local-runs rule, and its private per-target instantiation
(candidate tables, target names, file/field specifics) belongs in the git-ignored
`tasks/private/` + `knowledge/private/`, never in this tracked file.
