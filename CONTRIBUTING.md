# Contributing

Thanks for looking. This is a reference implementation maintained by one person,
so the fastest path to a merged change is a small one that clears the gates on
its own.

## Two rules that will bite you

**1. This repo is public; the fleet targets are not.** Never commit a private
target's name, path, or prose. They live only in git-ignored
`fleet/repos.local.yaml`, `tasks/private/`, `knowledge/private/` and
`fleet/evidence/`. Run this once, before your first commit:

```sh
git config core.hooksPath .githooks
```

That points git at the committed pre-commit hook that runs
`scripts/check-scrub.sh` over your staged changes. CI runs the same script over
`HEAD` (`pnpm scrub`) as the backstop — but the hook is what saves you from
having to rewrite history. Git cannot enable a hook on clone, which is why this
step is manual.

**2. Docs here do not explain what the code does.** That prose drifts the moment
the code changes, and a confidently wrong doc is worse than no doc. Before adding
a document, classify it:

| It is… | It goes… |
|---|---|
| a decision, with an alternative that lost | `docs/adr/` |
| a term whose meaning a type name can't carry | `CONTEXT.md` |
| a measurement, survey, or prototype result | `docs/` or `docs/experiments/`, dated |
| an explanation of how code works | **nowhere** — comment it in place, or improve the naming |

Never revise a research or experiment doc to agree with later code. Never
rewrite an ADR to agree with later code — supersede it and link back.

## Setup

```sh
corepack enable pnpm && pnpm install
git config core.hooksPath .githooks
pnpm test
```

Node ≥ 20. Rust is only needed for the optional desktop operator
(`pnpm operator`).

## Before you push

```sh
pnpm test        # unit + hermetic e2e (real eslint/tsc/vitest in temp workspaces)
pnpm typecheck
pnpm scrub
```

All three run in CI. A PR that fails any of them will not be reviewed until it
passes — the same standard the fleet's own runs are held to.

## Changing behaviour

Check whether an ADR already decided it. [`docs/adr/`](docs/adr) holds twelve
decisions, each carrying the option that lost. The ones most likely to catch you:

- The agent may only edit files and call `verify`; the runner owns git, the
  network, and every side effect
  ([ADR-0003](docs/adr/0003-the-runner-owns-git.md)). **A new agent capability
  is a cage change, not a feature** — open an issue before writing it.
- Verification is a tri-state and never a boolean; a false green is the one
  output this system may not produce
  ([ADR-0004](docs/adr/0004-verification-tri-state-and-mandated-gates.md)).
- Every runner↔operator wire shape is declared once in `@fleet/contract` and read
  tolerantly ([ADR-0001](docs/adr/0001-tolerant-reader-wire-contract.md)).
- `fleet cosign` has no `--force`, deliberately
  ([ADR-0005](docs/adr/0005-operator-drives-the-cli-over-ssh.md)).

If your change contradicts one of these, that is not automatically a no — but it
needs a **new ADR that supersedes the old one**, not a quiet edit. See
[`docs/adr/README.md`](docs/adr/README.md) for the format and when to add one.

[`docs/README.md`](docs/README.md) maps what each package owns and the four seams
that carry the design weight. Read it before crossing one.

## Contributing a task prompt

Task prompts are code here — they are version-controlled, reviewed, and
validated. `fleet draft` is the only path that authors one; the frontmatter
fields are documented on the `Task` type in
[`packages/runner/src/task.ts`](packages/runner/src/task.ts), and
[`tasks/examples/`](tasks/examples) are working examples. A prompt worth
merging carries an end state, preconditions (with the `NO_CHANGES_NEEDED`
sentinel), before/after examples, a verifiable goal, and an atomic scope.

Validate with `scripts/validate-task.ts`. Prompts that only make sense against a
private target belong in your git-ignored `tasks/private/`, not in a PR.

## Pull requests

- **One concern per PR.** The same atomic-scope rule the fleet applies to its own
  tasks.
- **Commit messages** follow the existing log: `type: imperative summary`, with
  an ADR reference in parentheses when the change is governed by one — e.g.
  `fix: the scrub check could not see 2287 lines of the operator`.
- **New behaviour needs a test.** The hermetic e2e suite in
  `packages/runner/test/e2e.test.ts` is the model for anything touching the run
  loop; it uses real verifiers and a stubbed judge.
- **Bug reports beat guesses.** If you are not sure whether something is a bug or
  a decision, open an issue and ask — it is often in an ADR.

## Agent-authored contributions

This repo is a coding agent fleet, so agent-written PRs are expected and welcome.
Two conditions: say so in the PR description, and hold them to exactly the
standard above — you are the co-signer, and an unreviewed agent diff is your
name on someone else's work.

## Code of conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
