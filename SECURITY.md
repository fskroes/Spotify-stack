# Security policy

## Reporting a vulnerability

**Report privately, not in a public issue.**

Use GitHub's private vulnerability reporting: the repository's
[Security tab](../../security/advisories/new) → *Report a vulnerability*. That
channel is private to the maintainers and is the only supported one — this repo
publishes no contact address on purpose.

Please include what you were running (`fleet` command and flags), what you
expected the gate to do, and what it did instead. A reproduction against the
demo repos in `demo-repos/` is ideal, since those are public.

This is a single-maintainer reference implementation, not a product. Expect a
first response within about a week, and no formal SLA beyond best effort. There
are no release channels or backported versions — fixes land on `main`.

## What this project treats as a security boundary

The design rests on the agent being unable to act outside its cage. Anything
that breaks one of these is a vulnerability, not a bug:

| Boundary | The break to report |
|---|---|
| **The agent's cage** | The agent process reaching git, the network, or a shell beyond its allowlist — including via the `verify` MCP tool or a Stop hook escape. [ADR-0003](docs/adr/0003-the-runner-owns-git.md) |
| **The verify gate** | Any path that reports a run green when its checks did not pass, or that turns *unverifiable* into *passed*. A false green is the one output this system may not produce. [ADR-0004](docs/adr/0004-verification-tri-state-and-mandated-gates.md) |
| **The scope gate** | A diff reaching a PR with files outside the task's scope contract. |
| **The co-sign gate** | `fleet cosign --merge` merging a run this machine did not ship, or one GitHub does not report open and cleanly mergeable. There is deliberately no `--force`. [ADR-0005](docs/adr/0005-operator-drives-the-cli-over-ssh.md) |
| **The scrub denylist** | A path by which a private target's name, path, or prose reaches a public commit past `scripts/check-scrub.sh`. [ADR-0010](docs/adr/0010-the-scrub-denylist-is-the-leak.md) |
| **The operator HTTP API** | Reading anything outside the allowlisted artifact set beneath the configured `artifacts/` root — path traversal, symlink escape, transcripts, or unlisted files. The server binds `127.0.0.1`. |
| **The operator SSH surface** | Executing shell beyond the derived, non-editable `cd -- <remote-repo> && exec pnpm fleet` prefix. |
| **Credential handling** | Any path that writes `ANTHROPIC_API_KEY`, a GitHub token, or an SSH private key into artifacts, the ledger, evidence, transcripts, or logs. |

## Known limitations, not vulnerabilities

These are accepted properties of the design. Reporting them is fine, but they
are documented trade-offs rather than defects:

- **Task prompts and target repo contents are trusted inputs.** An agent reading
  a target repo can be influenced by text inside it. The mitigation is the cage
  plus the three gates — a manipulated agent still cannot touch git, still has to
  produce an in-scope diff that passes deterministic checks, and still has to get
  past a judge and a human co-signer. Point the fleet at repos you trust.
- **A repo with no detectable checks passes the verify gate vacuously.** This is
  reported as *unverifiable*, not green. Confirm what the gate will run before
  dispatching a task — see [`docs/README.md`](docs/README.md).
- **The LLM judge is not a security control.** It is a quality gate that can be
  wrong in both directions. The mechanical gates and the human co-sign are the
  controls.
- **`--pr` and `fleet dispatch` do real things.** Dry-run is the default
  everywhere precisely because the non-default is consequential.
- **Vulnerabilities in Claude Code, the Anthropic API, or `gh`** belong upstream,
  not here. Report those to their vendors.

## Handling private targets

`fleet/ledger.jsonl` is tracked but held back with
`git update-index --skip-worktree`, because every local run appends lines naming
the repos you ran against. If you believe you have published a private target's
name, treat it as a disclosure incident: rotate nothing, but rewrite the history
and add the term to the `IDENTIFIERS` list at the top of
`scripts/check-scrub.sh` so the hook catches it next time.
