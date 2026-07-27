# demo-feed-service — Tier 0 ask-path smoke (public, committable)

Executes **Tier 0** of [`docs/experiments/knowledge-ask-usage-pass.md`](../docs/experiments/knowledge-ask-usage-pass.md)
§3 — the mechanical harden-the-seam rung, primed only, on the public
`demo-feed-service` target. First public evidence the shipped `fleet ask` seam
(`packages/cli/src/index.ts:209-242` → `packages/knowledge/src/ask.ts`) runs
end-to-end. **Not** a reader-rubric read (§12 / Tier 1) — this is the shaped-right
+ telemetry + regression check only.

- **Run date:** 2026-07-27, LOCAL (subscription, not API credits).
- **Compile:** `pnpm fleet knowledge compile demo-feed-service` — ~90s wall, fresh
  artifact at repo SHA `5944f59`, structural grounding **0.289** (13/45 refs;
  behavioral prose not verified by this ratio). Overwrote a prior untracked
  artifact (was compiled @ `c3fdede4`, 0.327).
- **Arms:** primed only (no cold arm — that is Tier 2). Model pairing held at the
  #54 constant: compile on opus, asks on sonnet.
- **Mid-pass fix:** the first P/W run exposed a stub bug (below); it was hardened
  at source in `buildAskPrompt` and **P/W were re-run** on the same artifact (no
  recompile — only the prompt changed). Both runs are recorded.

## Instantiation (public target — committable)

The anti-recitation absent-capability design (§11) instantiated for this target:

- **`{{NEW_CAPABILITY}}`** — a `?limit=N` query parameter on `/feed` capping how
  many items the returned Atom document contains. Grep-confirmed absent; `/feed`
  always returns the full resolved item set today. Small (one parse + one slice),
  single-seam (the `/feed` handler in `server.js`).
- **`{{EXISTING_PATHWAY}}`** — the existing `source` query-parameter pipeline: how
  `source` is read off the request URL and threaded `fetchFeed → resolveItems →
  buildFeed`. The direct analog of the new param, chosen to force *selection* of a
  real pathway with depth (fetchFeed's stale-source fallback-to-default;
  resolveItems' positional best-effort enrichment).
- **`{{USER_STORY}}`** — "As a reader on a slow connection, I want to request
  `/feed?limit=10` so I receive only the 10 most recent items instead of the
  entire feed."

The three verbatim questions are in [Appendix A](#appendix-a--verbatim-questions).

## Telemetry (read top-down per §4 — dead-ends & wall clock first, tokens last)

| Class | Dead-ends (mechanical) | Wall clock | Grounded ratio | Output tok | Total tok |
|---|---|---|---|---|---|
| **P** placement — *pre-fix (stub)* | 1 — `ExitPlanMode` | 84.4s | 0.000 (0/1) | 5,246 | 154,264 |
| **P** placement — *post-fix (real)* | 10 (mostly real refs) | **48.5s** | 0.375 (6/16) | 2,901 | 49,737 |
| **W** wiring — *pre-fix (stub)* | 1 — `ExitPlanMode` | 78.6s | 0.000 (0/1) | 5,639 | 156,163 |
| **W** wiring — *post-fix (real)* | 18 (mostly real refs) | **37.4s** | 0.250 (6/24) | 2,380 | 49,245 |
| **S** story→brief | 7 (mostly real refs) | 58.3s | 0.417 (5/12) | 3,765 | 50,433 |

All inside the #52 "time-to-oriented ≤ 2 minutes" projection. The **pre-fix P/W
rows do not mean what the columns say** (they scored a stub — see the finding);
they are kept only to show the before/after. The **post-fix** P/W runs are the
real Tier 0 result: both returned full inline answers, and both got *faster and
cheaper* than the stub (P 84.4s→48.5s / 154k→50k tok; W 78.6s→37.4s / 156k→49k
tok) — the stub runs were more expensive because the agent wandered into
plan-mode/file-writing behavior before returning its epilogue.

The mechanical dead-end counts on the post-fix P/W (10, 18) and on S (7) are
inflated by the checker's lenience (§6 threat #2): they are dominated by **real**
symbols the checker false-flags — e.g. `server.js`, `upstream.js`, `config.js`,
`args.js`, `cli.js`, `DEFAULT_SOURCE`, `UPSTREAM_EMPTY`, `row.enriched` — plus a
few tokens echoed from the question itself (`limit`, `N`, `items`). All three
answers carry line-numbered references to real code; true reader-facing dead-ends
are near zero. Read these ratios as loose lower bounds, never as precision.

The grounded checker's lenience (§6 threat #2) is visible in **S**: of its 7
mechanical "dead-ends" — `server.js`, `source`, `DEFAULT_SOURCE`, `row.enriched`,
`config.js`, `UPSTREAM_EMPTY`, `upstream.js` — every one is a **real** file or
symbol in the target. The checker under-counts these as unresolved. S's *true*
reader-facing dead-end count is ≈0; the brief is well-grounded. Read S's 0.417 as
a lower bound, not a precision number.

## Headline finding — P/W returned a stub, not the answer (found → fixed → re-verified)

**Status: fixed at source and re-verified in this same pass.** The pre-fix
behavior is documented below; the fix and its confirmation follow.

`fleet ask` captures the CLI envelope's final `result` string and grounds *that*.
For **placement** and **wiring**, that final string was a **closing epilogue**, not
the deliverable:

- **P** result, in full: *"The placement answer above is the deliverable … The
  answer and the written brief stand complete."*
- **W** result, in full: *"The trace above is the complete answer — I've also
  recorded it to the plan file … this was a wiring question, the deliverable is the
  ordered trace."*

The actual placement brief / wiring trace was composed **mid-turn** ("above", "the
plan file") and never landed in the returned result. Confirmed:

1. The returned text carries **zero repo references** — the only symbol either
   answer names is `ExitPlanMode` (a Claude Code tool, absent in this context),
   which is why both score 0.000 grounding on a single reference. The scorer
   measured an epilogue.
2. The "written brief" / "plan file" they defer to **does not exist** — no file was
   written under `demo-repos/demo-feed-service/` (checked; tree unchanged). The
   content is simply lost.
3. P and W burned **~154–156k total tokens** to return a ~5k-token stub — the agent
   did the exploration, it just didn't return it.

**Root cause** (`packages/knowledge/src/ask.ts:16` `buildAskPrompt`): the prompt
tells the agent to "serve whichever class the question calls for" and gives
grounding discipline, but **never states that its final reply *is* the answer** —
no "return the full answer inline as your final message; do not defer to a file or
reach for a plan tool." Running as an ordinary coding turn in the target repo, the
agent treats the ask like a plan-and-exit task (reaches for `ExitPlanMode`, invents
a "plan file") and its `result` becomes a meta-remark.

**S escaped only by its question text.** The S template ends with "Return the brief
inline in this reply — never defer it to a file" — and S alone returned its full
substance inline. The `{{NEW_CAPABILITY}}` anti-recitation design worked (the brief
is synthesised, not recited), but the inline-return guarantee for S lived in the
**per-question template**, not in `buildAskPrompt`. P and W had no such clause, so
the very defer-to-file failure mode §2-row-5 was built to guard was live for the
two classes whose templates don't carry the instruction.

### The fix

Added an **Output contract** block to `buildAskPrompt`
(`packages/knowledge/src/ask.ts:16`), applied to every class, stating: the reply
*is* the answer and must be written inline; do not defer any part to a file or a
"plan file"; do not reach for a plan/hand-off tool (`ExitPlanMode`) or close with a
meta-remark that the answer is "above." Locked with a `buildAskPrompt` test
(`packages/knowledge/test/ask.test.ts`) asserting the block is present. Full
knowledge suite green (54 tests) + CLI ask suite green (3 tests).

### Re-verification (post-fix P/W rows above)

Both P and W, re-run on the **same artifact** (only the prompt changed), returned
full inline answers with zero stub behavior:

- **P** — an ordered placement answer: `server.js` handler (extend, `server.js:9`)
  → `config.js` optional bound → *skip* `feed.js` (pure-builder contract) →
  `args.js`+`cli.js` optional CLI parity → `tests/` new test as the verify gate,
  each labeled existing-seam-vs-new, with the correct "slice between `fetchFeed`
  and `resolveItems`" placement call.
- **W** — an ordered `source`-pathway trace: `GET /feed` trigger → query-string
  read with `DEFAULT_SOURCE` fallback → `fetchFeed(apiKey, source)` handoff →
  the `UPSTREAM_4XX`→default stale-source retry → `requireResults` /
  `UPSTREAM_EMPTY` → onward to `resolveItems`/`buildFeed`.

`ExitPlanMode` no longer appears in either answer; grounding is now scored against
real answers, not epilogues. The row-5 failure mode is closed for all three
classes at the prompt level, not just for S at the template level.

## §2 row-5 regression verdict

**HOLDS (for S).** The story→brief answer returned a complete dispatch-ready brief
**inline** — Summary, Files & seams (`server.js` handler; a new pure `src/lib`
helper; `tests/*.test.js`), Approach in pipeline order (slice between `fetchFeed`
and `resolveItems`, with the correct index-alignment rationale for `resolveItems`),
Constraints (backward-compatible default, the silent-fallback convention, the
"never manufacture an empty feed" `UPSTREAM_EMPTY` guard), and a Verify gate
(`npm test` → `node --test`, with the specific cases to add). It even flagged an
honest grounding gap ("10 most recent" ordering is not established by either
layer). It **never deferred to a file**. Row 5's fix is confirmed at the point it
was actually applied — the S template.

## Go / no-go read

- **Compile → ask → telemetry all print:** yes (drift banner, dead-ends, wall
  clock, grounded ratio, token report all rendered for every class).
- **Three classes each return "something shaped right":** **now yes** — S did from
  the start; P and W did after the `buildAskPrompt` fix. The stub bug this rung
  surfaced ("where does it break on questions no one hand-picked", §1 job 1) is
  fixed at source and re-verified in the same pass.
- **Verdict: PASS (post-fix).** The shipped seam compiles → asks → prints
  telemetry, all three classes return grounded inline answers, and the §2-row-5
  regression holds for every class at the prompt level. The de-risking Tier 0
  exists to do is done: a real build bug (inline-return not guaranteed for P/W) was
  caught before any Stage 6 or Tier 1 work and closed. **Tier 1 may proceed** on
  the hardened seam.

## Appendix A — verbatim questions

**P — placement**
> A ?limit=N query parameter on the /feed endpoint — capping how many items the
> returned feed contains — is not in this target yet. Where would it land? Name the
> files and seams a change would touch to add it, in the order you'd open them, and
> say for each whether it is an existing seam to extend or new code. Do not
> implement it — just place it.

**W — wiring**
> A ?limit=N query parameter on /feed would depend on the request-to-feed pipeline
> for the existing source query parameter — how a query parameter is read from the
> request URL and threaded through to the built feed — which this target already
> has. Trace how the source parameter works today, through the code, in the order
> things happen: what triggers it, what it calls, where state changes, where it
> ends. Describe only the existing pathway — the feature is not built.

**S — story → dispatch-ready brief**
> Here is a story for this target: "As a reader on a slow connection, I want to
> request /feed?limit=10 so I receive only the 10 most recent items instead of the
> entire feed." (it describes a ?limit=N query parameter on /feed, which the target
> does not have). Produce a dispatch-ready brief a fleet task could act on
> directly: the files and seams to touch, the approach, the constraints to respect,
> and the verify gate the change must satisfy. Return the brief inline in this
> reply — never defer it to a file.
