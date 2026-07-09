# `tasks/private/` — your own project tasks (git-ignored)

Task prompts for **your** repositories live here and stay **local**. Everything
in this folder is git-ignored except this README and `.gitignore`, so nothing
you drop here ends up in a public clone of the control repo.

Use it for feature/fix tasks aimed at real project repos (the kind that link a
`local_path` in `fleet/repos.yaml`). Keep the version-controlled `tasks/`,
`tasks/examples/`, and `tasks/onramp/` for the shared, reference tasks.

## Running them

The CLI resolves a bare task id here too, so it works exactly like a public task:

```sh
pnpm fleet run <task-id> --repo <name> --local --pr
```

(or pass a full path to a task file anywhere on disk).

## What still gets recorded

Only the **task files** are private. Runs still append to `fleet/ledger.jsonl`
(the shipped/killed record) and open PRs on the target repo — so the *history*
of what ran is preserved even though the prompt text isn't committed here.
