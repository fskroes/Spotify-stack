# The desktop operator is deleted, and the CLI is the only surface

**Date of decision: 2026-08-07.** Supersedes
[ADR-0005](0005-operator-drives-the-cli-over-ssh.md) **in part** — its transport
decision only. ADR-0005's co-sign gate, and the deliberate absence of
`fleet cosign --force`, are untouched and remain recorded there. Narrows the
premise of [ADR-0001](0001-tolerant-reader-wire-contract.md) without superseding
it.

## The decision

**There is no second surface.** The fleet is driven by `fleet` in a terminal.
`fleet report --serve` still renders the browser dashboard for reading; nothing
holds a JSON API, because nothing consumes one.

## What it cost, measured before deleting

| | |
|---|---|
| Use, by the operator's own account | **"a couple of times"** — never in a shipping run |
| Dedicated code | `apps/operator-desktop`, **4,407 lines** (`main.ts` alone is 2,289) |
| Runner code that existed only to feed it | `operator-api.ts` (374), `cloud-sync.ts`, the remote-ledger poller and cloud-sync wiring in `ledger-serve.ts` |
| Contract code that existed only to feed it | `endpoints.ts` (85) and 98 lines of response schemas |
| Tests deleted with it | `operator-verify-guards.test.ts`, `cloud-sync.test.ts`, and 14 of 19 `ledger-serve` tests |
| CI | one macOS job's Rust toolchain, Tauri build, and `cargo test` |

ADR-0005 defended the app on safety: it holds no keys, no GitHub token, no
fleet logic, no arbitrary shell. Every one of those clauses is true, and none of
them is a reason to have it. A part defended entirely by what it cannot do is a
part with no argument for existing.

## The alternative that lost

**Keep it — the human is now the last gate, and the app is what makes reading
cheap.** This is the strongest case, and it is why the decision is not obvious:
[ADR-0025](0025-the-judge-is-deleted-and-verify-is-the-last-gate.md) made "a
person reads the diff" the final control, and deleting a reading surface right
after deleting the model reviewer puts two removals in front of one gate.

Rejected on the evidence: the diffs are read in GitHub, on the pull request the
runner opens. The app was never in that path. Deleting it removes a surface that
was not being used to read, and leaves the one that is.

**Keep the JSON API, delete only the app.** Rejected for the reason ADR-0025
rejected keeping the judge packages: it removes the caller and none of the
weight. An API with no client is a shape that must still be understood, kept
parsing, and kept honest.

**Port it to Rust/GPUI** ([research, 2026-07](../rust-gpui-port-research.md)).
Rejected: that document asks how to rebuild the part. It was written before the
question "should this part exist" was put, and the answer to that question makes
it moot. The research is not retracted — it stands as what was true when it was
written.

## What this gives up, plainly

1. **Cloud runs no longer appear in any live view.** The union read against
   `origin/main` fed the API only; `fleet report --html` still unions, so the
   static report is the path to a cloud run's ledger line.
2. **On-demand Actions artifact download is gone.** `gh run download` was
   triggered by opening a cloud run in the app. The CLI stays the path, as
   ADR-0005 already said it was when the server ran offline.
3. **There is no GUI trigger for dispatch or co-sign.** Both were always
   available as `fleet dispatch` and `fleet cosign`, which is what the app
   shelled out to.

None of the three is a verification capability, and none can produce a false
green ([ADR-0004](0004-verification-tri-state-and-mandated-gates.md)).

## What stays, and why

`@fleet/contract` stays. Its stated premise was version skew between two
machines at different commits, and that premise is now dead — but the tolerant
reader is not. The ledger is append-only and 50 rows deep, so today's reader
must still parse rows written by every past runner, including fields nothing
produces any more. That is ADR-0001 applied to time, the same ground ADR-0025
kept the judge's wire types on. ADR-0001 is not superseded; its reason narrowed
from two machines to two dates.

`fleet report --serve` stays. It renders HTML for a browser and never needed the
API — the served page reads the local ledger directly.

## Status

Reversible, and the reversal is named: **if reading a diff in GitHub turns out
to be the reason a defect reaches main, the reading surface comes back** — as a
view, not as a second implementation of the fleet. Until then the CLI is the
only surface. ADR-0024's remaining triggers stand unchanged.
Owner: **Fernando Silva Kroes**.
