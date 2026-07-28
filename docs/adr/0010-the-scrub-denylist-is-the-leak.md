# The scrub check asserts that a scrub ran; it does not carry the private list

`scripts/check-scrub.sh` is the enforcement behind this repo's one
non-negotiable rule: it is public, and the fleet's real targets are not. The
script works by grepping every tracked file for a denylist of banned terms.

**That denylist is written in plaintext, in the script, in the public repo, and
the script exempts itself from its own scan.** So the file whose job is to keep
a set of private names out of a public repo is the one file in that repo that
publishes them, permanently, in git history that is already pushed.

The decision here splits the list in two by what it is actually protecting, and
changes what CI is asked to do about the half it may no longer hold:

- **Generic domain terms** — the vocabulary of the original problem domain —
  stay in the script, in plaintext. They name a *subject*, not a party. Someone
  reading them learns what this codebase used to be about, which the commit
  history says anyway. Nothing about them identifies a person or a repo.
- **Identifiers** — an owner, a target's name, an organisation — move out, into
  the git-ignored file where the private targets themselves already live. They
  are the half the rule exists for, and the half that is currently self-defeating.
- **CI therefore stops re-running the identifier scan and starts demanding
  evidence that it ran** locally, on a machine that holds the list.

## Why CI cannot simply keep checking

Once the identifier list is git-ignored, a CI runner has no way to compute the
check. Every scheme for handing it one is worse than the problem:

**A committed hash of each banned term.** CI tokenises each file and compares
hashes. Rejected: the terms are short, low-entropy, and drawn from small
namespaces — repo names, a person's handle. An unsalted hash of those is a
dictionary attack with a wordlist you can generate in a second, so this
publishes the same names behind a step that only *looks* like protection. That
is worse than plaintext, which at least does not mislead.

**A keyed HMAC, key held privately.** CI cannot compute the digests without the
key, and if it has the key it has the capability the scheme was built to
withhold. This resolves to option 2 with extra machinery.

**A CI secret holding the list.** It works, and it is rejected for scope: it
makes the public repo's safety property depend on a GitHub account's secret
store, on fork-PR secret policy, and on log redaction never failing. The rule is
currently enforced by one shell script and one hook. Trading that for a cloud
trust dependency is a much larger move than the hole justifies.

## Why "the check ran" is the right thing for CI to assert

This is the shape [ADR-0004](0004-verification-tri-state-and-mandated-gates.md)
already chose everywhere else in this system: **a gate asserts that a named
check ran; it never supplies the capability to run one.** CI holds no private
list, so it cannot supply the scrub. What it can do is refuse a commit that
carries no evidence of having been scrubbed — an unmet gate, in the vocabulary
this repo already speaks.

Concretely: the pre-commit hook stamps the commit it just cleared, and CI fails
on any commit reaching the default branch without that stamp. The failure this
catches is the one actually observed — **a hook that was never installed**, which
is a one-time `git config core.hooksPath .githooks` that nothing verifies and no
clone inherits.

It does not catch a developer who deliberately forges the stamp or passes
`--no-verify`. That is accepted and is not the threat: this rule protects against
forgetting, not against the repo's own maintainer choosing to publish something.
The stamp is a **capability check on the machine**, not an attestation of intent.

## Why not just leave it

The status quo has a genuine argument: CI does re-run the full scan on `--all`,
so the denylist being public buys real enforcement that no local-only scheme can
match. The plaintext list is what makes the check total.

Rejected because the enforcement protects a property the list has already
destroyed. Every future private target added to that pattern is published by the
act of protecting it, and the cost compounds per target while the benefit stays
flat. A check that leaks its subject in order to detect leaks of its subject is
not a partial success.

## Consequences

- **The already-published identifiers stay published.** This record changes what
  happens next; it cannot un-push git history. Rewriting the history of a public
  repo to expunge them is a separate decision with a separate cost, deliberately
  not taken here — and the terms are, in fairness, this repo's owner's own name
  and the names of repos only they can see.
- **The self-exemption disappears for the half that matters.** With the
  identifiers external, `scripts/check-scrub.sh` no longer contains them, so it
  no longer needs the `SELF` exemption to avoid flagging itself — it stops being
  a hole in its own coverage.
- **A fresh clone can no longer run the full check, and should say so.** Running
  the scrub without the private overlay must report that the identifier half was
  skipped, not print a green tick. A silent partial pass here is the same error
  class as a false green.
- **The ledger's `skip-worktree` guard is untouched.** That mechanism protects a
  tracked file's private worktree copy and is orthogonal; it keeps working
  identically under either half of the list.

## Status

**Proposed** (2026-07-28). Nothing below the analysis is built.

Written after a private target's name was found committed in a tracked test
fixture — caught locally before any push, and amended away. Investigating *why
CI had not been the thing to catch it* found that CI **would** have, on the next
push, because the list is public. The hole is not the one that was being looked
for.
