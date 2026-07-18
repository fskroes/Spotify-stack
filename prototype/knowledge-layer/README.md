# Knowledge-layer prototype (wayfinder #54)

Throwaway prototype for the core bet behind map #50:

> a pre-compiled knowledge artifact answers a feature question **better and cheaper**
> than cold exploration.

It builds the artifact in the form decided in #53 — an ephemeral tree-sitter map fused with a
SHA-stamped generated prose layer — asks the #52 must-handle question classes with and without it,
and measures tokens and grounding on both sides.

The comparison and the verdict live in
[`docs/knowledge-layer-prototype-comparison.md`](../../docs/knowledge-layer-prototype-comparison.md).

## Where the evidence is

The prototype was run against a **private fleet target** (a 73-file Swift macOS app), because the
bet had to be tested on a repo the human can actually judge answers about. Its artifact and the six
answers therefore name that target's real files, so `evidence/` is **git-ignored** — this repo is
public and names no private target. Regenerate it locally with the commands below; the comparison
doc carries the numbers.

## Why it is outside the workspace

This directory is deliberately **not** a pnpm workspace package and **not** part of the root
`vitest` run. It carries native `tree-sitter` grammars that the fleet does not otherwise depend on,
and it is meant to be deleted once the spec (#55) lands. Nothing in `packages/` or `apps/` imports
it.

```sh
cd prototype/knowledge-layer
npm install --legacy-peer-deps   # tree-sitter-typescript declares an older peer than tree-sitter-swift
npm test
```

## The pieces

| File | What it owns |
| --- | --- |
| `src/parse.ts` | Tree-sitter definition/reference extraction per language (Swift, TS/TSX/JS). |
| `src/rank.ts` | PageRank over the file dependency graph — rank flows toward depended-on code. |
| `src/select.ts` | Per-file declaration cap: types, then functions, then properties. |
| `src/budget.ts` | Token estimate and greedy budget fill. |
| `src/map.ts` | Layer 1: the ranked, budgeted map — plus the repo index the grounding check uses. |
| `src/prose.ts` | Layer 2: compiles the prose layer once, SHA-stamped, via `claude -p`. |
| `src/experiment.ts` | The two arms — identical question, identical tools, different starting knowledge. |
| `src/grounding.ts` | Mechanical half of the #52 rubric: does every file/symbol named actually exist? |
| `src/cli.ts` | `map` / `prose` / `experiment` / `drift` / `grade`. |

## Running the comparison

`--repo` takes any local git repo; `--name` just keys the output files.

```sh
# Layer 1 only — inspect the map at any budget
npx tsx src/cli.ts map --repo=<path> --budget=6000

# Layer 2 — compile the prose artifact (once, at "onboarding")
npx tsx src/cli.ts prose --repo=<path> --name=<target> --model=opus

# Both arms, all three question classes (edit src/questions.ts for a different repo)
npx tsx src/cli.ts experiment --repo=<path> --name=<target> --model=sonnet

# Grounding + cost table over whatever runs exist
npx tsx src/cli.ts grade --repo=<path> --name=<target>

# Is the stored prose still confirmed by a map rebuilt at the current SHA?
npx tsx src/cli.ts drift --repo=<path> --name=<target>
```

Everything lands in `evidence/`: the prose layer, the rendered map, one `.md` + `.json` per
arm-run, and the grading table.

## Honest limits

- **One repo, one model pairing.** Arms run on `sonnet`; the prose compile runs on `opus`.
  A different pairing may move the numbers.
- **Grounding is mechanical, judgement is human.** The checker verifies existence at the pinned
  SHA. *Actionable* and *honest* stay with the reader — this is a HITL wayfinder ticket.
- **Reference precision is shallow.** References are name matches, not resolved symbols, so
  ranking is approximate (good enough for ordering, not for blast-radius questions — which #52
  already put outside the must-bar).
- **The runs are not `--bare`.** Hooks, user settings, and per-project auto-memory load in both
  arms alike, so the "cold" arm is not truly cold. See the comparison's threats-to-validity.
