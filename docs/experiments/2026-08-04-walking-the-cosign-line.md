# Walking the co-sign line

**2026-08-04.** One shipped run taken from the evidence store through to a
co-sign decision, recording two things: what the walk costs the reader, and any
surface that claims more than the run proved.

Point-in-time, like everything in this directory. It is not maintained against
the code, and its value is the measurements and the reasoning, not its current
accuracy.

## What was walked, and what was not

A local run that shipped, was approved, opened a pull request, and recorded
`verifyState: "passed"` with two mandated gates, both met. Its diff is six files,
+137 −85, thirteen hunks. The agent rail took 10.8 minutes, verification 33
seconds, the judge 39 seconds.

**No co-sign was executed.** At the time of the walk no target carried an open
pull request — every shipped run's PR was already merged or closed — so the
decision was taken as a dry co-sign: read everything a signer reads, reach a
verdict, stop before the irreversible write. Everything below about the *reading*
holds; nothing below is evidence about the merge path itself.

The operator app was running throughout, connected to a remote runner over the
[ADR-0005](../adr/0005-operator-drives-the-cli-over-ssh.md) SSH channel. Where a
claim is about what the operator renders, it was obtained by evaluating the
operator's own pure functions against real ledger lines, not by reading the code
and inferring.

## Where the minutes went

Under-measured, and stated that way deliberately: this is one reader on one run,
and the human timings the walk was meant to collect were not gathered. What is
solid is the *shape* of the work and where the record fails to answer a question
the reader has.

**Locating the review material cost more than reading it.** The evidence store
for the run holds exactly one file, `model-usage.json` — what the run cost, not
what it did. The per-run archive that
[ADR-0007](../adr/0007-per-run-artifact-archive.md) describes as exact
attribution was already gone, 29 minutes after the run finished (see finding 3).
The surviving copy was the flat latest-run-wins set, which persists only because
no later run of that task has happened; `operator-api.ts` would correctly refuse
to attach it to the run had one.

**The diff does not advertise where its weight sits.** One module shows sixteen
added and fifteen removed lines and is entirely comment rewording; the
behavioural change is in two components and a stylesheet. The stylesheet is 64 of
the 222 changed lines — 29% of the diff — and no detected check governs its
content beyond the bundler parsing it during the build. Nothing in the record
maps changed files to the checks that govern them, so the reader does that by
hand, per file, every time.

**The judge's rationale was the only surface that answered the question that
mattered.** The task declared two mandated gates and its diff edits a test file
that one of them reads — a [gate input](../../CONTEXT.md#gate-input) — so that
check's green was produced in part by a file the agent wrote in the same change.
The judge had read that file and said so: *a new test added beside existing ones,
none weakened*. That claim was checkable against the hunk and held. No other
surface raises the question at all; a search of the runner, the contract and the
operator finds no code anywhere that flags a diff touching a gate input.

That is a known hole and not a new one — the standing map carries it, and
[ADR-0014](../adr/0014-gate-inputs-are-carried-only-under-an-amendment.md)'s
`amends:` is deliberately unbuilt. Recorded here only because the walk shows what
its absence costs at read time: the check is real, and it currently lives in one
paragraph of model output rather than in the record.

## Finding 1 — the runner's credential is not reachable over the channel

The strongest result of the walk, and it explains a co-sign line that had been
dead for a week.

`fleet report --serve --cosign` polls GitHub every 60 seconds for the live state
of every shipped run's pull request. Every poll failed. Measured over the same
non-interactive channel the operator uses:

```
gh auth status  →  The token in default is invalid.
gh api user     →  {"message": "Requires authentication"}
GH_TOKEN        →  unset
```

Three separate interactive `gh auth login` runs at the runner's own keyboard did
not change it. The reason is that they had worked:

```
~/.config/gh/hosts.yml   modified at the moment of login, 85 bytes
                         no inline credential — secure (keychain) storage
```

The login wrote the account record and put the token in the host's login
keychain. ADR-0005 connects with `ssh -o BatchMode=yes`, no stdin, a non-login
shell — a session with no GUI security context, which cannot read that keychain
item. `gh` finds the account, retrieves nothing, sends an empty credential, and
GitHub answers 401. The symptom is a message that sends the operator back to
`gh auth login`, which is the one action that cannot help.

Re-running the login with the credential written to the config file instead
fixed it, verified end to end over the same channel: `gh api user` returns the
login, a live PR read returns its state, and the poll populated 16 of 18 pull
requests on the first tick.

**The decision this names.** ADR-0005 enumerates the cost it accepted for a
non-interactive channel — the runner's non-login shell must find `node`, `pnpm`
and `gh` from `~/.zshenv`. It does not name credential *storage*, and that is the
half that fails. Its mitigation is a one-time setup check, chosen expressly so
the problem is not discovered during a first merge. A one-time check cannot hold
a property that changes underneath it, whether by token expiry or by a credential
helper migrating to keychain storage. Whether the channel's contract includes
where the runner's credential lives is a decision this record does not take.

## Finding 2 — an empty co-sign map cannot say why it is empty

When the poll cannot reach GitHub, `fetchCosigns` catches per URL, logs to the
runner's stderr, and returns whatever it collected. The API then serves
`"cosigns": {}`. Every shipped run's merge gate reads that absence as:

> Waiting for live pull-request state from the runner.

which is true of a poll that has not ticked yet and false of one that has failed
eighteen times in a row. Both render identically and neither renders a cause. The
API already reasons about exactly this distinction one level up — it omits the
field entirely when polling is off, *"rather than serving an empty map that reads
as 'nothing is merged'"* — and the same argument was not applied to a poll that is
on and failing.

This is not only an outage artefact. With the runner fully healthy, two ledger
rows still never resolve:

```
shipped PRs: 18   resolved: 16   unresolved: 2
```

Both unresolved rows carry a pull-request URL with an unexpanded registry
placeholder, so `gh` fails on them permanently and they are skipped on every
tick, forever. Two rows on a correct screen claim a transient wait for a state
that can never arrive.

**The decision this names.** Whether the wire owes the operator the poll's
*health* as well as its *result*. The tolerant-reader stance is to fail loudly
naming the field ([ADR-0001](../adr/0001-tolerant-reader-wire-contract.md)); an
empty map fails silently, and silence is the failure mode that contract exists to
design out.

## Finding 3 — the test suite evicts every real run's per-run archive

Measured on the workstation holding the run history:

```
per-run archives: 20      ledger runIds: 15
archives that ARE in the ledger:  0
archives NOT in the ledger:      20
```

All twenty share one mtime and none belongs to a real run. They are end-to-end
fixtures. The suite constructs its control repo as the actual repository root and
redirects `ledgerPath` into a temp directory, but passes no artifacts root — so a
test run writes per-run archives into the live `artifacts/runs/`, and
`pruneRunArtifacts(keep = 20)` then evicts every genuine run in mtime order. The
suite is careful about the ledger and not about the archive.

[ADR-0015](../adr/0015-a-kill-is-retained-forever-and-blinded.md) measured the
shadow of this on 2026-08-01 — *"the twenty survivors all from one later burst"* —
and read the burst as run churn. The burst is the test suite. That correction
does not disturb the ADR's decision: kills are retained in the evidence store,
which is not pruned, so retention was and remains sound. What it changes is the
account of the mechanism, and therefore what a fix would have to touch.

**The decision this names.** Whether a test run may write to the control repo's
artifacts root at all. ADR-0007 deliberately made the archive best-effort and
pruning failure non-fatal; nothing in that decision anticipated the prune being
driven by fixtures rather than by runs.

## Finding 4 — the tunnel's receipt reports success over its own failures

The managed SSH process writes stdout and stderr to one log file, and the app
renders that log's tail in the Activity rail as a command receipt whose exit
status is derived from whether the tunnel is *alive*, not from what it said. With
the poll failing, the receipt showed a success state and `exit 0` over a body
that was nothing but authentication errors, inside a collapsed disclosure that
only co-sign receipts open by default.

The crowding is worth a number. The receipt shows the last 8 000 characters. After
roughly an hour of a failing poll the log had reached 6 168 lines, 2 052 of them
`HTTP 401`, and **zero** of the startup lines — the ledger URL, the polling
notice — remained inside the window. A receipt that began as the connection's
useful summary had been entirely displaced by the record of its failure, while
still presenting as a success.

This is the same family as the surfaces the standing map has already corrected,
and the same detection route: visible by running the app and opening something,
not by reading the code.

## Finding 5 — an unknown run status renders as shipped

Unexercised, and recorded because the skew that would exercise it is the declared
normal state rather than an edge case.

The status → facts table is the single source of truth for what a status means,
and its lookup returns undefined for a status it does not know:

```
runFacts("approved")       → { kind: "shipped", diedAt: null }
runFacts("verify-failed")  → { kind: "killed",  diedAt: "verify" }
runFacts("quarantined")    → undefined
```

The operator's spotlight and readout strip both branch on that result: killed and
infra states are handled, `no-changes` is handled, and everything else falls
through to the shipped rendering — a check icon, `Judge: Approved`, and, for a
line whose verification passed, *Every gate passed.* So a status a newer runner
speaks and this build has never heard of is presented as a shipped,
judge-approved run.

ADR-0001 states that a run's status stays an open string precisely because a
newer runner may speak statuses an older operator does not know, and ADR-0005
records that the app and the runner checkout are routinely at different commits.
The tolerant-reader stance for that case is to degrade gracefully or fail loudly
by name. Degrading toward *approved and green* is neither.

**No runner has ever emitted an eighth status**, so nothing has rendered this
way. It is recorded as a code path, not as an observation.

## Surfaces checked and found honest

Negative results, kept because the walk was looking for overstatement and these
are the places it did not find any. All were evaluated against real ledger lines
rather than read:

| Surface | Result |
|---|---|
| Verify pill | `passed`→"Green"; field absent→"Not recorded"; inconclusive→"Nothing ran", or the unmet gate by name |
| Outcome card | "Every gate passed." only on a recorded pass; otherwise "Approved, but …" with the cause |
| Merge-confirm dialog | States the recorded verification, not a fixed claim |
| Co-sign card and both merge buttons | Carry an "unproven" warning and a distinct icon when verification did not prove the change |
| Pull-request body banner | Three-way on the verification state, and names the unmet gates when there are any |

The verification tri-state's honesty work holds where it was applied. Every
overstatement this walk found is outside it: in the connection's receipt, in the
absence of a poll's health, and in the fallthrough for a status the build does
not know.

## What this did not establish

- **Nothing about the merge path.** No co-sign was executed, because no open pull
  request existed to execute one on. The gate's refusals were not exercised.
- **Nothing about a kill.** The evidence store held no retained kill: the only
  killed run in range predates retention being built, and an `agent-failed` kill
  retains nothing by design. Blind re-adjudication was not walked.
- **The human timings.** The walk was designed to record where an operator's
  minutes actually go across several runs. It recorded one reader's path through
  one run. The stage shapes are reliable; the durations are not a measurement.
