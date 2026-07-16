/**
 * The dev-preview fixtures (`?preview`) — the stand-in ledger, catalog, live
 * run, co-sign map, artifacts, and evidence-sync states the shell renders with
 * no runner attached.
 *
 * Each fixture `satisfies` its contract type, so the preview is held to the
 * exact wire shapes a real runner speaks: a field the contract adds (an
 * in-flight record's `v`/`pid`, say) fails the build here too, and the preview
 * can never drift into rendering a shape production never sends.
 */
import type {
  ArtifactMetadata,
  CatalogResponse,
  InflightRecord,
  LedgerEntry,
  PrLiveState,
  SyncState,
} from "@fleet/contract";

export const PREVIEW_PATCH = [
  "diff --git a/src/lib/feed.js b/src/lib/feed.js",
  "index 2f1c4aa..9be01c3 100644",
  "--- a/src/lib/feed.js",
  "+++ b/src/lib/feed.js",
  "@@ -12,7 +12,8 @@ export function buildFeed(source) {",
  "   const entries = source.items",
  "-    .map((item) => renderEntry(item));",
  "+    .filter((item) => item.id)",
  "+    .map((item) => renderEntry(item));",
  "   return wrap(entries);",
  " }",
  "diff --git a/tests/feed.test.js b/tests/feed.test.js",
  "new file mode 100644",
  "index 0000000..fd87402",
  "--- /dev/null",
  "+++ b/tests/feed.test.js",
  "@@ -0,0 +1,4 @@",
  '+import test from "node:test";',
  "+",
  '+test("buildFeed skips items without an id", () => {',
  "+});",
].join("\n");

export const PREVIEW_CATALOG = {
  tasks: [
    { id: "004-upstream-failure-mode-tests", title: "Cover upstream failure modes", targets: ["demo-feed-service"], risk: "low" },
    { id: "onramp-1-feed-tests", title: "Add feed builder tests", targets: ["demo-feed-service"], risk: "low" },
  ],
  repos: [
    { name: "demo-feed-service", language: "javascript", defaultBranch: "main" },
    { name: "demo-ts-service", language: "typescript", defaultBranch: "main" },
  ],
} satisfies CatalogResponse;

export function previewLedgerEntries(now: number): LedgerEntry[] {
  return [
    { ts: new Date(now - 12 * 60_000).toISOString(), runId: "approved", task: "004-upstream-failure-mode-tests", repo: "demo-feed-service", status: "approved", mode: "cloud", vetoes: 0, title: "Cover upstream failure modes", elapsedMs: 186_421, prUrl: "https://github.com/example/repo/pull/42", sha: "8df31c2", evidence: ["Scope contract passed for 4 changed files", "VERIFY PASSED", "npm run test passed (42 tests)", "Judge approved with no violations"] },
    { ts: new Date(now - 9 * 60_000).toISOString(), runId: "cloud-syncing", task: "004-upstream-failure-mode-tests", repo: "demo-feed-service", status: "approved", mode: "cloud", vetoes: 0, title: "Guard empty upstream payloads", elapsedMs: 158_004, prUrl: "https://github.com/example/repo/pull/50", sha: "a10f4c9", evidence: ["Scope contract passed for 3 changed files", "VERIFY PASSED", "Judge approved with no violations"] },
    { ts: new Date(now - 33 * 60_000).toISOString(), runId: "cloud-gone", task: "002-dedupe-feed-items", repo: "demo-feed-service", status: "approved", mode: "cloud", vetoes: 0, title: "Dedupe feed items on ingest", elapsedMs: 201_887, prUrl: "https://github.com/example/repo/pull/51", sha: "c74be02", evidence: ["Scope contract passed", "VERIFY PASSED", "Judge approved with no violations"] },
    { ts: new Date(now - 51 * 60_000).toISOString(), runId: "cloud-retry", task: "003-add-agent-badge", repo: "demo-ts-service", status: "approved", mode: "cloud", vetoes: 0, title: "Add agent badge", elapsedMs: 96_512, prUrl: "https://github.com/example/repo/pull/52", sha: "e0b91d4", evidence: ["Scope contract passed", "VERIFY PASSED", "Judge approved with no violations"] },
    { ts: new Date(now - 25 * 60_000).toISOString(), runId: "review-me", task: "onramp-1-feed-tests", repo: "demo-feed-service", status: "approved", mode: "local", vetoes: 0, title: "Harden feed pagination", elapsedMs: 141_380, prUrl: "https://github.com/example/repo/pull/44", sha: "3e91d0a", evidence: ["Scope contract passed for 2 changed files", "VERIFY PASSED", "npm run test passed (17 tests)", "Judge approved with no violations"] },
    { ts: new Date(now - 2 * 3_600_000).toISOString(), runId: "shipped", task: "onramp-1-feed-tests", repo: "demo-feed-service", status: "approved", mode: "local", vetoes: 0, title: "Add feed builder tests", elapsedMs: 121_204, prUrl: "https://github.com/example/repo/pull/38", sha: "1fa9b04", evidence: ["Scope contract passed", "VERIFY PASSED", "Judge approved with no violations"] },
    { ts: new Date(now - 47 * 60_000).toISOString(), runId: "failed", task: "onramp-1-feed-tests", repo: "demo-feed-service", status: "verify-failed", mode: "local", vetoes: 0, title: "Add feed builder tests", elapsedMs: 74_902, reason: "npm run test failed: expected 3 items, received 4", evidence: ["Scope contract passed", "VERIFY FAILED", "expected 3 items, received 4"] },
    { ts: new Date(now - 3 * 3_600_000).toISOString(), runId: "rejected", task: "004-upstream-failure-mode-tests", repo: "demo-feed-service", status: "approved", mode: "local", vetoes: 0, title: "Cover upstream failure modes", elapsedMs: 156_733, prUrl: "https://github.com/example/repo/pull/40", sha: "b7e22d1", evidence: ["Scope contract passed", "VERIFY PASSED", "Judge approved with no violations"] },
    { ts: new Date(now - 4 * 3_600_000).toISOString(), runId: "noop", task: "003-add-agent-badge", repo: "demo-ts-service", status: "no-changes", mode: "cloud", vetoes: 0, title: "Add agent badge", elapsedMs: 23_511, evidence: ["Task precondition is already satisfied", "NO_CHANGES_NEEDED"] },
    { ts: new Date(now - 26 * 3_600_000).toISOString(), runId: "vetoed", task: "002-dedupe-feed-items", repo: "demo-feed-service", status: "vetoed", mode: "cloud", vetoes: 3, title: "Dedupe feed items on ingest", elapsedMs: 224_007, reason: "Change regenerated the entire lockfile", evidence: ["Scope contract passed", "VERIFY PASSED", "Judge veto: regenerated the entire lockfile"] },
  ] satisfies LedgerEntry[];
}

export function previewInflight(now: number): InflightRecord {
  return {
    v: 1,
    runId: "live",
    pid: 40_412,
    startedAt: new Date(now - 6 * 60_000).toISOString(),
    task: "004-upstream-failure-mode-tests",
    repo: "demo-ts-service",
    title: "Cover upstream failure modes",
    stage: "verify",
    attempt: 1,
    stageSince: new Date(now - 70_000).toISOString(),
  } satisfies InflightRecord;
}

export function previewCosigns(now: number): Record<string, PrLiveState> {
  return {
    "https://github.com/example/repo/pull/42": { state: "open" },
    // Cloud runs whose evidence is still syncing / gone / retrying — open PRs,
    // but the "no synced evidence, no button" invariant governs the rail.
    "https://github.com/example/repo/pull/50": { state: "open" },
    "https://github.com/example/repo/pull/51": { state: "open" },
    "https://github.com/example/repo/pull/52": { state: "open" },
    "https://github.com/example/repo/pull/44": { state: "open" },
    "https://github.com/example/repo/pull/38": { state: "merged", mergedBy: "fernando", mergedAt: new Date(now - 90 * 60_000).toISOString() },
    // A closed run: exercises the "Run again" prefill path in the preview.
    "https://github.com/example/repo/pull/40": { state: "closed" },
  } satisfies Record<string, PrLiveState>;
}

/** The cloud runs that stand in for each evidence-sync state, keyed by runId, so
 *  the dev preview exercises the syncing/unavailable/retryable rail and Review
 *  copy. A cloud run not listed here is "synced" — it shows the diff and the
 *  co-sign buttons exactly like a local run. */
export const PREVIEW_SYNC_STATES: Record<string, SyncState> = {
  "cloud-syncing": { kind: "syncing" },
  "cloud-gone": { kind: "unavailable", reason: "the run's artifact is no longer on GitHub (expired past retention, or never uploaded)" },
  "cloud-retry": { kind: "retryable", detail: "artifact download failed: gh: server error (HTTP 500)" },
};

export function previewArtifacts(): ArtifactMetadata[] {
  const stamp = new Date().toISOString();
  return [
    { name: "diff.patch", size: 8421, modifiedAt: stamp, url: "/api/artifacts/x/y/diff.patch", contentType: "text/x-diff" },
    { name: "verify.log", size: 1632, modifiedAt: stamp, url: "/api/artifacts/x/y/verify.log", contentType: "text/plain" },
    { name: "verdict.json", size: 421, modifiedAt: stamp, url: "/api/artifacts/x/y/verdict.json", contentType: "application/json" },
    { name: "pr-preview.md", size: 2104, modifiedAt: stamp, url: "/api/artifacts/x/y/pr-preview.md", contentType: "text/markdown" },
  ] satisfies ArtifactMetadata[];
}
