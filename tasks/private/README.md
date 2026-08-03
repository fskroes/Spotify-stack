# `tasks/private/` — your own project tasks (git-ignored)

Task prompts for **your** repositories live here and stay **local**. Everything
in this folder is git-ignored except this README and `.gitignore`, so nothing
you drop here ends up in a public clone of the control repo.

Use it for feature/fix tasks aimed at real project repos (the kind that link a
`local_path` in the git-ignored `fleet/repos.local.yaml`). Keep the
version-controlled `tasks/`, `tasks/examples/`, and `tasks/onramp/` for the
shared, reference tasks.

## Running them

The CLI resolves a bare task id here too, so it works exactly like a public task:

```sh
pnpm fleet run <task-id> --repo <name> --local   # dry run, based on your HEAD
pnpm fleet run <task-id> --repo <name> --pr      # ships, based on upstream
```

(or pass a full path to a task file anywhere on disk).

The two answer different questions, so they can disagree — `--local` asks
whether the change works against your committed work, `--pr` against what
everyone has. `--local` is why the first is offline; it is ignored by the second
(ADR-0019), which is why it is absent there rather than merely harmless.

### What a dry run certifies, and what it does not

**They are two independent agent runs.** The `--pr` run does not ship the dry
run's diff; it re-rolls the agent from a fresh clone of upstream (ADR-0019). The
same task file run twice produces two samples, and they can differ in ways a
person would notice while both satisfy the task and pass every check — measured
on 2026-08-03, where two runs landed on different component structures and
different placements of the same control, both green. The artifact directory is
keyed by task and repo, not by run, so the second run also **overwrites the
first's `diff.patch`**.

So a dry run certifies the **task file**: that the agent reads the authorities
you named, that `scope:` holds, that `gates:` map to check names that exist, and
that a registered verifier actually runs. That is worth the money on a task's
first run against a target.

It certifies nothing about the change that will ship. To review that, read the
PR, or check the branch out and run it:

```sh
git -C <target> fetch origin agent/<task-id>
git -C <target> checkout agent/<task-id>
```

## What still gets recorded

Only the **task files** are private. Runs still append to `fleet/ledger.jsonl`
(the shipped/killed record) and open PRs on the target repo — so the *history*
of what ran is preserved even though the prompt text isn't committed here.
