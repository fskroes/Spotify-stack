# The desktop operator drives the existing CLI over SSH

[`apps/operator-desktop`](../../apps/operator-desktop) is a viewing and
triggering surface, not a second implementation of the fleet. It holds **no**
fleet logic: it does not clone repos, write artifacts, touch git, or open pull
requests. Everything it makes happen, it makes happen by running the same
`fleet` commands a human would run on the runner machine.

The mechanism is one managed SSH process starting `fleet report --serve` on the
runner and forwarding its loopback port to a local port, plus separate SSH
invocations for dispatch (`fleet dispatch`, `fleet run --local`) and co-sign
(`fleet cosign`). The command prefix is **derived**, not configured:
`cd -- <remote-repo> && exec pnpm fleet`. It is displayed to the user and cannot
be replaced with arbitrary shell.

## Considered options

**A daemon or agent installed on the runner.** Rejected: it is a second thing to
version, and the moment it exists it starts accumulating logic that diverges from
the CLI. The runner already has a complete interface — the CLI — and every
capability the app needs is a capability a human needs anyway.

**Let the app reach GitHub and the target repos directly.** Rejected because it
would give a desktop application the credentials to merge pull requests, and
because the [ledger gate](#the-co-sign-gate-lives-in-the-cli) that makes co-sign
safe lives on the runner. The app deliberately holds no SSH private keys and no
GitHub token; it uses the Mac's existing OpenSSH agent/keychain, and `gh` runs on
the runner under the runner's own auth.

**A configurable remote command string.** Rejected: a text field that becomes
`ssh <host> <anything>` is a remote shell with a friendly label. Deriving the
prefix from the profile's repo path keeps the surface fixed and inspectable.

**An interactive SSH session.** Connections are non-interactive
(`ssh -o BatchMode=yes`, no stdin) so a run can never block on an invisible
password or host-key prompt. The cost is real and accepted: the runner's
non-login shell must be able to find `node`, `pnpm`, and `gh` — from `~/.zshenv`,
not from an interactive profile. That is why setup asks you to verify
`gh auth status` over the same channel *once*, rather than discovering it during
your first merge.

## The co-sign gate lives in the CLI

`fleet cosign <runId> --merge` refuses unless the run shipped from this machine
(`approved`, local, PR opened) and GitHub reports the PR open and cleanly
mergeable. Refusals are structured and named (`run-not-found`, `not-shipped`,
`no-pr`, `already-merged`, `already-closed`, `conflicts`, `not-mergeable`,
`merge-failed`, `close-failed`), and `--json` emits them for machine consumers.

**There is deliberately no `--force`.** A refusal is the gate working, and an
escape hatch would be used exactly when it should not be. Adding one is a
decision that supersedes this record, not a convenience.

Because the gate is in the CLI, the app inherits it for free and cannot bypass
it — which is the same reason the app has no direct GitHub path.

## Consequences

- **Nothing new is written to the ledger by a co-sign.** GitHub stays the source
  of truth for [PR live state](../../CONTEXT.md#pr-live-state), which `--cosign`
  polling reads back. The ledger records runs; it does not record human decisions.
- The app and the runner checkout are **routinely at different commits**. That is
  the premise of [ADR-0001](0001-tolerant-reader-wire-contract.md) and the reason
  every wire read goes through `@fleet/contract`.
- Cloud synchronization is not automatic. Actions commits ledger lines to
  `origin/main` and stores artifacts in Actions, while the server reads the
  runner machine's local checkout. A dispatched cloud completion does not appear
  merely because dispatch was accepted — that gap is known and named rather than
  papered over.
- Artifact reads over the API are allowlisted to the `REVIEW_ARTIFACTS` set
  (`packages/runner/src/artifacts.ts`; the README carries the reader-facing copy,
  drift-locked by test). Transcripts are not review-safe and are not served. That
  one allowlist is shared with the per-run archive and cloud sync
  ([ADR-0007](0007-per-run-artifact-archive.md)), so the three cannot drift into
  disagreeing about what a reviewer may see.
