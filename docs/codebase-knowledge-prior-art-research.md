# Pre-Compiled Codebase Knowledge: Prior Art Research

Status: research reference (wayfinder ticket #51, part of map #50)

Last updated: 2026-07-18

## Purpose

This document surveys existing artifact forms for pre-compiled codebase
understanding and compares them against the fleet's two consumers:

- **(a) Human ideation Q&A** — "what if the product did X — where and how does
  that land?" answered early and cheaply, before any run is dispatched.
- **(b) Run-time agents** — a fleet agent receiving the artifact so it skips
  cold exploration of the target repo.

Six forms are surveyed: Spotify's Honk (public information), Aider's repo-map,
ctags/tree-sitter symbol graphs, curated context files (CLAUDE.md-style),
Sourcegraph/Glean-style code intelligence, and embedding indexes. Every claim
cites the primary source that owns it. The survey does not include hands-on
benchmarking; token-cost figures are those published by the tool authors.

## Executive Summary

The prior art splits into three families with different cost/quality centers of
gravity:

1. **Compressed structural maps** (Aider repo-map, ctags/tree-sitter graphs)
   are cheap to build, deterministic, and token-budgeted by design — Aider fits
   a whole-repo map into ~1k tokens by default. They answer "what exists and
   what references what," but carry no intent or product-level narrative, so
   they serve run-time orientation better than ideation Q&A.
2. **Curated prose context** (CLAUDE.md-style files) is the only form that
   natively carries intent, conventions, and "why" — exactly what ideation Q&A
   needs — but it is hand-maintained, goes stale silently, and Anthropic's own
   guidance caps useful size (~200 lines per file) because adherence drops as
   the file grows.
3. **Full code-intelligence databases** (SCIP, Glean) and **embedding indexes**
   (Cursor-style) give precise or semantic retrieval at industrial scale, but
   require per-language indexers or embedding infrastructure — a heavy
   dependency for a repo-agnostic onboarding step.

The most striking finding is negative: **Spotify's Honk deliberately uses no
pre-compiled repo knowledge at all.** The team states they have no code search
or documentation tools exposed to the agent, and instead condense context into
large, static, version-controlled prompts because dynamic context "makes it
less testable and predictable." The fleet's core bet — that a pre-compiled
artifact beats cold exploration — is therefore *not* proven by Honk; it is a
bet Honk explicitly declined to take, in favor of prompt craft plus strong
feedback loops. The closest positive evidence is Cursor's published claim that
semantic search over a pre-built index yields ~12.5% higher answer accuracy
than grep alone, and Meta's use of Glean facts for RAG in AI coding assistants.

For the fleet, the pattern that best fits both consumers is a **hybrid**: a
deterministic structural map (tree-sitter derived, token-budgeted, rebuilt per
commit at O(changes) cost) fused with a small curated/generated prose layer
(architecture, seams, conventions) — the first serving run-time agents, the
second serving ideation, each cheap enough to regenerate at onboarding.

## Form 1: Spotify Honk — No Pre-Compiled Knowledge (a deliberate anti-pattern)

**What it is.** Honk is Spotify's internal background coding agent, built on
Claude Code and the Claude Agent SDK, riding on the existing Fleet Management
platform: prompts go in, jobs run "in a containerized environment, which then
automatically open pull requests against the target repositories," with 1,500+
merged PRs and ~650 agent-generated PRs merging per month
([Part 1](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1)).

**Codebase knowledge approach.** The context-engineering post
([Part 2](https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2))
is explicit: "Notably, we don't currently have code search or documentation
tools exposed to our agent." Users are asked to "condense relevant context into
the prompt up front." The team prefers "larger static prompts, which are easier
to reason about. You can version-control the prompts, write tests, and
evaluate their performance." Their stated reason for rejecting dynamic
context/MCP tooling: it "makes it less testable and predictable. The more
tools you have, the more dimensions of unpredictability you introduce."

**Freshness.** Not applicable — the "artifact" is the prompt, versioned like
code.

**Token cost / quality.** No public figures on exploration token cost. Part 1
acknowledges "the significant computational expense of running LLMs at scale"
and that "agents can take a long time to produce a result, and their output
can be unpredictable" — predictability is recovered via feedback loops
([Part 3](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3)),
not via repo knowledge.

**Fit — ideation Q&A:** none; Honk has no surface for "where would X land?"
questions. **Fit — run-time agents:** the null baseline. Honk demonstrates
that fleet-style background agents *can* ship at scale with zero pre-compiled
repo knowledge, provided the tasks are migration-shaped and the prompt carries
the context. That is exactly the hypothesis ticket #54's prototype must beat.

## Form 2: Aider Repo-Map — Token-Budgeted Structural Map

**What it is.** "A concise map of your whole git repository" listing key
symbols defined in each file with "critical lines of code for each definition"
— enough that the LLM "can figure out how to use the API exported from a
module just based on the details shown in the map"
([repo-map docs](https://aider.chat/docs/repomap.html)).

**How it's built.** Tree-sitter parses each source file to an AST; "we can
identify where functions, classes, variables, types and other definitions
occur in the source code. We can also identify where else in the code these
things are used or referenced." Relevance is computed with "a graph ranking
algorithm, computed on a graph where each source file is a node and edges
connect files which have dependencies" (a PageRank-style pass over the
definition/reference graph). It replaced an earlier ctags-based map because
the tree-sitter map "is richer, showing full function call signatures and
other details straight from the source files," with wide language support and
no external binary to install
([repo-map blog post](https://aider.chat/2023/10/22/repomap.html)).

**Freshness.** Rebuilt automatically from the working tree — the map is a
cheap derived artifact, never a stored index that can go stale.

**Token cost.** Explicitly budgeted: `--map-tokens` defaults to **1k tokens**;
aider sizes the map dynamically based on chat state and selects the
highest-ranked symbols that fit the budget. This is the strongest published
token-cost story of any surveyed form.

**Quality.** No published quantitative benchmark of map-vs-no-map answer
quality; the ranking filter means "less-frequently-called but contextually
important code" can be omitted.

**Fit — ideation Q&A:** weak alone — the map says *what exists*, not *what the
product does* or *where a feature belongs*. **Fit — run-time agents:** strong;
this is precisely a "skip cold exploration" artifact, deterministic and
repo-agnostic (130+ languages via tree-sitter query files), buildable at
onboarding with no infrastructure.

## Form 3: ctags / Tree-Sitter Symbol Graphs

**What it is.** The classic form: a `tags` file indexing "language objects"
so they can be "quickly and easily located by a text editor or other
utilities." Each entry records the symbol name, file, a locating EX command,
and extension fields (line, kind, scope, type)
([Universal Ctags manual](https://docs.ctags.io/en/latest/man/ctags.1.html)).

**Definitions vs. references.** Historically definitions only; Universal
Ctags "can also tag references of language objects," but reference tagging is
"new and limited to specific areas of specific languages in the current
version." A raw tags file therefore under-represents the dependency structure
that made Aider's graph ranking possible — modern users get references from
tree-sitter queries instead (as aider does).

**Freshness.** Regenerated by a single fast scan; trivially rerun per commit.

**Token cost / quality.** The raw artifact is line-oriented and unranked — for
a large repo it is far too big to inject wholesale, and it carries no
prioritization. It is best understood as the *substrate* (symbol inventory +
locations) from which a budgeted map (Form 2) is compiled.

**Fit — ideation Q&A:** poor. **Fit — run-time agents:** useful as a lookup
tool an agent queries, or as raw input to a compiled map; not a
context-injection artifact by itself.

## Form 4: Curated Context Files (CLAUDE.md-style)

**What it is.** Hand-written (or `/init`-generated, then human-refined)
markdown that gives the agent persistent project context: "build commands,
conventions, project layout, 'always do X' rules." Anthropic's docs describe a
layered system: project-root files loaded in full every session, per-directory
files "included when Claude reads files in those subdirectories," path-scoped
rules, and `@path` imports
([Claude Code memory docs](https://code.claude.com/docs/en/memory)).

**How it's built / kept fresh.** By humans, on the trigger "Claude makes the
same mistake a second time" or "you type the same correction… that you typed
last session." There is no automatic freshness mechanism; the docs advise
reviewing files "periodically to remove outdated or conflicting instructions."
Auto memory adds an agent-written layer (index capped at 200 lines / 25KB)
but is machine-local, not a shared repo artifact.

**Token cost.** Loaded into every session's context. Explicit guidance:
"target under 200 lines per CLAUDE.md file. Longer files consume more context
and reduce adherence." Per-directory files and path-scoped rules exist
precisely to keep the always-loaded core small.

**Quality.** The only surveyed form that carries *intent*: architecture
decisions, naming conventions, "why," and product framing — none of which any
structural index can express. The documented failure modes are equally
distinctive: staleness, contradiction between files ("Claude may pick one
arbitrarily"), and adherence decay with size.

**Fit — ideation Q&A:** strongest of all forms — a well-curated
architecture/conventions note is close to a direct answer sheet for "where
would X land?" **Fit — run-time agents:** strong as the intent layer, but it
cannot replace symbol-level lookup, and its hand-maintenance conflicts with
the fleet's repo-agnostic onboarding constraint unless the fleet *generates*
it (an `/init`-style compile step) rather than expecting target owners to
write it.

## Form 5: Sourcegraph SCIP / Meta Glean — Code-Intelligence Databases

**What it is (SCIP).** SCIP is "a language-agnostic protocol for indexing
source code, which can be used to power code navigation functionality such as
Go to definition and Find references" — a Protobuf schema of documents,
occurrences, and human-readable symbol IDs, produced by per-language indexers
([SCIP repo](https://github.com/sourcegraph/scip),
[announcement](https://sourcegraph.com/blog/announcing-scip)).

**What it is (Glean).** "A system for working with facts about source code":
typed facts under user-defined schemas ("immutable terms… form a DAG"),
stored on RocksDB, queried via Angle, "a logic language with similarities to
Datalog." Each language has "their own data schema"; indexers exist for C++,
Hack, Python, Haskell, Flow, plus LSIF/SCIP ingestion for Go, Java, Rust,
TypeScript ([Glean docs](https://glean.software/docs/introduction/),
[Meta engineering post](https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/)).

**Freshness.** Meta's answer is incremental indexing: "we want the cost of
indexing to be *O(changes)* rather than *O(repository)*," degraded to
"*O(fanout)*" where dependencies force reprocessing; immutable database
stacking lets multiple revisions coexist cheaply.

**Token cost / quality.** Not a context-injection artifact at all — it is a
query service. Precision is its whole point (exact definitions, exact
references). Notably, Meta lists "Retrieval Augmented Generation (RAG) in AI
coding assistants" among Glean's consumers — primary-source evidence that
precise pre-compiled code facts are being fed to LLMs at scale.

**Fit — ideation Q&A:** indirect; it answers "where is X used?" precisely but
says nothing about product intent. **Fit — run-time agents:** high quality but
high cost: per-language indexers and a serving layer are heavy machinery for a
fleet that onboards arbitrary local repos. The transferable ideas are the
*symbol-ID discipline* and the *O(changes) freshness target*, not the
infrastructure.

## Form 6: Embedding Indexes (Cursor-style semantic search)

**What it is.** Code is chunked into "meaningful units (functions, classes,
logical blocks)," each chunk embedded with "a custom embedding model," stored
in a vector database; queries embed the same way and retrieve
nearest-neighbor chunks
([Cursor search docs](https://cursor.com/docs/agent/tools/search)).

**Freshness.** Indexing "begins automatically upon workspace opening," is
searchable at 80% completion, and syncs "every 5 minutes" — modified files get
old embeddings replaced, deleted files are removed.

**Token cost / quality.** Retrieval returns only relevant chunks, so injected
context is proportional to the question, not the repo. Cursor's published
claim: "combining it with grep produces 12.5% higher accuracy answering
codebase questions compared to grep alone," with the gain "particularly
substantial for larger codebases exceeding 1,000 files." Their agent uses
semantic search for concept-level queries and grep to "fill in details" —
i.e., embeddings *complement* rather than replace lexical search.

**Fit — ideation Q&A:** good for concept-shaped questions ("where is playback
volume handled?") without exact keywords — closest in spirit to the ideation
use case among the automated forms. **Fit — run-time agents:** good, but
requires an embedding model, a vector store, and a sync daemon per target —
the heaviest operational dependency of the lightweight forms, and answer
quality is probabilistic rather than deterministic.

## Comparison

| Form | Build cost | Freshness story | Injected token cost | Carries intent? | Ideation Q&A (a) | Run-time agent (b) |
| --- | --- | --- | --- | --- | --- | --- |
| Honk (none) | zero | n/a (prompt is versioned) | prompt-sized, human-curated per task | only what the prompt author adds | none | baseline to beat |
| Aider repo-map | one tree-sitter pass | rebuilt from working tree | **~1k tokens, budgeted** | no | weak | **strong** |
| ctags/tree-sitter graph | one scan | regenerate per commit | too large raw; substrate only | no | poor | as lookup/substrate |
| CLAUDE.md-style prose | human hours (or generated + reviewed) | manual; goes stale silently | ~200 lines/file guidance | **yes** | **strong** | strong (intent layer) |
| SCIP / Glean | per-language indexers + serving | incremental, O(changes)–O(fanout) | n/a (query service) | no | indirect | high quality, high infra cost |
| Embedding index | chunk + embed + vector DB | auto-sync (Cursor: 5 min) | proportional to query | weakly (via doc chunks) | good for concept queries | good; probabilistic, infra-heavy |

## Implications for the Fleet

1. **The core bet is genuinely unproven — the prototype (#54) matters.**
   The closest real-world analogue (Honk) runs at scale with *no* repo
   knowledge artifact, by design, for testability. The pro-artifact evidence
   (Cursor's +12.5%, Meta's Glean-RAG) is real but comes from interactive
   IDE-style consumers, not background fleet runs. The prototype should
   measure exactly the gap Honk chose not to close: tokens spent and answer
   quality for a feature-placement question, cold vs. pre-compiled.
2. **No single form serves both consumers.** Structural maps serve agents;
   curated prose serves ideation. The spec (#55) should treat the artifact as
   two fused layers: a deterministic, token-budgeted structural map plus a
   compact generated prose layer (architecture, seams, conventions,
   feature-landing zones), the second being what makes "where would X land?"
   answerable.
3. **The repo-agnostic constraint points at tree-sitter, not indexers.**
   SCIP/Glean-grade precision costs a per-language indexer — incompatible
   with "onboard any local repo." Tree-sitter's breadth (Aider: 130+
   languages via query files) is the proven repo-agnostic substrate; adopt
   aider's shape (definitions + references → ranked graph → token budget)
   rather than a database.
4. **Budget the artifact explicitly.** Aider's `--map-tokens` and Anthropic's
   200-line CLAUDE.md guidance agree from opposite directions: the artifact
   must have a hard token budget, and ranking decides what fits. An unbudgeted
   artifact recreates the cold-exploration cost it was meant to remove.
5. **Freshness should be O(changes) and tied to onboarding, not to humans.**
   Every automated form regenerates mechanically (aider per invocation,
   Cursor per 5 minutes, Glean per change); the only form that rots is the
   hand-curated one. If the fleet generates the prose layer, it must also
   regenerate it (or at minimum staleness-stamp it against the target's HEAD
   SHA) as part of the pre-compile step — feeding grilling ticket #53.
6. **Honk's testability argument deserves an answer in the spec.** Spotify
   rejected dynamic context because it hurts predictability. A *static,
   versioned, per-commit artifact* injected into the task context actually
   satisfies their objection — it is as testable as their static prompts —
   which is a stronger design argument for pre-compilation than raw token
   savings.

## Research Gaps

- No public data on Honk's per-run exploration token spend; the 90%
  time-savings figures are about engineering effort, not tokens.
- Aider publishes no map-vs-no-map quality benchmark; Cursor's 12.5% figure
  is first-party and methodology details are not published.
- Cursor's embedding model and chunking specifics are undisclosed.
- Whether any fleet-style (background, non-interactive) system injects a
  pre-compiled map at dispatch time is unverified — no primary source found
  either way; this strengthens the case for the #54 prototype.

## Sources

Spotify Honk (first-party engineering blog):

- [1,500+ PRs Later: Spotify's Journey with Our Background Coding Agent (Part 1)](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1)
- [Background Coding Agents: Context Engineering (Part 2)](https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2)
- [Background Coding Agents: Feedback Loops (Part 3)](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3)

Aider:

- [Repository map documentation](https://aider.chat/docs/repomap.html)
- [Building a better repository map with tree-sitter](https://aider.chat/2023/10/22/repomap.html)

ctags:

- [Universal Ctags manual](https://docs.ctags.io/en/latest/man/ctags.1.html)

Curated context files:

- [Claude Code: How Claude remembers your project](https://code.claude.com/docs/en/memory)

Code intelligence:

- [SCIP Code Intelligence Protocol (repo)](https://github.com/sourcegraph/scip)
- [Announcing SCIP (Sourcegraph blog)](https://sourcegraph.com/blog/announcing-scip)
- [Glean documentation: Introduction](https://glean.software/docs/introduction/)
- [Indexing code at scale with Glean (Meta engineering)](https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/)

Embedding indexes:

- [Cursor: Semantic & Agentic Search](https://cursor.com/docs/agent/tools/search)

All web sources were accessed on 2026-07-18. Vendor claims (Cursor's accuracy
figure, Spotify's PR counts) are first-party and not independently verified.
