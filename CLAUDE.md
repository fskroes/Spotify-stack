# Working in this repo

A Honk-style background coding agent fleet. Read [`docs/README.md`](docs/README.md)
first — it maps what each package owns and which seams carry the design weight.
[`CONTEXT.md`](CONTEXT.md) defines every load-bearing term; use those words.

## Two rules that will bite you

**1. This repo is public; the fleet targets are not.** Never commit a private
target's name, path, or prose. They live only in git-ignored
`fleet/repos.local.yaml`, `tasks/private/`, `knowledge/private/`, and
`fleet/evidence/`. `scripts/check-scrub.sh` enforces it — run
`git config core.hooksPath .githooks` once so the pre-commit hook catches it
before CI does.

**2. Docs here do not explain what the code does.** That prose drifts the moment
the code changes, and a confidently wrong doc is worse than no doc. Before adding
a document, classify it:

| It is… | It goes… |
|---|---|
| a decision, with an alternative that lost | `docs/adr/` |
| a term whose meaning a type name can't carry | `CONTEXT.md` |
| a measurement, survey, or prototype result | `docs/` or `docs/experiments/`, dated |
| an explanation of how code works | **nowhere** — comment it in place, or improve the naming |

Never revise a research or experiment doc to agree with later code. Never rewrite
an ADR to agree with later code — supersede it and link back.

## Before changing behaviour

Check whether an ADR already decided it. Notably:

- The agent may only edit files and call `verify`; the runner owns git, the
  network, and every side effect ([ADR-0003](docs/adr/0003-the-runner-owns-git.md)).
  A new agent capability is a cage change, not a feature.
- Verification is a tri-state and never a boolean; a false green is the one
  output this system may not produce
  ([ADR-0004](docs/adr/0004-verification-tri-state-and-mandated-gates.md)).
- Every runner↔operator wire shape is declared once in `@fleet/contract` and read
  tolerantly ([ADR-0001](docs/adr/0001-tolerant-reader-wire-contract.md)).
- The verification tree holds a gate input the task did not `amends:` at the
  base, and *which* files are gate inputs is a convention in the runner — never
  per-target configuration
  ([ADR-0014](docs/adr/0014-gate-inputs-are-carried-only-under-an-amendment.md),
  [ADR-0020](docs/adr/0020-the-gate-input-set-is-a-convention.md)).
- `fleet cosign` has no `--force`, deliberately
  ([ADR-0005](docs/adr/0005-operator-drives-the-cli-over-ssh.md)).

## Commands

```sh
pnpm install
pnpm test        # unit + hermetic e2e (real eslint/tsc/vitest in temp workspaces)
pnpm scrub       # the public-repo scrub check CI runs
pnpm fleet --help
```

Dry-run is the default for every fleet command; `--pr` opts into side effects.
