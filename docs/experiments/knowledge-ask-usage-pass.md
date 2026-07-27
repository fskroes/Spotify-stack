# Knowledge-layer ask-path usage pass (design, zero-spend)

**Status:** authored 2026-07-27, **no spend** (design only — no compile, no
agent runs). Design deliverable for the *ideation* half of the knowledge layer:
the shipped `fleet ask` seam (Stage 4 / #87), whose payback #54 measured once and
which map #80 productizes as Stage 6. Companion to the *run-time* half's
experiment docs — [`knowledge-payback-discrimination.md`](knowledge-payback-discrimination.md)
and [`knowledge-payback-regime-map.md`](knowledge-payback-regime-map.md) — which
close outcome-payback on coherent targets and keep only a re-scoped cost bet
alive. This is the sibling design for the half that already shows a positive
signal.

It stays **target-neutral** (this repo is public and scrubbed). The concrete
target list, the verbatim question texts (which name private-target features),
and the recorded result rows all belong in the git-ignored `tasks/private/` +
`knowledge/private/`, exactly as the payback experiments do. The tracked doc
carries the method, the metrics, the tiers, and the go/no-go reads.

## 1. Why now, and what this pass is actually for

The redirect ([regime map §6](knowledge-payback-regime-map.md); prior strategy
note) is to invest in the ideation half, because it is the one showing payback.
But "proven" overstates the evidence: #54 measured **one** private Swift target
(73 files), scored by **one** reader over **three** questions, and its mechanical
leg is the only reproducible part. This pass is the cheapest thing that closes
that gap, and it does **two jobs at once**:

1. **Harden the shipped surface.** #54 ran the *prototype* code at
   `prototype/knowledge-layer/`, which was **deleted** once the spec landed. The
   command a user runs today is a Stage 1–5 reimplementation
   (`packages/cli/src/index.ts:209-242` → `packages/knowledge/src/ask.ts`), and
   it has never been through a real multi-question pass. This is its first live
   exercise: does the shipped pipeline reproduce the prototype's result, and
   where does it break on questions no one hand-picked?
2. **Widen #54 from n=1.** Turn a single Swift datapoint into a table across
   languages and repo sizes — the exact durable form #54's own closing section
   asked for ("each new target arrives carrying its own evidence"). This is what
   converts "one promising prototype run" into "proven," which is the premise the
   whole redirect leans on.

The two jobs pull toward different scopes (hardening needs only the primed arm;
replicating the payback multiple needs the expensive cold arm too), so the pass
is **tiered** — each rung independently spend-gated (§7).

## 2. What #54 established, and the exact gaps to close

Ranked by how load-bearing the claim is, then how thin the evidence is.

| #54 claim | Strength | Gap this pass closes |
|---|---|---|
| Grounded ratio, primed ≥ cold (0.86→1.00, 0.87→0.92) | **Mechanical, reproducible** | Only its *distribution across targets* is unknown — is 1.0-ish placement grounding a Swift artifact or a general property? |
| 4.2× tokens / 2.7× cost / 2.3× wall | Real, but **one target, one model pairing** | Do the multiples replicate off Swift/sonnet? (Tier 2 only.) |
| Actionable + honest legs pass 3/3 | **One reader, three answers** — weakest evidence | Second reader + pre-registered rubric across more answers. |
| Wiring is the weak class ("confidently shallow"; lowest grounding; least saving) | One datapoint; prose data-flows section added as a **hypothesis to re-test** | Does the shipped prose's principal-data-flows section fix wiring shallowness on new targets? |
| Story→brief returns the brief inline (q3 stub bug fixed at source) | Fix landed, **unverified live** | Regression check: confirm the shipped command returns the brief in-reply, never delegates to a file. |

Everything below is built to attack those five rows and nothing else.

## 3. The three rungs

Each rung is a superset of the one before and gated separately.

**Tier 0 — public smoke (fully committable).**
Run the shipped command end-to-end on the public demo target
(`demo-feed-service`): `fleet knowledge compile`, then one `fleet ask` per #52
class, primed only. Purpose is purely mechanical: confirm compile → ask → the
grounded-ratio / drift / wall-clock telemetry all print, the three answer classes
each return something shaped right, and the story→brief regression (§2, row 5)
holds. Results name no private target and **can be committed to this repo** — the
first public evidence the shipped seam works. Est. ~$1 (one compile + three
primed answers).

**Tier 1 — primed-only usage pass (the core).**
Run the same question battery across **N private targets chosen to vary language
and size** (§5), primed only, with light repetition (§4). This is the hardening
pass and the grounded-ratio-across-targets table. It does *not* run the cold arm,
so it is cheap and it is the rung that most directly earns "the shipped ask path
works, grounded, across targets." Result rows → `knowledge/private/`. Est. under
~$10 (primed answers ran ~$0.25–0.58 each in #54; plus one ~$0.79 compile per new
target).

**Tier 2 — cold-vs-primed replication (the expensive proof).**
Add the **cold arm** on a subset of 1–2 new targets (different language/size than
the Swift n=1) to test whether #54's cost/speed multiples replicate. The cold arm
is the 1–7M-token spender, so this rung is where the money is. Optional; only
worth running if Tier 1's grounded signal holds and a replicated *multiple* is
wanted for the record. Est. ~$6–12 on top of Tier 1.

All dollar figures are **extrapolated from #54's transcript, not promises** —
tokens are the least persuasive column (see §4).

## 4. Metrics, and the order to read them

#54's closing note is the instruction: *"tokens are the least persuasive column.
Wall clock, and whether an answer sent the reader back into the repo, are what a
reader actually feels."* So lead with those.

1. **Dead-ends** — count of ungrounded references per answer, from the shipped
   mechanical scorer (`checkGrounding`, printed by `formatAnswerGrounding`). A
   reference that sends the reader back into the repo is the failure the #52 value
   projection ("zero dead-ends") is measured against. Primary readout.
2. **Wall clock** — measured by the harness (`Date.now()` around the CLI call at
   `index.ts:229-233`), never `num_turns` (unreliable, threat #5). Against the
   #52 "time-to-oriented ≤ 2 minutes" projection.
3. **Grounded ratio** — the same mechanical leg, reported as a **distribution
   across targets**, not a precision number. The checker is lenient in both
   directions (threat #2): it under-counts on framework symbols and over-counts
   on basename/dotted matches. Same rules score every answer, so comparisons hold;
   absolute ratios do not.
4. **Reader legs — actionable + honest** (the two HITL legs of the #52 rubric).
   Pre-register the rubric *before* reading (not post-hoc as #54 did), and use
   **two readers** on the same answers to break #54's one-reader weakness. Where a
   cold arm exists (Tier 2), blind the reader to which arm produced the answer.
5. **Tokens / cost** — recorded, reported last. Cumulative across iterations from
   the `stream-json` transcript, never the result envelope (it undercounts an
   exploring run by an order of magnitude — threat, and a measurement trap #54
   flagged).

**Repetition (Tier 1):** 2–3 primed reps on a subset, so per-question variance —
unmeasured in #54 (threat #4) — gets at least a rough read. Cheap on the primed
arm; skip on the cold arm.

## 5. Target selection (criteria only; list → private)

The whole point is to move off the single Swift datapoint, so select for
**spread**, not convenience:

- **Language diversity** — at least one non-Swift, one dynamically-typed if
  available. The map layer is tree-sitter (language-agnostic by design); this
  tests that claim.
- **Size spread** — one small (map fits whole-repo under ~15k tokens, #54's
  regime) and one large enough that the map is budgeted, not whole. Size is where
  the wiring/data-flows hypothesis (§2, row 4) is most likely to move.
- **Already onboarded** where possible, to avoid a compile per target — but a new
  compile is only ~$0.79 and amortises on the second question.
- **A doc-dark target** is *not* wanted here — that is the run-time cost-payback
  regime (R3), a different experiment. Ideation payback is about a human getting
  oriented fast; coherent, well-documented targets are fair game.

The concrete table (names, SHAs, why each was picked) is recorded privately.

## 6. Confound handling (pre-registered)

Carried forward from #54's threats-to-validity, with the decision for each:

1. **"Cold" is not cold** (auto-memory loads; `--bare` forces API billing, which
   the standing local-runs rule forbids). **Decision:** keep memory, label the
   Tier-2 cold arm "warm cold" honestly, matching #54 so the numbers are
   comparable. The primed arm beating a memory-warmed baseline is the *stronger*
   claim, not the weaker one.
2. **Lenient grounding checker.** **Decision:** read ratios as relative
   distributions only (§4.3); never quote an absolute as precision.
3. **One model pairing.** **Decision:** hold the #54 pairing fixed (arms on
   `sonnet`, compile on `opus`) so target is the only moved variable; note model
   as a held constant, not a swept one.
4. **Per-question variance.** **Decision:** the §4 repetition addresses it on the
   primed arm; cold variance stays unmeasured and is stated as such.
5. **`num_turns` unreliable.** **Decision:** harness wall clock only (already how
   the shipped command works).
6. **Reader-count = 1.** **Decision:** two readers + pre-registered rubric (§4.4).

## 7. Spend and scope boundary

- This document is **design only** — no compile (~$0.79), no agent runs, no
  target touched.
- Each tier is **independently spend-gated on explicit user go-ahead** and runs
  **local** (subscription, not API credits) per the standing rule. Tier 0 is
  fully public and the cheapest first rung; Tier 1 is the core; Tier 2 is
  optional and the expensive half.
- Per-target instantiation — the target table, verbatim question texts, and every
  recorded result row — lives in git-ignored `tasks/private/` + `knowledge/private/`,
  never in this tracked file.

## 8. How to read the outcome

- **Ask path proven across targets:** Tier 1 shows dead-ends near zero and wall
  clock inside the ≤2-minute projection across languages and sizes, and both
  readers pass actionable + honest on the great majority of answers. This is the
  result that graduates the seam into Stage 6 with real backing rather than one
  Swift run.
- **Where it's thin surfaces honestly:** if the wiring class stays "confidently
  shallow" even with the shipped data-flows prose section, that is a specific,
  publishable finding about what the prose layer still does not carry — and it
  scopes Stage 6's surface (do not over-promise wiring answers in the app).
- **Sends it back:** if the shipped command's grounded ratio lands materially
  below #54's on comparable targets, the reimplementation regressed against the
  prototype, and that is a build bug to fix **before** any Stage 6 work — exactly
  the de-risking this pass exists to do.

## 9. What this graduates into

Not a one-off experiment. #54's recommended durable form is to **fold a short
version of the comparison into target onboarding** — compile the artifact, ask
two or three questions, record the row — so every new target arrives carrying its
own evidence and the case rests on a growing table. The question battery this
pass validates is that onboarding checklist's first draft. Landing it there (a
follow-up to the `onboard-target` flow) is the productization step that outlives
this pass; it is out of scope here but is the intended destination.

## 10. Deliverables

- [x] **Tier 0 public smoke** on `demo-feed-service` — RAN 2026-07-27, ~$1 local.
      Result rows: [`knowledge/demo-feed-service-ask-smoke.md`](../../knowledge/demo-feed-service-ask-smoke.md).
      Story→brief regression **confirmed** (S returns the brief inline). Surfaced +
      fixed a stub bug: P/W returned an epilogue, not the answer, because the
      inline-return instruction lived only in the S template — hardened at source in
      `buildAskPrompt` (Output contract block + test) and P/W re-verified. **PASS.**
- [x] **Target-neutral question templates** — three #52 classes, anti-recitation
      design ([§11](#11-question-battery--target-neutral-templates)). Authored
      zero-spend, 2026-07-27.
- [ ] **Tier 1 primed-only rows** — instantiate §11 across N private targets +
      the private target table, primed only. *(spend-gated)*
- [x] **Pre-registered reader rubric** (actionable + honest, two readers,
      blind-to-arm) — ([§12](#12-pre-registered-reader-rubric-actionable--honest)).
      Authored zero-spend before any answer exists, 2026-07-27.
- [ ] **Tier 2 cold-arm replication** on a 1–2 target subset — optional.
      *(spend-gated)*
- [ ] **Findings write-up** — grounded-ratio-across-targets table, wiring-class
      verdict, and a go/no-go for Stage 6.

---

## 11. Question battery — target-neutral templates

**Design principle — anti-recitation via an absent capability.** Each target
gets one `{{NEW_CAPABILITY}}`: a small, plausible feature the target does **not**
have today, chosen so it must hook into an existing seam. All three class-questions
are threaded through that one capability. Because the capability is absent, none
of the three answers can be lifted verbatim from the prose layer's fixed sections
or the structural map — the reader must *synthesise* placement, *select-and-trace*
the pathway, and *compose* a brief. That property is what makes the answers
evidence about the artifact rather than a recall test of the compiler. It also
keeps the battery reusable: the same three templates instantiate on any target by
swapping one absent capability.

**Template P — Placement.**
> `{{NEW_CAPABILITY}}` is not in this target yet. Where would it land? Name the
> files and seams a change would touch to add it, in the order you'd open them,
> and say for each whether it is an existing seam to extend or new code. Do not
> implement it — just place it.

**Template W — Wiring.**
> `{{NEW_CAPABILITY}}` would depend on `{{EXISTING_PATHWAY}}`, which this target
> already has. Trace how `{{EXISTING_PATHWAY}}` works today, through the code, in
> the order things happen: what triggers it, what it calls, where state changes,
> where it ends. Describe only the existing pathway — the feature is not built.

**Template S — Story → dispatch-ready brief.**
> Here is a story for this target: "`{{USER_STORY}}`" (it describes
> `{{NEW_CAPABILITY}}`, which the target does not have). Produce a dispatch-ready
> brief a fleet task could act on directly: the files and seams to touch, the
> approach, the constraints to respect, and the verify gate the change must
> satisfy. Return the brief inline in this reply — never defer it to a file.

**Slots.**
- `{{NEW_CAPABILITY}}` — a genuinely-absent, small, single-seam feature. *Absent*
  (else P/W can recite existing prose), *small* (answerable in one pass), and
  *single-seam* (so W has one real pathway to trace, not the whole architecture).
- `{{EXISTING_PATHWAY}}` — the one existing seam `{{NEW_CAPABILITY}}` hooks into;
  the subject of the wiring question. Naming it — rather than asking "how is this
  target wired" — is deliberate: it forces *selection*, which the fixed prose
  sections do not pre-answer for an arbitrary capability, and denies a
  confidently-shallow trace the cover of generic architecture prose.
- `{{USER_STORY}}` — a one-to-two-sentence, user-framed statement of the same
  capability.

**Two checks baked into the templates.** Template S ends with "return the brief
inline … never defer it to a file" — that is the §2 row-5 regression (the q3 stub
bug) written into the question itself, so every story→brief run re-checks it.
Template W names the pathway instead of asking for architecture, so the wiring
shallowness of §2 row 4 has nowhere to hide behind generic prose.

**Instantiation (private).** The verbatim per-target texts — the real capability
name, the chosen `{{EXISTING_PATHWAY}}`, and the story sentence — name
private-target features and are git-ignored. They live in `tasks/private/`
(scaffold: `tasks/private/knowledge-ask-battery.md`); recorded result rows live in
`knowledge/private/`. This tracked doc carries only the templates.

---

## 12. Pre-registered reader rubric (actionable + honest)

**Pre-registration.** This rubric is fixed on 2026-07-27, **before any Tier-1/2
answer exists** (zero-spend). Criteria are frozen for the pass. A criterion that
proves ambiguous in use is *logged against the answer*, not edited mid-pass; any
revision is a new dated version applied only to a fresh batch, never retro-applied.
This is the discipline #54 lacked — it read its two human legs post-hoc, after the
answers were in hand.

**Scope.** This rubric covers only the two HITL legs — *actionable* and *honest*.
The *grounded* leg is mechanical (`checkGrounding` / `formatAnswerGrounding`,
§4.1) and is scored by the tool, not the reader. Readers are kept **blind to the
grounded ratio** (see Blinding) so the human judgement stays independent of the
machine's number.

**Actionable — pass requires ALL of:**
- **A1.** Names concrete landing points — specific files / symbols / seams — not
  just descriptions of areas.
- **A2.** Each named point is specific enough to open directly; no "somewhere in
  the X layer."
- **A3.** The class-shape is complete: *placement* gives a usable open-order and
  entry point; *wiring* gives a step-to-step trace a reader can follow without
  gaps; *story→brief* carries approach + constraints + verify gate (the
  dispatch-ready shape).
- **A4.** The reader could act without reopening the repo to reconstruct missing
  structure from their own prior knowledge.

Fail if any of A1–A4 is unmet.

**Honest — pass requires ALL of:**
- **H1.** Every confident claim is one the answer actually supports; no thin
  coverage asserted as complete.
- **H2.** Where the two layers are insufficient, the answer says so (a gap /
  Unknowns admission) rather than inventing a path or symbol to finish.
- **H3.** No claim contradicts the map or prose the reader can see.
- **H4.** Uncertainty is marked as uncertainty — drift-flagged claims are flagged,
  not stated as fact.

Fail if any of H1–H4 is unmet.

**Mandatory shallow-flag (separate from pass/fail).** Regardless of the two
verdicts, each reader records a `confidently-shallow?` yes/no per answer: organised
and correct on its face, but thinner than its presentation implies. #54's most
valuable finding was a wiring answer that passed both legs and was still shallow;
keeping this as a side-annotation rather than a fail criterion holds the bar
**identical to #54** (a pre-registered confound, §6) while still capturing the
finding. The wiring-class data-flows hypothesis (§2 row 4) is read off this flag's
distribution across targets, not off pass/fail.

**Two readers.** Both score independently from the same answer text, no discussion.
Per answer, per leg, each reader records: pass/fail + a one-line justification +
the shallow flag. Then:
- both pass, or both fail → that is the leg's verdict.
- **split** (one pass, one fail) → the verdict is `split`, recorded as such. A
  split is not averaged and is not broken by a silent third read — the disagreement
  is itself a finding about how repeatable the human legs are. A short
  reconciliation note may be added, but the raw split is always preserved.
- Report the **inter-reader agreement rate** (share of legs where the two agreed)
  as a first-class number. That rate — not the pass counts — is what actually
  retires #54's one-reader weakness.

**Blinding.**
- *Tier 2 (cold arm present):* before reading, strip arm labels (primed / cold)
  **and** all telemetry (tokens, cost, wall clock) from the answer text; present
  answers id-only in randomised order; readers score; unblind and re-join to arms
  **only after both readers have committed** their scores.
- *Tier 0/1 (primed only):* there is no arm to blind, but readers are still kept
  blind to the mechanical grounded ratio and telemetry, so the human legs never
  anchor on the machine's number.

**Recording.** Each row — answer id, target, class, reader identity, date, blind
status, the two leg verdicts, the one-line justifications, and the shallow flag —
lands in `knowledge/private/` with the result rows, never in this tracked file.
