# Per-run cost of a reconstituted verification tree

**Status:** measured 2026-08-02, **no spend** (no agent, judge, or model calls —
a timing harness only). Measures the one number
[ADR-0013](../adr/0013-verification-runs-on-the-shipped-artefact.md) declares
missing, on both live fleet targets. The harness was throwaway and has been
deleted; this file is the result it existed to produce.

Target-neutral by construction: this repo is public and the fleet targets are
not, so targets appear only as **A** and **B** and are characterised by the
dependency machinery they carry. No target name, path, or domain prose appears
here, and none was needed to reach the conclusion.

## The question this answers

ADR-0013's Status names the gap and says the gap selects the build:

> *"One number is deliberately missing and should be measured before the build:
> the per-run dependency install cost on a real target. If it is large enough to
> change what the fleet can do in a night, the defensible retreat is restoring
> only the installed dependencies in place — strictly weaker, and only as good as
> the paths it names."*

So the measurement is a **difference between two candidate builds**, not an
absolute:

| | The tree that gets verified |
|---|---|
| **Reconstituted** (ADR-0013 as accepted) | Clean checkout of the base, diff applied, dependencies installed from the lockfile. No `node_modules`, no `target/`, no `DerivedData` carried in from anywhere. |
| **Retreat** (ADR-0013's fallback) | The workspace keeps its installed dependency trees and its build caches; only named paths are restored. |

The number that decides is `cost(reconstituted) − cost(retreat)`, per run.

## Method

- **Host:** darwin 25.5.0, Apple M5, 10 CPU, 16 GB. One machine, unloaded,
  measurements serialised — nothing ran concurrently with anything measured.
- **Reconstitution** is `git archive HEAD | tar -x` into an empty directory:
  exactly tracked files at the base commit, no history, no ignored dependency or
  build trees. A no-op diff is the null case; applying a real diff is a `git
  apply` on a small patch and is not separately interesting.
- **Cost measured** is the full pass of *the checks the detector actually
  emits for that target*, run in the order the runner runs them and sharing one
  build-cache directory, because that is what a run pays. Individual phases were
  also timed separately to attribute the total.
- **"Cold" is two different things**, and both are reported, because the fleet
  runs on both:
  - **cold workspace, warm host cache** — the per-run cost on a persistent
    runner box, where `~/.npm` and `CARGO_HOME` survive between runs.
  - **cold workspace, cold host cache** — the cost on a cloud runner that is
    destroyed after the night, where they do not.
- **Repetitions:** 3, medians reported, ranges given. Whole-pass sequences were
  also repeated 3×. The first warm repetition of any pass is a cold start by
  definition and is excluded from the warm median, not averaged into it.
- No compiler cache, no `sccache`, no `RUSTC_WRAPPER`, and no shared target
  directory were in play; this was checked rather than assumed.

## The two targets, by shape

| | A | B |
|---|---|---|
| Shape | Xcode app project (`*.xcodeproj`, tracked) | Cargo workspace (5 members) + one nested JS workspace |
| Tracked files | 157 | 1 427 |
| **Package manager** | **none** | Cargo (167 crates compiled) + npm (145 lock entries) |
| Checks the detector emits | `xcodebuild-build`, `xcodebuild-test` | `npm-install:<nested-js>`, `tsc:<nested-js>`, `test:<nested-js>` |

Two things in that table are load-bearing and neither was anticipated:

1. **Target A has no package manager at all.** No `Package.swift`, no
   `Package.resolved`, no `Podfile`. The "dependency install" ADR-0013 costs out
   does not exist for it.
2. **Target B's Rust is not gated.** The detector emits no Cargo checks, so the
   only install a run pays for today is the nested JS workspace's.

## Result — the whole gated verify pass

Median of 3, seconds.

| Target | Reconstituted | Retreat | **Delta per run** |
|---|---:|---:|---:|
| A — `xcodebuild build` + `xcodebuild test` | 42.2 [42.0–43.7] | 28.6 [28.1–28.6] | **+13.6 s** |
| B — `npm ci` + `tsc --noEmit` + `npm run test` | 2.5 [2.5–3.2] | 1.2 [1.2–1.5] | **+1.3 s** |

## Result — the dependency install on its own

This is the quantity ADR-0013 actually names.

| | warm host cache | cold host cache | on disk |
|---|---:|---:|---:|
| A — dependency install | *(no package manager)* | *(no package manager)* | — |
| B — `npm ci` (nested JS) | 0.9 s [0.8–1.2] | 1.0 s [1.0–1.1] | 70 MB |
| B — `cargo fetch --locked` *(not gated today)* | 0.1 s [0.1–5.8] | 3.5 s [3.1–3.8] | 440 MB `CARGO_HOME` |

**The per-run dependency install cost is about one second on the only live
target that has a package manager, and does not exist on the other.** Cold host
cache barely moves it: the JS tree is 16 MB of tarballs, and a cold
`CARGO_HOME` costs 3.5 s.

## Where the cost actually is

The install is not the expense. The expense is the **build cache** a
reconstituted tree also loses, which ADR-0013's cost section does not mention.

| | cold | warm | delta | cache size |
|---|---:|---:|---:|---:|
| A — `xcodebuild build` | 12.0 s | 1.0 s | +11.0 s | 317 MB |
| A — `xcodebuild test` | 41.2 s | 27.7 s | +13.5 s | 377 MB |
| B — `cargo build --locked` *(not gated today)* | 16.9 s | 0.2 s | +16.7 s | 952 MB |

Sequenced in one shared cache directory, as a run really does it, A's two checks
together cost +13.6 s rather than the +24.5 s that timing them in isolation
suggests — `test` inherits what `build` warmed.

Target A's floor is high for a reason unrelated to caching: `xcodebuild test`
takes 27.7 s even fully warm, because that is the test suite running. Only 13.5 s
of its 41.2 s cold figure is recoverable by any caching strategy at all.

## The answer to ADR-0013's question

**The number is not large enough to justify the retreat. Build the full
reconstituted tree.**

The threshold ADR-0013 sets is "large enough to change what the fleet can do in a
night". At +13.6 s and +1.3 s per run, a night of 100 runs on the more expensive
target buys back **23 minutes** by retreating. That is the entire prize, and it
is paid for with the flaw ADR-0013 rejects the retreat for in the first place —
a restore set that is only as good as the paths it names.

Even the upper bound does not reach the threshold. If a Cargo verifier is ever
registered for target B under
[ADR-0009](../adr/0009-registered-verifiers-live-in-the-control-repo.md), the
delta there becomes **+18.5 s** (`cargo fetch` 0.1 + the JS build 1.8 +
`cargo build` 16.7). Still seconds, on a unit of work whose other phases are the
agent and the judge.

This measurement cannot express that delta as a percentage of a run, and does not
try to: `fleet/ledger.jsonl` holds 9 runs with an `elapsedMs`, median 42 s and
`agentMs` median 32 s, and they are dominated by demo targets rather than by
either target measured here. The absolute seconds are the finding; the ratio is
not available and is not invented.

## Three findings that were not the question

**1. Reconstitution needs a build *order*, not just an install.** Target B does
not build from a clean checkout after `cargo fetch`. A member crate's `build.rs`
panics because it consumes the nested JS workspace's build output, which exists
only after that workspace is installed *and built*. The correct sequence is
install → JS build → Cargo build, and nothing in the repo currently knows that.

This is worth stating plainly because it qualifies ADR-0013's central claim.
Reconstitution is correct by construction with respect to *which paths* are
restored — the flaw it charges the retreat with — but it is not free of
target-specific knowledge. It relocates that knowledge from a list of paths to a
build order. That is a smaller and better-shaped dependency, and the ADR's
argument survives it, but the ADR as written does not acknowledge it exists.

**2. For one live target the ADR's stated cost is the wrong cost.** ADR-0013's
"what this costs" section is written around "one dependency install per run".
Target A has no dependency install to pay for, and 100% of its +13.6 s is lost
compile cache. A build costed on installs would have predicted zero for it.

**3. Disk, not time, is the scaling constraint.** A reconstituted tree is
~380 MB for target A and ~1 GB for target B, and it is per concurrent run rather
than per target. Fan-out width multiplies this where the current shared workspace
does not. Nothing here measures a limit being hit; it is recorded because it is
the axis on which reconstitution is genuinely more expensive, and it is not the
axis ADR-0013 examines.

## What this does not measure, and what would change the answer

- **One host, one architecture.** An M5 with 10 cores and a fast link. A slower
  CI runner scales every number up, but it scales the reconstituted and retreat
  columns together, so the *ratio* is more portable than the seconds.
- **Two targets.** A target with a large native dependency graph — a SwiftPM
  package with many remote dependencies, a Gradle or Bazel build, a Cargo
  workspace an order of magnitude larger — could plausibly reach minutes per run,
  and this result should not be read as covering one. The conclusion is stated
  for the fleet as it exists on 2026-08-02.
- **Network variance.** Cold-cache figures were taken on one connection at one
  time of day. `cargo fetch` cold at 3.5 s is the number most exposed to this.
- **Target A cannot be verified on a Linux cloud runner at all.** `xcodebuild`
  is absent there, so its checks are not merely slower off-darwin, they are
  undetected, and verification reports inconclusive. That is a pre-existing
  property, not something reconstitution changes, but it bounds where any of
  these numbers apply.

The finding that would overturn this is a target whose install genuinely costs
minutes. The instrument for that is this experiment re-run, and the decision it
would change is stated in advance: it would reopen the retreat, and only for
targets over that threshold.
