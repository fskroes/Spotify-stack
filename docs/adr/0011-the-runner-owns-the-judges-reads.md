# The runner owns the judge's reads

A judge may ground its verdict in the target's source rather than only in its own
prompt — but every read goes through a tool the runner implements and roots at
the run's workspace. The judge holds no built-in file access of its own, and the
capability is identical whichever transport carries the call.

What forced the decision was finding that it wasn't one. The judge has two
transports — the SDK (`messages.parse`, used in CI) and the local `claude` CLI
(used locally, so a run bills a subscription instead of an API key) — and
`GITHUB_ACTIONS` selects between them. The SDK path has no `tools` parameter and
is text-only by construction. The CLI path had every built-in tool and inherited
the runner's working directory, which is the control repo. Two reviewers with
materially different powers, chosen by an environment variable, recorded under
one name.

Measurement settled which of the two is correct. A judge that could read
rejected a diff whose only defect was an added entry in a list the target's own
build script does not contain — a claim nothing in its prompt could falsify, and
one a text-only judge approves. That is a false green, the one output this system
may not produce ([ADR-0004](0004-verification-tri-state-and-mandated-gates.md)).
The runs are recorded in the git-ignored judge dataset under `tasks/private/`;
they are not repeated here, because the specifics name a private target.

## Considered options

**Text-only on both transports** (`--tools ""` on the CLI path — one flag, and
it makes the two paths identical today). Rejected because it gives up the only
catch class that matters here: a diff the source contradicts and the task does
not. The argument for it is a symmetry with
[ADR-0003](0003-the-runner-owns-git.md) — "tasks that need external facts should
carry them" — and the symmetry is false. For the agent, the task is its
instruction, so requiring the task to carry its facts is reasonable. For the
judge, the task is *evidence under examination*. A reviewer that can only check
what the task already asserted is checking the wrong document.

**Leave the judge unconstrained**, as the CLI path already was. Rejected:
its reachable set was the control repo, which holds `fleet/repos.local.yaml`,
`tasks/private/`, and `fleet/evidence/`; a verdict's `rationale` is free-form
prose that is archived and shown at co-sign. ADR-0003 refused the agent network
reads to bound prompt-injection blast radius from a target's own contents — the
judge reads that same untrusted content, with a wider reach and no such record.

**Confine by configuration**: set `cwd` to the workspace and restrict the
built-in toolset. Rejected because it restates the constraint instead of
enforcing it. Tool flags bound *which* tools exist, not *where they reach*: a
read tool takes absolute paths, and a working directory is a default rather than
a fence. The judge would stay inside the workspace because it chose to — and the
content best placed to argue it out of that choice is the content it is about to
read.

**Collapse to one transport**, with CI switching to the CLI and the SDK path
deleted. Rejected: the SDK path enforces the verdict's shape through structured
output, while the CLI path has no such flag and recovers JSON from prose.
Collapsing onto the CLI would downgrade verdict parsing in the one place no human
is watching it. The fork's cost was the capability difference, not the existence
of two transports; transport remains a billing concern.

**Restrict reads to paths named in the task or diff**, which would keep the
archive a complete account of what was readable. Rejected: it buys reproducibility
back by reimposing text-only blindness one layer down — the judge could then only
check claims someone already suspected — and matching prose to filenames is a
parser with no owner.

**Record the contents read, not just the paths.** Rejected on the ground
[ADR-0007](0007-per-run-artifact-archive.md) already used to exclude transcripts:
large, and not part of the review contract.

## Consequences

- **A verdict is no longer derivable from the archive alone.** The paths read are
  recorded on the verdict, so a reviewer can distinguish a grounded veto from a
  confident invention; the bytes are not. For a `--local` run the workspace is a
  copy of a working tree, so no commit reconstructs what was read. That
  irreproducibility predates this decision — the pre-image was already gone — and
  recording paths makes it legible rather than removing it.
- **A judge that cannot read fails the run** (`engine-failed`), the same fate as a
  judge that throws. It does not degrade to text-only, because that degradation is
  undetectable afterwards: a broken read tool and a diff that genuinely needed no
  reads both record zero reads, so the only moment the condition is observable is
  when it happens. This is deliberately *not* the [unmet gate](../../CONTEXT.md#unmet-gate)
  treatment, which ships the run and shouts. A gate is an author's assertion about
  a target, and blocking on one would make declaring gates dangerous; the judge's
  read capability is a system invariant nobody declares.
- **Evidence records the judge's capability, not only its model.** A model name
  cannot distinguish two reviewers running the same model with different powers,
  which is precisely the condition this ADR exists to end.
- **Two invariants have to be asserted in tests rather than assumed**: that both
  transports expose the same tool surface, and that the root check rejects every
  path outside the workspace. The capability fork survived as long as it did
  because neither was written down anywhere.
- `--strict-mcp-config` on the judge stops being decoration. It currently
  restricts MCP servers for a process that configures none; it becomes the flag
  holding the cage shut.
- The judge gains a runtime dependency on a server launching, which the agent
  already has for verification. Runs that would previously have limped through
  with a quietly weaker review will now die instead.

## Status

**Decided 2026-07-29.** **Built in stages**, and as of 2026-07-29: the rooted
reader and the shared tool surface (#103), its MCP transport and the CLI judge's
cage (#105), and the SDK judge's tool loop (#106) — which rests on two live
measurements, that a single request may carry both the verdict's schema and the
tools (#104, recorded in [the cage spec](../judge-cage-spec.md) §2), and that
the loop itself survives the real API end to end (#106, §5.2). Both transports
have now read a workspace and vetoed on what they found there.

**The fork is closed by construction, and not yet by evidence.** Both
transports now reach the workspace only through the rooted tool and hold
nothing else, so which one carries a verdict is a billing question — but
nothing yet proves that on a given run. No test holds the two surfaces against
each other (#107); a judge whose read server never launched still reviews
rather than failing the run (#108), which is this ADR's own failure arriving
by accident rather than by design; and no verdict records what was read or
which capability produced it (#109), so a verdict's *name* still cannot
distinguish the two reviewers.
