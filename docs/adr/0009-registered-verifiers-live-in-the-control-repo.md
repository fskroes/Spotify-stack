# A bespoke check is registered per target in the control repo, never in the target

The fleet can only verify what `detect()` infers from repo shape. A target that
needs a check no detector knows — a live contract probe, a bespoke build script,
a house linter — gets a permanently [unmet gate](../../CONTEXT.md#unmet-gate):
loud and honest, but the check never runs.

**A [registered verifier](../../CONTEXT.md#registered-verifier) closes that gap.**
It is a named check declared per target in the fleet registry (`fleet/repos.yaml`,
or the git-ignored `repos.local.yaml` overlay where private targets live). The
runner runs it alongside the detected checks, and a task's `gates:` key resolves
against it exactly as it resolves against a detected one — so today's permanently
unmet mandate becomes a met one **without changing the task format at all**.

`gates:` keeps meaning what [ADR-0004](0004-verification-tri-state-and-mandated-gates.md)
decided it means: an assertion that a check must have *run*, never an instruction
to run one. The registry supplies the capability; the gate still only demands
evidence.

## Status

**Accepted** (2026-07-28). **Implemented** (2026-07-28, #64).

This record was written *"Accepted, not implemented"*, deliberately unbuilt until
the trigger fired: *"why can't this gate run?"* becoming a question someone wants
to fix rather than record.

It fired the same day, on contact with the first real targets onboarded. One
carries a shell script that validates the app's AI contract against a live model
through a CLI — a check no detector could infer, requiring a credential from the
environment, and billed to a subscription per run. That single script
instantiates all three of the features this record had only hypothesised: the
live probe, `requiresEnv`, and `cost: billed`. Another is a workspace in a
language the fleet has no detector for at all, where the gap is a *detector* gap
rather than a bespoke-check one, and whose registration is therefore still an
open question (see Consequences).

The decision itself is unchanged; only this status is. The design below was
written before the build and has not been revised to agree with it.

## Why the registry lives in the control repo and not in the target

The obvious design is a `.fleet/verifiers.yaml` **inside the target**: the repo
that owns the check declares it, which is where the knowledge actually lives.

Rejected, and this is the decisive constraint in the whole design: **the agent
edits files in that workspace.** A verifier declared in-repo is a verifier the
agent can write. An agent that cannot pass `contract-probe` can add
`contract-probe: true` to the file that defines it and pass its own gate. That is
a false green — the one output this system may not produce — reachable by the
agent unaided, through the ordinary file-edit capability it is *supposed* to have.

Putting the registry in the control repo puts it outside the workspace and
outside the agent's write scope, which is the same boundary
[ADR-0003](0003-the-runner-owns-git.md) already draws: the agent proposes file
edits, the runner owns everything that decides consequences. A verifier is a
consequence-deciding thing. It belongs on the runner's side of the cage.

The cost is real and accepted: **the registry will drift from the target.** A
repo that renames its probe script breaks a check declared somewhere it cannot
see. That failure is loud (the check fails, or its command is missing) and it is
recoverable by editing one line in the control repo. Drift is a maintenance
cost; an agent-authored gate is a soundness hole. Those are not comparable.

A middle option — read the verifier from the target but **pin its content hash**
in the control registry — was considered and rejected as the worst of both: it
still requires a control-repo edit on every legitimate change to the check, and
it buys back only the illusion of target-side ownership.

## Why a separate mechanism and not a richer `gates:`

`gates: [swift-build, "./scripts/validate-x.sh"]` — named keys with an inline
shell escape hatch — was rejected in #61 and stays rejected. It is a list in
which one element means *"this must have run"* and another means *"run this"*:
two different things wearing one syntax. The assertion/execution split **was**
the decision; a hybrid un-makes it.

Registration keeps the split intact by putting the two things in two places. The
registry is where a check is *supplied* (per target, by a human, in the control
repo). `gates:` is where a check is *demanded* (per task, target-agnostic). A
task author writes the same `gates: [contract-probe]` whether the check is
detected or registered, and does not need to know which — which is the property
that makes this cheap.

## Why a registered verifier is the same shape as a detected one

A registered entry carries exactly a `Check`: `name`, `label`, `command`,
`args`, and an optional `cwd`. It therefore flows through `runCheck`, the
summarizer table, gate matching, the tri-state, `unmetGates`, and every wire
surface **unchanged**. This is not a new concept in the verification model; it is
an additional *source* of the concept that already exists.

The alternative — a parallel "custom check" pipeline with its own result type and
its own rendering — was rejected because every surface that renders verification
would grow a second branch, and the two branches would diverge. `RUN_FACTS` and
[ADR-0008](0008-one-status-facts-table.md) make the same argument about status:
one table, not a switch per surface.

**A registered verifier may not shadow a detected one.** A name collision is a
load-time error, not a silent override. Allowing the override would make
`test: {command: "true"}` a one-line false green in a file that already has
permission to exist — precisely the hole the control-repo location was chosen to
close, re-opened from the other side.

## Why a missing prerequisite makes a verifier ineligible, not failing

A registered verifier may declare `requiresEnv: [CLAUDE_BIN]`. If any named
variable is absent from the runner's environment, **the verifier is not
registered for that run at all** — it is never detected, so a task mandating it
records an unmet gate and an `inconclusive` verification.

The alternative is letting it run and fail. Rejected: a missing local credential
is not evidence that the diff is bad, and reddening a good change because the
operator's shell lacked an export teaches operators to stop declaring verifiers —
the same incentive failure that
[ADR-0004](0004-verification-tri-state-and-mandated-gates.md) rejected blocking
for. Ineligibility routes the case into the machinery already built for exactly
this meaning: *this could not be proven*, said loudly, without claiming the run
was bad.

Checks already inherit the runner's full `process.env`, so this needs no
environment plumbing — only a presence test. Deliberately **no secret store** is
introduced. Holding a target's credentials in a public control repo is a larger
trust move than executing a command on its behalf, and nothing yet needs it.

## Why a billed verifier runs only when mandated

A registered verifier may declare `cost: billed`. A billed verifier does **not**
run on every dispatch; it runs only for a task whose `gates:` names it. Free
verifiers run always, like detected ones.

This is a scheduling policy keyed on the assertion, not a second meaning for it.
`gates:` still says only "this must have run" — the runner simply declines to
spend money on a check no task asked to be proven by. Fan-out is the reason:
`fleet dispatch` multiplies a per-run cost by the number of targets, and a
subscription-billed probe firing on every dispatch of every task is a bill nobody
authored.

Rejected: **a global budget cap**. It makes the fleet's behaviour depend on
run order — the eleventh target silently skips a check the first ten ran — and a
verification result that depends on when you happened to run is not evidence.
Also rejected: **opting in per dispatch with a flag**. It puts the decision on
the person invoking rather than the person who understands the check, and it
would be forgotten in the workflow wrappers that call the same CLI.

## Consequences

- **`detect()` stays task-blind *and* target-blind.** It keeps answering only
  "what does this repo's shape offer". Composition of detected + registered
  checks happens in the runner, which is already where mandated gates are folded
  in — the same seam, for the same reason: only the runner holds both halves.
  Do not teach `mcp-verify` about the registry.
- **The gate vocabulary stays open.** [ADR-0004](0004-verification-tri-state-and-mandated-gates.md)'s
  no-registry argument is untouched: a registered name is legal to mandate, and
  so is an unregistered one, and a typo remains indistinguishable from a
  deliberately unrunnable mandate. Registration adds names that *can* be met; it
  does not make the set closed or validated.
- **Private targets' verifiers are private.** They live in `repos.local.yaml`
  with the target itself, and a bespoke command frequently names a private
  path — so `scripts/check-scrub.sh` covers this by construction, with no new
  rule to remember.
- **Cloud and local diverge in eligibility, not in behaviour.** A verifier
  requiring an env var the Actions runner lacks is ineligible there and eligible
  locally, so the same task can record a met gate on one and an unmet gate on the
  other. That is accurate reporting of two genuinely different environments, and
  it is why eligibility is computed per run rather than cached.
- **`local_path` already set this trust precedent.** The registry can already
  point the runner at an arbitrary directory on the operator's machine. Letting
  it also name a command to run there widens what a registry entry can do, but
  does not cross a boundary the file had not already crossed.
