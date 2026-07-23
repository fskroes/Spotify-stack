# Discriminating knowledge-payback e2e (issue #91)

**Status:** designed + harnessed, **not yet run**. The real-spend run is a
separate authorized session (per #91). This document is the target-neutral
method: the question, the discrimination model, the harness, and how to read a
result. The concrete candidate analysis for the chosen private fleet target
lives with that target's private task definition (git-ignored `tasks/private/`),
because this repo is public and scrubbed of target names.

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

## Scope boundary of this work

This session **designed, authored, and harnessed only**. No fleet run was
launched and nothing was spent. Executing the real-spend run — and recording its
SUMMARY — is a separate authorized session, per #91 and the operator's explicit
choice.
