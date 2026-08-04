# Docs map

A **thin navigation layer**, deliberately. This repo's docs do not restate what
the code does — the code says that, and prose about it drifts the moment the
code changes. Docs here hold the two things code cannot say:

- **Why this and not the alternative** → [`adr/`](adr) (decisions, with the
  rejected options attached) and [research + experiments](#research-and-evidence)
  (the evidence a decision rested on, including the evidence that weakened one).
- **What the words mean** → [`../CONTEXT.md`](../CONTEXT.md), the domain
  glossary. Every load-bearing term in this codebase is defined there once.

Everything else on this page is a **pointer**, so a reader — human or agent —
can get to the right file without a full-tree search.

## Start here

| You want | Read |
|---|---|
| To use the fleet | [`../README.md`](../README.md) |
| To trust the fleet first | [`../ONRAMP.md`](../ONRAMP.md) |
| To understand a term | [`../CONTEXT.md`](../CONTEXT.md) |
| To know why something is the way it is | [`adr/`](adr) |
| To change code | this page, then the seam table below |

## Where the code lives, and what each part owns

One line per unit: **what it owns**, not how it works. Open the source for how.

| Unit | Owns |
|---|---|
| [`packages/cli`](../packages/cli) | The `fleet` verbs: `run`, `dispatch`, `status`, `report`, `cosign`, `knowledge {map,compile,drift}`, `ask`. Argument parsing and nothing else — every verb delegates. |
| [`packages/runner`](../packages/runner) | The run loop and **everything with side effects**: workspace, engine spawn, scope gate, verify gate, judge loop, git, PR, ledger, artifacts, evidence, the operator HTTP API. See [ADR-0003](adr/0003-the-runner-owns-git.md). |
| [`packages/mcp-verify`](../packages/mcp-verify) | Verifier **detection** and execution — what checks a repo offers and whether they pass. Task-blind by construction; the runner folds in [mandated gates](../CONTEXT.md#mandated-gate). Plain JS, no build step. |
| [`packages/intake`](../packages/intake) | The front door: drafts a task file from an intent (`fleet draft`) — a drafter, never a runner — and the correction log's three-valued drafted-vs-approved rule. No I/O, no side effects. |
| [`packages/judge`](../packages/judge) | The LLM-as-judge verdict: task + diff + verify summary → approve/veto with reasoning. |
| [`packages/judge-read`](../packages/judge-read) | The judge's [cage](../CONTEXT.md#cage): the one declaration of its read tool surface, and the reader rooted at a workspace. Owns no transport. See [ADR-0011](adr/0011-the-runner-owns-the-judges-reads.md). Plain JS, no build step. |
| [`packages/contract`](../packages/contract) | The [wire contract](../CONTEXT.md#wire-contract) — schemas and tolerant parsers for everything the runner tells the operator. The only place a wire shape is declared. See [ADR-0001](adr/0001-tolerant-reader-wire-contract.md). |
| [`packages/knowledge`](../packages/knowledge) | Structural maps, compiled [knowledge prose](../CONTEXT.md#knowledge-prose), [grounding](../CONTEXT.md#grounding-ratio) and [drift](../CONTEXT.md#drift) checks, and the `ask` seam. See [ADR-0006](adr/0006-pre-compiled-knowledge-layer.md). |
| [`apps/operator-desktop`](../apps/operator-desktop) | The Tauri workbench. Reads the contract, drives the CLI over SSH, and owns **no** fleet logic of its own. See [ADR-0005](adr/0005-operator-drives-the-cli-over-ssh.md). |
| [`agent-config/`](../agent-config) | The agent's cage: permission allowlist, MCP config, Stop hook. Injected into each workspace as `.claude/`. |
| [`tasks/`](../tasks) | Version-controlled task prompts + the [`TEMPLATE.md`](../tasks/TEMPLATE.md) that documents every frontmatter field. |
| [`fleet/`](../fleet) | `repos.yaml` (target registry), `ledger.jsonl` (every run, shipped or killed), `evidence/` (the canonical per-run record: model-usage documents, and the [retained kill](../CONTEXT.md#retained-kill) a killed run leaves behind). |
| [`.github/workflows/`](../.github/workflows) | Thin wrappers around the same CLI — cloud is a dispatch mechanism, not a second implementation. |

### The seams worth knowing

Four boundaries carry most of this system's design weight. Cross one carelessly
and you break an invariant that has an ADR behind it.

1. **Agent ↔ runner** — the agent proposes file edits; the runner does
   everything else. [ADR-0003](adr/0003-the-runner-owns-git.md)
2. **Runner ↔ operator** — `@fleet/contract`, read tolerantly.
   [ADR-0001](adr/0001-tolerant-reader-wire-contract.md)
3. **Verification ↔ run** — verification says what the repo offers and whether
   it passed; the run composes that with mandated gates into a state.
   [ADR-0004](adr/0004-verification-tri-state-and-mandated-gates.md)
4. **Run ↔ evidence** — the ledger is a compact projection; the canonical record
   lives in `fleet/evidence/`, and per-run artifacts survive same-task reruns.
   [ADR-0002](adr/0002-model-usage-evidence-contract.md),
   [ADR-0007](adr/0007-per-run-artifact-archive.md)

A fifth rule cuts across all of them: a run's status carries its domain facts in
exactly one table, never a `switch` per surface
([ADR-0008](adr/0008-one-status-facts-table.md)).

## Decisions

[`adr/`](adr) — one file per decision, each carrying the alternatives that were
rejected and why. Read [`adr/README.md`](adr/README.md) for the index and when
to add one.

## Research and evidence

Point-in-time documents. They are **not** maintained against the code; each is
stamped with the date it was true, and its value is the reasoning and the
measurements, not its current accuracy.

| Document | What it settles |
|---|---|
| [`codebase-knowledge-prior-art-research.md`](codebase-knowledge-prior-art-research.md) | Six existing forms of pre-compiled codebase understanding, surveyed against this fleet's two consumers. Notes that Honk itself declines the bet. |
| [`2026-07-31-honk-provenance-research.md`](2026-07-31-honk-provenance-research.md) | What Honk actually is, from first-party sources only: an internal Spotify codename, not a product, with its cage, verify loop and judge documented in prose and no source published. Includes a claim audit that marks five circulating capability claims supported, overstated, or `UNVERIFIED`. |
| [`knowledge-layer-prototype-comparison.md`](knowledge-layer-prototype-comparison.md) | The throwaway prototype that measured primed vs. cold answering: 4.2× cheaper on tokens, a modest quality win. |
| [`knowledge-layer-spec.md`](knowledge-layer-spec.md) | The spec the built knowledge layer was handed off from. Written before the build; read it for intent, not for current shape. |
| [`judge-cage-spec.md`](judge-cage-spec.md) | The build handoff for [ADR-0011](adr/0011-the-runner-owns-the-judges-reads.md) — the read module's shape, the two transports' flags, and how an unavailable read tool is detected. Written before the build. |
| [`experiments/knowledge-payback-discrimination.md`](experiments/knowledge-payback-discrimination.md) | The run-time half, measured for real — and the result that **weakened** the payback bet. The counter-evidence is kept on purpose. |
| [`experiments/knowledge-payback-regime-map.md`](experiments/knowledge-payback-regime-map.md) | After four ties, the step back: for which class of fact could run-time priming pay back *at all*. Characterizes the regime space and recommends what to keep open. |
| [`experiments/knowledge-ask-usage-pass.md`](experiments/knowledge-ask-usage-pass.md) | The design pass for the ideation half — the [`ask`](../CONTEXT.md#ask) seam — which is the half showing a positive signal. Method, metrics, and tiers; target-neutral by construction. |
| [`experiments/2026-07-29-judge-discrimination-matched-pair.md`](experiments/2026-07-29-judge-discrimination-matched-pair.md) | The judge shown to discriminate, not merely concur: one task, two diffs differing in one false fact, control approved and wrong vetoed against a pass condition pre-registered in code. The evidence [ADR-0011](adr/0011-the-runner-owns-the-judges-reads.md) rested on — and the finding that a question about one component belongs at that component's seam, where it cost $0.54 rather than the pipeline's $6.36. |
| [`experiments/2026-08-02-reconstituted-verification-tree-cost.md`](experiments/2026-08-02-reconstituted-verification-tree-cost.md) | The number [ADR-0013](adr/0013-verification-runs-on-the-shipped-artefact.md) declared missing, measured on both live targets: the per-run install is ~1 second, the retreat is not worth taking, and the cost that matters is the lost build cache rather than the install. |
| [`experiments/2026-08-03-tree-construction-on-live-targets.md`](experiments/2026-08-03-tree-construction-on-live-targets.md) | The tree ADR-0013 now ships, run against both live targets outside fixtures: it builds on a target with no package manager and on a real nested lockfile, and the harness cage does not reach it even where the target commits a `.claude/` of its own. Carries a defect it walked around — `prepareWorkspace`'s local copy does not exclude `target/`. |
| [`experiments/2026-08-04-walking-the-cosign-line.md`](experiments/2026-08-04-walking-the-cosign-line.md) | One shipped run walked to a co-sign decision, measuring what the walk costs a reader and which surfaces claim more than the run proved. Finds the runner's GitHub credential unreachable over [ADR-0005](adr/0005-operator-drives-the-cli-over-ssh.md)'s non-interactive channel, an empty co-sign map that cannot say why it is empty, and the test suite evicting every real run's per-run archive — correcting [ADR-0015](adr/0015-a-kill-is-retained-forever-and-blinded.md)'s account of that eviction. Carries the surfaces it checked and found honest. |
| [`experiments/2026-08-04-the-gate-input-convention-against-history.md`](experiments/2026-08-04-the-gate-input-convention-against-history.md) | [ADR-0020](adr/0020-the-gate-input-set-is-a-convention.md)'s constant run over 147 commits of live-target history, `git log` only. No false positive in either target, so an approximate list is as cheap as the record claimed; nine of seventeen globs idle, and none of them should go. Two findings the ADR does not carry: on the Xcode target an `amends:` is the rule rather than the exception, and the convention is built from `detect()` while the check set is `detect()` plus every registered verifier — measurably, a Cargo manifest on 23.7% of one target's commits. |
| [`rust-gpui-port-research.md`](rust-gpui-port-research.md) | Whether the fleet could be ported to Rust + GPUI, and what it would bring. Verdict: port nothing — Node survives as a subprocess dependency either way, so the headline benefit is not on offer, and the operator's hard part is already Rust. Carries what would have to become true to flip either half. |
| [`conductor-ui-ux-research.md`](conductor-ui-ux-research.md) | Conductor's interaction model, recorded as design input for the operator. Explicitly not a requirements document. |
| [`agents/issue-tracker.md`](agents/issue-tracker.md) | How issues, PRDs, and wayfinder maps are operated with `gh`. |

## The rule for adding docs here

Before writing a doc, ask which of these it is:

- **A decision** (something was chosen over something else) → an ADR.
- **A word** (a term whose meaning is not obvious from a type name) →
  [`../CONTEXT.md`](../CONTEXT.md).
- **Evidence** (a measurement, a survey, a prototype result) → `docs/` or
  `docs/experiments/`, dated, never revised into agreement with later code.
- **How the code works** → **do not write it.** Put it in the code as a comment
  next to the thing it explains, or improve the naming until it isn't needed.
