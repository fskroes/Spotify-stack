# The agent proposes; the runner owns git and the network

The agent process can edit files in its workspace, read and search, run `rg`,
and call the `verify` MCP tool. That is the whole toolkit
([`agent-config/settings.json`](../../agent-config/settings.json) allows it and
denies `git`, `gh`, `curl`, `wget`, `WebFetch`, `WebSearch`). Every side effect
beyond the worktree — branching, committing, pushing, opening the pull request,
appending to the ledger, writing artifacts — lives in
[`packages/runner`](../../packages/runner).

The consequence that motivates it: **a killed run leaves nothing to unwind.**
Scope violation, red verifier, judge veto, crashed engine — in every case the
worst residue is a temporary directory. There is no branch to delete, no PR to
close, no half-pushed commit on a target repo.

## Considered options

**Let the agent open its own PR** (give it `gh`, let it commit). This is the
obvious shape and the one most agent harnesses take. It was rejected because it
makes every failure path a cleanup problem: the moment the agent can push, a run
that dies after pushing has left state on a repo nobody has reviewed. It also
destroys the guarantee that a human only ever sees a *pre-verified* diff —
whatever the agent chooses to open, someone must now audit.

**Let the agent commit but not push.** Rejected as the worst of both: the runner
still needs its own git path for the real work, so there are now two writers of
history, and the agent's commits become one more thing to reconcile.

**Allow network reads for research** (`WebFetch`, `curl`). Rejected because it
widens the blast radius of prompt injection from the target repo's own contents
to anything reachable, in exchange for a capability the task prompt is supposed
to supply. Tasks that need external facts should carry them.

**Trust the agent to self-report success** rather than gating on deterministic
verification. Rejected — that is the failure mode this whole system exists to
remove. See [ADR-0004](0004-verification-tri-state-and-mandated-gates.md).

## Consequences

- The runner is necessarily the fattest package, and that is correct: side
  effects concentrate rather than scatter. Resist moving them outward for
  tidiness.
- The Stop hook ([`agent-config/hooks/stop-verify.mjs`](../../agent-config/hooks/stop-verify.mjs))
  is how the agent is kept honest *inside* its session — exit 2 plus a summary
  blocks it from finishing red, bounded at 3 blocks so a genuinely stuck agent
  fails rather than loops.
- `rm`/`rmdir` are allowed, so the agent can delete files it was asked to
  delete. The workspace is disposable, so this is bounded; it is nonetheless the
  loosest entry in the allowlist and worth remembering when auditing it.
- A new capability request ("the agent needs to run X") is a **cage change**,
  not a feature. It belongs in `agent-config/settings.json` with a reason, and
  it widens what a compromised or confused run can do.
