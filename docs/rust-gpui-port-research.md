# Porting the Fleet to Rust + GPUI: Feasibility Research

Status: research reference

Last updated: 2026-07-31

Point-in-time. This document is **not** maintained against the code, and it is
not an ADR — nothing has been decided. It is the evidence a decision would rest
on, and its value is the reasoning and the measurements, not its current
accuracy. GPUI in particular is pre-1.0 and moving; every claim about it carries
the date it was fetched.

## Purpose

Answer two questions with primary sources rather than intuition:

1. **Can this application be completely ported to Rust + GPUI?**
2. **What would that bring?**

The scope is the whole control repo — the [runner](../CONTEXT.md#run), the CLI,
the [wire contract](../CONTEXT.md#wire-contract), verification, the
[judge](../CONTEXT.md#judge) and its [cage](../CONTEXT.md#cage), the knowledge
layer, and the [operator](adr/0005-operator-drives-the-cli-over-ssh.md) — not
just the desktop shell. GPUI would replace only the operator's frontend; that is
a much smaller question than "port the fleet to Rust", and the two are worth
keeping apart, because the honest answers differ.

Every claim sourced outside this repository carries an inline URL and appears
again in [Sources](#sources) with the date it was fetched. LOC figures are the
author's own measurements against the working tree on 2026-07-31.

## Executive Summary

**Verdict: do not port the fleet. Do not port the operator to GPUI either — but
for a different reason, and the second answer is the one that could change.**

Three findings carry the decision:

1. **Node is load-bearing in one place and incidental everywhere else, and the
   one place is the one that matters.** `packages/mcp-verify` detects and
   executes verifiers *inside target repos* — `npm ci`, `npm run lint`,
   `npx tsc --noEmit`, `npm run test`. A Rust runner would still shell out to
   `npm`. It would also still shell out to `claude`: Anthropic's own Agent SDK
   documentation says the SDK "is available as a library for Python and
   TypeScript only" and that the way to drive the same agent loop from another
   language is to "run the CLI as a subprocess with the `-p` flag and
   `--output-format json`"
   ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
   fetched 2026-07-31) — which is *exactly* what `packages/runner/src/engine.ts`
   already does. So the port would remove Node from the fleet's own code while
   leaving Node as a hard runtime dependency of the fleet's job. That is
   category (c): portable only by keeping Node as a subprocess dependency
   anyway.

2. **GPUI is a published crate that its own authors describe as pre-1.0 with
   frequent breaking changes, and the component library that makes Zed look like
   Zed is GPL-3.0-or-later and explicitly not for reuse.** `gpui` 0.2.2 is on
   crates.io under Apache-2.0
   ([crates.io](https://crates.io/api/v1/crates/gpui)), and its README states
   "GPUI is still in active development as we work on the Zed code editor, and
   is still pre-1.0. There will often be breaking changes between versions"
   ([README](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/README.md)).
   `crates/ui` — Zed's own widget layer — declares `license = "GPL-3.0-or-later"`
   ([Cargo.toml](https://raw.githubusercontent.com/zed-industries/zed/main/crates/ui/Cargo.toml)),
   and a Zed maintainer wrote "We have no plans to change the licensing of `ui`
   or any of the other mentioned crates… Taking the contents of the crates
   wholesale and relicensing them is a violation of the license"
   ([discussion #13694](https://github.com/zed-industries/zed/discussions/13694)).
   This repo is MIT. Everything the operator renders today — the run list, the
   verify readout, the diff view, the co-sign affordance — would be built from
   primitives.

3. **The operator's Rust half already exists and is already the half worth
   having.** `apps/operator-desktop/src-tauri/src/lib.rs` is 905 lines of Rust
   (~565 production, ~340 in-file tests) and it holds every security-relevant
   decision: the derived SSH command prefix, the identifier validation, the
   `--reason` cap, the `/api/` path allowlist, the session lifecycle. The 2,292
   lines of `src/main.ts` are rendering. A GPUI port would rewrite the rendering
   and leave the invariants where they already are — maximum churn against the
   part that carries the least design weight.

The one thing a port would genuinely buy — a single distributable binary for the
operator — is available today from Tauri's bundler without changing a line of
the invariant-bearing Rust.

## What "this application" is, measured

### Port surface

Source lines, excluding `node_modules/`, `dist/`, `target/`, and generated
schemas. Counted 2026-07-31 with `find … | xargs cat | wc -l`.

| Unit | Prod LOC | Test LOC | Language | What it owns |
|---|---:|---:|---|---|
| `packages/runner` | 5,358 | 4,824 | TS | The run loop and every side effect: workspace, engine spawn, scope gate, verify gate, judge loop, git, PR, ledger, artifacts, evidence, the operator HTTP API |
| `apps/operator-desktop/src` | 3,346 | 622 | TS + CSS + HTML | The operator's rendering, ingest, diff parsing, verify readout |
| `packages/knowledge` | 1,102 | 929 | TS | Structural maps, compiled prose, grounding, drift, the `ask` seam |
| `packages/contract` | 1,024 | 534 | TS (zod) | The wire contract — the only place a wire shape is declared |
| `apps/operator-desktop/src-tauri` | ~571 | ~340 | **Rust** | SSH session lifecycle, command derivation, profile storage, operator-API proxy |
| `packages/judge-read` | 884 | 1,009 | JS (plain) | The judge's cage: one tool surface, one rooted reader, an MCP server |
| `packages/judge` | 628 | 853 | TS | The verdict; two transports (Anthropic SDK, `claude` CLI) |
| `packages/cli` | 578 | 443 | TS | Argument parsing; every verb delegates |
| `packages/mcp-verify` | 570 | 634 | JS (plain) | Verifier detection and execution; an MCP server; a Stop-hook core |
| `test/` (cross-cutting) | — | 780 | TS | Judge tool surface, operator verify guards, docs drift, scrub reach |
| `scripts/`, `agent-config/` | 152 | — | TS + MJS | Task validation, matrix, the agent's Stop hook |

**Totals: ~14,213 lines of production TS/JS, ~571 lines of production Rust,
~10,968 lines of test.** A complete port is roughly a 14k-line rewrite whose
test suite (11k lines) must be rewritten alongside it, because the tests are
where several ADR invariants are actually enforced
([ADR-0011](adr/0011-the-runner-owns-the-judges-reads.md) names two invariants
"asserted in tests rather than assumed").

### Third-party runtimes the system depends on

| Dependency | Where | What it does |
|---|---|---|
| `claude` CLI (headless Claude Code) | `runner/src/engine.ts`, `judge/src/index.ts` | The [engine](../CONTEXT.md#engine) and one of the two judge transports. Spawned via `execFileSync("claude", ["-p", …, "--output-format", "json", "--mcp-config", …, "--strict-mcp-config"])` |
| `@anthropic-ai/sdk` ^0.110 | `packages/judge` | The SDK judge transport, plus `zodOutputFormat` for structured output |
| `@modelcontextprotocol/sdk` ^1.13 | `mcp-verify`, `judge-read`, `runner` | Both MCP servers — the agent's `verify` tool and the judge's rooted read tool |
| `zod` ^4 | `packages/contract`, `packages/judge` | Every wire schema; the judge's verdict schema |
| `web-tree-sitter` 0.26.11 | `packages/knowledge` | WASM tree-sitter, TS/TSX/Swift grammars, for structural maps |
| `npm` / `npx` | `mcp-verify/src/verify.js` | **Runs on the target repo**, not on the control repo |
| `swift` / `xcodebuild` | `mcp-verify/src/verify.js` | Same — runs on the target |
| `git`, `gh` | `runner/src/workspace.ts`, `pr.ts`, `cosign.ts` | Subprocesses the runner owns ([ADR-0003](adr/0003-the-runner-owns-git.md)) |
| `ssh` | `src-tauri/src/lib.rs` | Already spawned from Rust |
| `commander`, `yaml`, `picomatch` | CLI, registry, scope globs | Ordinary utilities |
| Node `http` | `runner/src/ledger-serve.ts` | The ledger server, builtins only |
| Tauri v2, `reqwest`, `serde` | `src-tauri` | Already Rust |
| Vite, `lucide` | operator frontend | Build and icons |

### The distinction that decides the answer

**Node by necessity — cannot stop needing Node, whatever language the fleet is
written in:**

- `packages/mcp-verify` detects `package.json` scripts and executes `npm ci`,
  `npm run lint`, `npm run typecheck` (or `npx tsc --noEmit`), and `npm run test`
  in the workspace, plus a depth-1 sweep for nested workspaces with their own
  lockfile. The check *names* it emits (`test`, `tsc`, `eslint`, …) are the
  [mandated gate](../CONTEXT.md#mandated-gate) vocabulary, so this is not an
  implementation detail — it is the task-facing contract.
- The hermetic e2e suite runs **real** eslint, tsc and vitest inside temp
  workspaces (`packages/runner/test/e2e.test.ts`, whose header says so, and which
  `npm install`s `demo-repos/demo-ts-service` in `beforeAll`).
- The engine is `claude`, a Node-distributed CLI, spawned as a subprocess.
- Registered verifiers ([ADR-0009](adr/0009-registered-verifiers-live-in-the-control-repo.md))
  are arbitrary commands declared per target; a fleet acting on JS-shaped targets
  will keep naming JS-shaped commands.

**Node by choice — could be any language:**

- The run loop, scope gate, ledger, artifacts, evidence, PR and co-sign paths.
- The wire contract's schemas and tolerant parsers.
- The CLI verb layer.
- The knowledge layer (tree-sitter has first-class Rust bindings).
- The operator's rendering layer.

The second list is bigger. The first list is the one that determines whether the
machine you deploy to needs Node installed — and it does, permanently.

## GPUI, from primary sources

### Status and publication

`gpui` **is** on crates.io. Version 0.2.2, published 2025-10-22; the first
non-yanked release of the current line is 0.2.0 on 2025-10-09; homepage
`https://gpui.rs`, repository `zed-industries/zed`, 178,500 total downloads
([crates.io API](https://crates.io/api/v1/crates/gpui), fetched 2026-07-31). The
crate's own manifest sets `publish = true` and `license = "Apache-2.0"`, which is
an explicit override — Zed's workspace root declares `[workspace.package] publish
= false` for everything else
([Cargo.toml](https://raw.githubusercontent.com/zed-industries/zed/main/Cargo.toml)).
Publication is therefore a deliberate act, not an accident.

**Stability is stated, not implied.** The crate README: *"GPUI is still in active
development as we work on the Zed code editor, and is still pre-1.0. There will
often be breaking changes between versions."*
([README](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/README.md),
fetched 2026-07-31). The same sentence appears in the published crate docs
([docs.rs/gpui](https://docs.rs/gpui/latest/gpui/)). Under Cargo's semver rules a
0.x crate treats every minor bump as breaking, and the authors say they will use
that latitude.

**Two versions is a thin track record.** 0.2.0 → 0.2.2 spans thirteen days in
October 2025, and there has been no further publish through 2026-07-31 while Zed
itself has kept shipping. A consumer pinning the crates.io release is pinning to
a nine-month-old snapshot of a codebase that moves daily; a consumer tracking git
(which is what the largest third-party component library does — see below) is
pinning to nothing.

### Platform support

The two authoritative sources disagree, and the disagreement is itself the
finding:

- The **published crate's docs** (0.2.2) say: *"You'll also need to use the
  latest version of stable Rust and be on macOS or Linux."*
  ([docs.rs/gpui](https://docs.rs/gpui/latest/gpui/))
- The **main-branch README** lists three platforms: macOS (needs Xcode and the
  `font-kit` feature for proper text rendering), Linux/FreeBSD (needs at least
  one of the `wayland` / `x11` features), and Windows (*"No additional features
  required; uses Win32 and DirectWrite"*)
  ([README](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/README.md)).

Both fetched 2026-07-31. The safe reading: Windows support exists on `main` and
did not exist, or was not documented, in the published version. For this repo the
question is nearly moot — the operator's only supported host is a Mac driving an
SSH target — but it is a live signal about how far the published artifact trails
the source.

### Programming model

From the crate docs ([docs.rs/gpui](https://docs.rs/gpui/latest/gpui/), fetched
2026-07-31), GPUI is described as operating "around three core registers":

1. **State and communication via entities.** "Whenever you need to store
   application state that communicates between different parts of your
   application, you'll want to use GPUI's entities" — entities are owned by the
   framework and reached through smart pointers, with `App` / `Context` giving
   access to framework services and `Window` holding per-window state.
2. **High-level declarative UI.** Views implement the `Render` trait: "Views
   build a tree of elements, lay them out and style them with a tailwind-style
   API."
3. **Low-level imperative UI.** Custom elements: "Elements have total control
   over how they and their child elements are rendered."

There is an integrated async executor (`Task`), and actions/keybindings:
"Actions are used to implement keyboard-driven UI." Layout is Taffy — the
manifest pins `taffy = 0.12.2`
([Cargo.toml](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/Cargo.toml)).

**What that means for the operator concretely.** The current frontend is DOM:
`main.ts` composes HTML, `styles.css` (424 lines) styles it, `lucide` supplies
icons, and the browser supplies text layout, scrolling, focus, selection, and
reflow. In GPUI, each of those is either a Taffy layout you write or a primitive
you compose. The idioms do not transfer — `main.ts` is not "translatable" to
GPUI, it is re-designable.

### Ecosystem reality

- **Zed's own widget layer is off-limits.** `crates/ui` declares
  `license = "GPL-3.0-or-later"`
  ([Cargo.toml](https://raw.githubusercontent.com/zed-industries/zed/main/crates/ui/Cargo.toml)).
  Asked directly about relicensing `dock`, `scrollbar`, `picker`, and
  `title_bar` for use in a commercial GPUI project, a Zed maintainer answered
  "We have no plans to change the licensing of `ui` or any of the other mentioned
  crates," that they are "built to be Zed-specific and aren't intended for use
  outside of Zed," and that "Taking the contents of the crates wholesale and
  relicensing them is a violation of the license, and I don't think we can
  legally permit it." The same reply notes an intention: "At some point we want
  to build a more general-purpose UI library… under a more permissive license"
  ([discussion #13694](https://github.com/zed-industries/zed/discussions/13694),
  fetched 2026-07-31). That library does not exist yet.
- **A community component library does exist.** `longbridge/gpui-component`
  advertises "60+ cross-platform desktop UI components" — tables, editors,
  charts, a dock layout — under Apache-2.0. Its README pins GPUI by
  `git = "https://github.com/zed-industries/zed"`, i.e. it tracks the moving
  branch rather than the published crate
  ([repo](https://github.com/longbridge/gpui-component), fetched 2026-07-31).
  Adopting it means inheriting that tracking decision.
- **A licensing hazard is open against `gpui` itself.** Issue #55470 reports that
  `gpui` declares Apache-2.0 while statically linking GPL-3.0-or-later code
  through `gpui → sum_tree → ztracing → zlog`, and argues this creates GPL
  obligations for downstream binaries. The issue was open with no maintainer
  resolution visible as of the page content dated 2026-05-02
  ([issue #55470](https://github.com/zed-industries/zed/issues/55470), fetched
  2026-07-31). **This repo is MIT** (`LICENSE`, MIT, 2026). An unresolved
  GPL-contamination claim against the UI framework is a real, if bounded, risk
  for an MIT public reference implementation — the kind of thing that should be
  settled before adoption, not after.

### Accessibility, IME, and platform integration

`accesskit` is a dependency in `crates/gpui/Cargo.toml`, so the plumbing is
present. What the project says about the outcome is less encouraging.

The accessibility tracking discussion opens (2023-03-26) with: *"A11y
(accessibility) in Zed will be a long project. Likely lasting far beyond 1.0."*
A contributor comment dated 2026-07-17 reports "Zed seems to be doing some
accessibility experiments on the `main` branch… Some menus, some interface
elements are accessible but there is a long way to go," gated behind
`ZED_EXPERIMENTAL_A11Y=1`
([discussion #6576](https://github.com/zed-industries/zed/discussions/6576),
fetched 2026-07-31). A Windows screen-reader issue opened 2025-10-24 and still
open reports "Zed is absolutely silent" under JAWS and NVDA
([issue #41138](https://github.com/zed-industries/zed/issues/41138), fetched
2026-07-31).

For a workbench whose job is to present a [kill log](../CONTEXT.md#kill-log) and
a [co-sign](../CONTEXT.md#co-sign) decision to a human, this is not a footnote.
The webview gives the operator screen-reader semantics, IME, text selection,
and focus order for free today.

## Tauri, the incumbent

What `apps/operator-desktop` currently gets, and what a GPUI app would have to
replace or re-obtain:

| Tauri v2 supplies | Source | GPUI equivalent |
|---|---|---|
| A system webview via WRY, windows via TAO | [Architecture](https://v2.tauri.app/concept/architecture/) — WRY is "A cross-platform WebView rendering library in Rust"; TAO is a "Cross-platform application window creation library in Rust" | GPUI supplies the window; the rendering is yours |
| IPC / `#[tauri::command]` | Architecture docs: communication through "message passing" between webview and Rust backend | Not needed — one process, no boundary |
| Capabilities/permissions | [Capabilities](https://v2.tauri.app/security/capabilities/): "Capabilities define which permissions are granted or denied for which windows or webviews" | Nothing equivalent; the repo's `capabilities/default.json` grants only `core:default` today, so little is lost |
| Bundler + signing + updater | [Updater plugin](https://v2.tauri.app/plugin/updater/): "Tauri's updater needs a signature to verify that the update is from a trusted source. This cannot be disabled" | Rebuild on `cargo-bundle` / platform tooling; no first-party updater |
| CSP enforcement | `tauri.conf.json` sets a restrictive `default-src 'self'` policy today | Not applicable — no web content to constrain |

**On size and memory: Tauri publishes one number and no others.** The official
start page states "a minimal Tauri app can be less than 600KB in size"
([v2.tauri.app/start](https://v2.tauri.app/start/), fetched 2026-07-31). No
first-party memory or startup-time figures were found on Tauri's site, and GPUI's
own docs publish none either. **Any memory or startup comparison in this document
would be invented, so none is offered.** If this becomes decision-relevant, it
must be measured locally, not cited.

## Rust replacements, dependency by dependency

| Need | Rust answer | Maturity (fetched 2026-07-31) |
|---|---|---|
| MCP (both servers) | **`rmcp`**, the official SDK — the repo describes itself as "An official Rust Model Context Protocol SDK implementation with tokio async runtime" and lives in the `modelcontextprotocol` org | 3.0.1 (2026-07-29), 18.1M total downloads, Apache-2.0. stdio, child-process, streamable-HTTP, and in-process transports. Implements the `2026-07-28` spec, compatible back to `2025-11-25`. ([repo](https://github.com/modelcontextprotocol/rust-sdk), [crates.io](https://crates.io/api/v1/crates/rmcp)) |
| Anthropic API (SDK judge transport) | **None first-party.** Anthropic's official client SDKs are "Python, TypeScript, C#, Go, Java, PHP, and Ruby" ([CLI, SDKs, and libraries](https://platform.claude.com/docs/en/api/client-sdks)) | Community only. A crates.io search for `anthropic` returns multi-provider wrappers — `rig-core`, `genai` ("Multi-AI Providers Library for Rust… Anthropic…"), `llm` — none of them an Anthropic-owned client ([crates.io search](https://crates.io/api/v1/crates?q=anthropic&sort=downloads)) |
| Agent engine | **Spawn `claude` identically.** The Agent SDK "is available as a library for Python and TypeScript only. To drive the same agent loop from another language, run the CLI as a subprocess with the `-p` flag and `--output-format json`" ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)) | This is already what `engine.ts` does. A Rust runner loses nothing here |
| Wire contract | `serde` + `serde_json` | See the tolerant-reader analysis below |
| Structured verdict output | `schemars` for JSON Schema; no `zodOutputFormat` equivalent from a first-party SDK | The SDK judge's `output_config.format` would have to be constructed by hand against the raw HTTP API |
| Process orchestration | `std::process` / `tokio::process` | `tokio` 1.53.1, 841M downloads ([crates.io](https://crates.io/api/v1/crates/tokio)) |
| Git | `gix` ("Interact with git repositories just like git would", 0.86.0, 40.8M downloads, [crates.io](https://crates.io/api/v1/crates/gix)) — or keep shelling to `git`, which is what the runner does now | ADR-0003 cares that *the runner* owns git, not how. Shelling out remains legitimate |
| GitHub | No first-party crate; keep shelling to `gh` | Same reasoning — `gh` runs under the runner's own auth ([ADR-0005](adr/0005-operator-drives-the-cli-over-ssh.md)) |
| SSH | Already `std::process::Command::new("ssh")` in `src-tauri` | Nothing to port |
| HTTP server (ledger serve, operator API) | `axum` (0.8.9, 406M downloads, [crates.io](https://crates.io/api/v1/crates/axum)) or `hyper` | Comfortably mature |
| JSONL ledger | `serde_json` line-at-a-time | Direct |
| Structural maps | `tree-sitter` native bindings | Replaces `web-tree-sitter`; likely faster, and drops the WASM grammar loading in `parser-backend.ts` |
| YAML registry | `serde_yaml` / `serde_norway` | Direct |
| Glob scope contract | `globset` | Replaces `picomatch`; **semantics differ**, and the [scope contract](../CONTEXT.md#scope-contract) is a mechanical kill gate, so a difference here is a behaviour change, not a refactor |

### Does Rust's type system help or fight the tolerant reader?

[ADR-0001](adr/0001-tolerant-reader-wire-contract.md) requires: ignore unknown
fields, degrade on missing optional fields, and fail loudly — naming the field —
only on a missing or mistyped required field. Open vocabularies (`status`,
`stage`, refusal `code`, PR state) stay plain strings.

**serde's defaults are aligned with this, not against it.** Serde documents that
"When this attribute is not present, by default unknown fields are ignored for
self-describing formats like JSON" — the attribute being `deny_unknown_fields`,
which "Always error during deserialization when encountering unknown fields."
`#[serde(default)]` means "any missing fields should be filled in from the
struct's implementation of `Default`"
([container attributes](https://serde.rs/container-attrs.html), fetched
2026-07-31). Tolerant reading is the default; strictness is opt-in. That is the
right polarity.

Three frictions, none fatal:

- **Open vocabularies want `String`, and Rust programmers want enums.** The
  contract's rule — a newer runner may speak a status an older operator has never
  heard of — maps to `status: String` plus a `fn run_facts(&str) -> Option<Facts>`
  lookup, which is exactly the shape `schemas.ts` already has (`runFacts` returns
  `RunFacts | undefined`). The temptation to write `enum RunStatus` and derive
  `Deserialize` would silently reintroduce fail-closed behaviour. This is a
  discipline problem the language makes *easier to get wrong*, not a capability
  gap.
- **Structural discriminants get better.** `RunDetailResponse.state`,
  `SyncState.kind`, and the in-flight record's `v` are deliberately strict.
  Serde's internally-tagged enums express that natively and exhaustively — a
  genuine improvement over zod's discriminated unions, because the compiler
  forces every reader to handle every variant.
- **Field-path error messages are worse out of the box.** `parse.ts` builds
  dotted paths with bracketed indices ("entries[3].timings.agentMs") and
  pre-formats them for the operator's error banner. `serde_json`'s errors carry
  line/column, not a field path; `serde_path_to_error` recovers the path at the
  cost of wrapping every call site. This is recoverable work, not a blocker — but
  it is work, and the loud-and-named failure is the *point* of ADR-0001.

`RUN_FACTS`'s `satisfies Record<RunStatus, RunFacts>` — the compile error that
[ADR-0008](adr/0008-one-status-facts-table.md) depends on — becomes an exhaustive
`match`, which is strictly stronger.

### Keeping the hermetic e2e tests

This is the least glamorous and most decisive line item. The suite today creates
temp workspaces, symlinks a demo repo's `node_modules`, and runs **real** eslint,
tsc and vitest through the same `mcp-verify` code path a live run uses.

In Rust, that becomes `#[test]` functions using `tempfile`, `std::process`, and
`assert_cmd`, spawning the same `npm` commands. The tests port structurally
unchanged — and that is precisely the tell: **the tests still need Node, npm, and
a JS toolchain on the machine.** Rewriting them in Rust changes who writes the
assertions and nothing about what the machine must have installed.

## Portability, unit by unit

Using the requested categories: (a) trivially portable, (b) portable with real
work, (c) portable only by keeping Node as a subprocess dependency anyway,
(d) not portable, or portable only by losing something an ADR protects.

| Unit | Category | Notes |
|---|---|---|
| `packages/contract` | **(b)** | serde is the right shape; ADR-0001's field-path errors need `serde_path_to_error`; the open-vocabulary discipline must survive the rewrite |
| `packages/cli` | **(a)** | `clap` for `commander`. 578 lines of argument parsing that delegates |
| `packages/runner` | **(b)/(c)** | The loop, gates, ledger and artifacts port cleanly; the engine spawn and the git/`gh` subprocesses stay subprocesses. **`globset` vs `picomatch` semantics must be pinned by test, or the scope gate changes behaviour silently** |
| `packages/mcp-verify` | **(c)** | Detection logic ports; execution is `npm`/`npx`/`swift`/`xcodebuild` either way. `rmcp` replaces the MCP server. The unit's whole job is orchestrating other people's toolchains |
| `packages/judge-read` | **(b)** | `rmcp` server + a rooted reader. The root check is ~50 lines of `Path::canonicalize` and a prefix assertion, and Rust makes it easier to get right |
| `packages/judge` | **(b)/(d)** | The CLI transport is a subprocess spawn — fine. The SDK transport has **no first-party Rust client**, so it becomes hand-rolled HTTP against the Messages API. ADR-0011 kept both transports precisely because the SDK path "enforces the verdict's shape through structured output"; reimplementing `output_config.format` by hand is where that guarantee would erode. This is the single place a port most plausibly *loses* something an ADR protects |
| `packages/knowledge` | **(b)** | Native tree-sitter is a strict improvement over WASM loading. The prose compiler needs the same Anthropic HTTP work as the judge |
| `apps/operator-desktop/src-tauri` | **(a)** | Already Rust. Nothing to do |
| `apps/operator-desktop/src` | **(b)+++** | ~3,300 lines of DOM rendering → GPUI element trees, plus everything the webview supplied for free (text layout, scrolling, focus, selection, IME, screen-reader semantics). Not hard so much as *large*, and the component ecosystem is either GPL or a git-tracked third party |
| `agent-config/` | **(d)** | The agent's [cage](../CONTEXT.md#cage) is `.claude/settings.json` plus a Node Stop hook, read by Claude Code. It is Claude Code's format, not ours. It does not port; it stays |
| `test/` + per-package tests | **(c)** | Port structurally; still require Node and npm on the host |

Nothing in the fleet is category (d) *because Rust can't express it*. The (d)
entries are (d) because the thing being ported is somebody else's format
(`agent-config/`) or because a first-party guarantee exists in one language and
not the other (the SDK judge's structured output).

### Which ADR invariants a port threatens, and which it preserves

**Preserved or strengthened:**

- [ADR-0003](adr/0003-the-runner-owns-git.md) — the [cage](../CONTEXT.md#cage) is
  enforced by the agent's allowlist and the runner's process boundaries, neither
  of which is language-dependent.
- [ADR-0004](adr/0004-verification-tri-state-and-mandated-gates.md) — the
  [verify tri-state](../CONTEXT.md#verification-state) becomes a Rust enum with
  exhaustive matching. A false green gets *harder* to write.
- [ADR-0008](adr/0008-one-status-facts-table.md) — `match` beats `satisfies`.
- [ADR-0005](adr/0005-operator-drives-the-cli-over-ssh.md) — already Rust, and
  the absence of `--force` on `fleet cosign` is a CLI property the operator
  inherits regardless.

**Threatened:**

- [ADR-0001](adr/0001-tolerant-reader-wire-contract.md) — twice. Once because
  Rust's ergonomics pull toward `enum` where the contract demands `String`, and
  once because the loud, field-named parse failure needs extra machinery. Both
  are avoidable; neither is free.
- [ADR-0011](adr/0011-the-runner-owns-the-judges-reads.md) — the ADR explicitly
  rejected collapsing to one transport because the SDK path "enforces the
  verdict's shape through structured output, while the CLI path has no such flag
  and recovers JSON from prose." With no first-party Rust SDK, the port either
  hand-rolls that enforcement or drifts toward the collapse the ADR refused.
- The [scope contract](../CONTEXT.md#scope-contract) — a glob-engine swap changes
  a mechanical kill gate. Recoverable with a differential test suite; silent
  without one.

## What a port would bring

**For.**

- **One binary for the operator.** No Node, no `pnpm install`, no Vite build for
  a person who only wants to co-sign a PR. This is the strongest single argument
  — and see the verdict, because Tauri already delivers it.
- **One language in the repo** (nearly — `agent-config/` stays JS because Claude
  Code owns that format).
- **Exhaustive matching on the wire vocabulary's structural half**, which is a
  real gain over zod for `RunDetailResponse.state`, `SyncState.kind`, and the
  in-flight `v`.
- **Native tree-sitter** instead of WASM loading in `packages/knowledge`.
- **No JS toolchain in the operator's build** — no Vite, no `tsc`, no
  `node_modules` in `apps/`.
- Startup and memory would very likely improve. **No first-party figure exists
  for either Tauri or GPUI, so this is stated as an expectation, not a
  measurement.**

**Against.**

- **~14,200 production lines plus ~11,000 test lines rewritten**, against a
  system whose value is that its gates are trustworthy. Every line of that
  rewrite is a chance to introduce the one output this system may not produce.
- **The UI framework is pre-1.0 by its authors' own statement**, published twice
  nine months ago, with breaking changes promised between versions.
- **No component library this repo can legally use.** Zed's `crates/ui` is
  GPL-3.0-or-later and its maintainers have said it is not for outside use; this
  repo is MIT. The Apache-2.0 community alternative tracks GPUI by git ref.
- **An open, unresolved GPL-contamination claim against `gpui` itself**
  (issue #55470).
- **Accessibility regresses from "whatever the webview gives you" to "what
  AccessKit integration has reached so far"**, on a project whose own tracker
  calls a11y "a long project… far beyond 1.0."
- **Ecosystem thinness where it matters most**: no first-party Anthropic Rust
  SDK, which is a direct hit on ADR-0011's rationale for keeping two judge
  transports.
- **The targets and the tooling stay JS-shaped.** The fleet's job is running
  `npm run test` in other people's repositories. A Rust fleet still needs Node
  installed everywhere it runs.

## Verdict and recommended path

### Port nothing. Then, if the operator's distribution is the real complaint, fix that directly.

**1. Do not port the runner, the CLI, the contract, the judge, or verification.**
The port is category (c) — Node survives as a subprocess dependency no matter
what — so the headline benefit ("get off Node") is not actually available. What
*is* available is a 25,000-line rewrite that threatens two ADR invariants
(0001's loud tolerant reader, 0011's structured-output guarantee) in exchange for
type-safety gains that the existing `RUN_FACTS`/`satisfies`/zod arrangement
already approximates. That is a bad trade, and it would be a bad trade even if
GPUI were 3.0 and had a permissive component library.

**2. Do not port the operator frontend to GPUI — today.** Not because GPUI is
bad, but because the operator's *hard* part is already in Rust and the port would
touch only its easy part. `src-tauri/src/lib.rs` holds the command derivation,
the identifier validation, the `--reason` cap, the `/api/` allowlist, and the
session lifecycle — 565 production lines with 340 lines of tests sitting on top
of them, locked further by `test/operator-verify-guards.test.ts`. `main.ts` holds
2,292 lines of rendering. Rewriting the rendering in a pre-1.0 framework, with no
usable component library and a regression in accessibility, buys a single binary
— which is the one thing Tauri's bundler already produces.

**3. If "one binary, no Node for the operator" is the actual requirement, get it
without GPUI.** `pnpm operator:build` already runs `tauri build` and
`tauri.conf.json` already sets `"bundle": {"active": true, "targets": ["app"]}`.
The Node dependency in the operator is a *build-time* dependency (Vite + tsc),
not a runtime one — a shipped `.app` needs neither. If the friction is that
contributors must run `pnpm install` before `tauri dev`, that is a packaging
problem with a packaging fix, not an architecture problem with a rewrite fix.

**4. If a staged experiment is wanted anyway, this is the order.** Only the first
step is cheap enough to justify on curiosity:

- **Step 1 (a weekend, throwaway):** build the *run list* — one pane, one table,
  the [ledger](../CONTEXT.md#kill-log) rows with their status chips — as a
  standalone GPUI binary reading the operator API over loopback. That single view
  exercises virtualized lists, text layout, theming, and keyboard navigation, and
  it answers the only question that matters: how much do you have to build before
  it stops looking like a prototype. Delete it afterwards, the way the knowledge
  prototype was deleted ([ADR-0006](adr/0006-pre-compiled-knowledge-layer.md)).
- **Step 2 (only if step 1 is convincing):** port `packages/contract` to serde as
  a *parallel* crate, and hold it against the TS implementation with a
  differential test over the existing ledger fixtures. This is the highest-value,
  lowest-risk unit — small, well-tested, and the one place a wire shape is
  declared.
- **Step 3:** nothing. Do not start the runner.

## What would have to become true to flip this

For the **operator + GPUI** answer to flip, all three:

1. GPUI reaches 1.0, or Zed commits publicly to semver on the crates.io release
   and resumes publishing on a cadence. Two versions in October 2025 and silence
   through July 2026 is not a supply chain.
2. The "more general-purpose UI library… under a more permissive license" the Zed
   maintainer described in discussion #13694 actually ships — or
   `gpui-component` becomes something a public MIT reference implementation is
   comfortable depending on, with issue #55470's GPL-contamination question
   resolved.
3. Accessibility moves from `ZED_EXPERIMENTAL_A11Y=1` to a supported feature. The
   operator's whole purpose is presenting evidence to a human before a co-sign.

For the **fleet + Rust** answer to flip, any one of:

1. Anthropic ships a first-party Rust client SDK with structured-output support.
   That single fact removes ADR-0011's strongest argument against a Rust judge.
2. The fleet's targets stop being JS-shaped — e.g. the registered-verifier work
   ([ADR-0009](adr/0009-registered-verifiers-live-in-the-control-repo.md), not yet
   built) lands and the detected `npm` checks become a minority path. Then "Node
   by necessity" shrinks to "Node for some targets."
3. Someone measures a specific, load-bearing performance problem in the runner
   that Node causes. Nothing in this repo currently claims one; the run is
   dominated by model latency and by `npm ci`.

Absent those, this is a rewrite in search of a reason.

## Research gaps

- **No measurements were taken.** No startup time, no RSS, no bundle size for
  either the current Tauri operator or a GPUI equivalent. First-party figures do
  not exist for the comparison, and inventing them would be worse than leaving
  the gap.
- **No GPUI prototype was built.** The "how much do you build yourself" estimate
  is inferred from `crates/ui`'s license and `gpui-component`'s component count,
  not from writing a view.
- **`globset` vs `picomatch` semantics were not diffed.** They are named as a
  risk to the scope contract, not characterized.
- **`gpui.rs` was not read directly** — the site returned HTTP 403 to the fetch
  on 2026-07-31. Every GPUI claim here comes from the crate README, the published
  docs.rs docs, the manifests, or the issue tracker instead.
- **Community Anthropic Rust crates were not evaluated for fitness** — only for
  existence and first-party status. `rig-core` and `genai` may be perfectly
  serviceable; nothing here says otherwise.

## Sources

All web sources fetched **2026-07-31** unless stated. Vendor claims are
first-party and not independently verified.

**GPUI (status, licensing, platform, model):**

- [`crates/gpui/README.md`](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/README.md)
  — settled the pre-1.0 / breaking-changes statement and the three-platform
  feature matrix (macOS + `font-kit`, Linux/FreeBSD + `wayland`/`x11`, Windows via
  Win32/DirectWrite).
- [`crates/gpui/Cargo.toml`](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/Cargo.toml)
  — settled version 0.2.2, `publish = true`, `license = "Apache-2.0"`, and the
  dependency set (accesskit, taffy 0.12.2, cocoa/metal, windows, scap).
- [`Cargo.toml` (workspace root)](https://raw.githubusercontent.com/zed-industries/zed/main/Cargo.toml)
  — settled `[workspace.package] publish = false`, making gpui's publication a
  deliberate override.
- [crates.io API: `gpui`](https://crates.io/api/v1/crates/gpui) — settled the
  publish history (0.2.0 2025-10-09 → 0.2.2 2025-10-22; earlier releases yanked),
  178,500 total downloads, homepage `gpui.rs`.
- [docs.rs/gpui](https://docs.rs/gpui/latest/gpui/) — settled the programming
  model (entities, `Render`, tailwind-style styling, elements, `Task`, actions)
  and the published version's "macOS or Linux" platform statement.
- [`crates/ui/Cargo.toml`](https://raw.githubusercontent.com/zed-industries/zed/main/crates/ui/Cargo.toml)
  — settled `license = "GPL-3.0-or-later"` on Zed's widget layer.
- [zed discussion #13694](https://github.com/zed-industries/zed/discussions/13694)
  — settled the maintainer position on reusing `ui` outside Zed and the stated
  intent to eventually build a permissively-licensed general-purpose library.
- [zed issue #55470](https://github.com/zed-industries/zed/issues/55470) —
  settled that an open, unresolved claim exists that gpui's Apache-2.0 is
  contaminated by GPL-3.0-or-later transitive deps (`sum_tree → ztracing → zlog`).
  Page content dated 2026-05-02.
- [zed discussion #6576](https://github.com/zed-industries/zed/discussions/6576)
  — settled the accessibility posture: "a long project… far beyond 1.0" (2023),
  `ZED_EXPERIMENTAL_A11Y=1` experiments reported 2026-07-17.
- [zed issue #41138](https://github.com/zed-industries/zed/issues/41138) —
  settled the current Windows screen-reader state ("Zed is absolutely silent"),
  open since 2025-10-24.
- [longbridge/gpui-component](https://github.com/longbridge/gpui-component) —
  settled the community component library's existence, 60+ components, Apache-2.0,
  and that it depends on GPUI by git ref rather than a crates.io version.

**Tauri v2:**

- [Architecture](https://v2.tauri.app/concept/architecture/) — settled WRY/TAO
  roles and the IPC message-passing model.
- [Capabilities](https://v2.tauri.app/security/capabilities/) — settled the
  capabilities/permissions/scopes model and its window-label boundary.
- [Getting started](https://v2.tauri.app/start/) — settled the only first-party
  size claim ("less than 600KB") and the absence of published memory figures.
- [Updater plugin](https://v2.tauri.app/plugin/updater/) — settled mandatory
  signature verification and platform coverage.

**Anthropic tooling:**

- [CLI, SDKs, and libraries](https://platform.claude.com/docs/en/api/client-sdks)
  — settled the official client-SDK language list (Python, TypeScript, C#, Go,
  Java, PHP, Ruby) and therefore the absence of a first-party Rust SDK.
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
  — settled that the Agent SDK is Python and TypeScript only, and that the
  documented cross-language path is running the CLI as a subprocess with `-p`
  and `--output-format json`.

**Rust ecosystem:**

- [modelcontextprotocol/rust-sdk](https://github.com/modelcontextprotocol/rust-sdk)
  — settled that `rmcp` is the official MCP Rust SDK and its transport list.
- [crates.io API: `rmcp`](https://crates.io/api/v1/crates/rmcp) — settled 3.0.1
  (2026-07-29), 18.1M total downloads, Apache-2.0.
- [crates.io search: `anthropic`](https://crates.io/api/v1/crates?q=anthropic&sort=downloads)
  — settled that the Anthropic-capable Rust crates are community multi-provider
  wrappers (`rig-core`, `genai`, `llm`), not a first-party client.
- [serde container attributes](https://serde.rs/container-attrs.html) — settled
  that unknown fields are ignored by default for JSON, and the meanings of
  `deny_unknown_fields`, `default`, and `untagged`.
- [crates.io API: `tokio`](https://crates.io/api/v1/crates/tokio) — 1.53.1,
  841M downloads.
- [crates.io API: `axum`](https://crates.io/api/v1/crates/axum) — 0.8.9,
  406M downloads.
- [crates.io API: `gix`](https://crates.io/api/v1/crates/gix) — 0.86.0,
  40.8M downloads.

**In-repo (measured, not fetched):** `packages/*/src`, `packages/*/test`,
`apps/operator-desktop/{src,src-tauri,test}`, `test/`, `scripts/`,
`agent-config/`, every `package.json`, `Cargo.toml`, `tauri.conf.json`,
`capabilities/default.json`, and `LICENSE`, on 2026-07-31.
