import { get } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendLedger, type LedgerEntry } from "../src/ledger.js";
import type { GitRunner } from "../src/ledger-union.js";
import type { AsyncGhRunner } from "../src/cloud-sync.js";
import { beginInflight } from "../src/inflight.js";
import { serveLedger, type ServeLedgerHandle } from "../src/ledger-serve.js";

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    ts: new Date().toISOString(),
    task: "004-x",
    repo: "demo-feed-service",
    status: "approved",
    mode: "local",
    vetoes: 0,
    ...overrides,
  };
}

function tmpLedger(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-serve-")), "ledger.jsonl");
}

function tmpControlRepo(): { root: string; ledgerPath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-operator-"));
  const ledgerPath = path.join(root, "fleet", "ledger.jsonl");
  mkdirSync(path.join(root, "fleet"), { recursive: true });
  mkdirSync(path.join(root, "tasks"), { recursive: true });
  writeFileSync(
    path.join(root, "fleet", "repos.yaml"),
    "repos:\n  - name: demo-api\n    language: typescript\n    default_branch: main\n",
  );
  writeFileSync(
    path.join(root, "tasks", "007-api.md"),
    "---\nid: 007-api\ntitle: Add operator API\ntargets: [demo-api]\nrisk: low\n---\nBuild it.\n",
  );
  return { root, ledgerPath };
}

/** Wait for the first `data: reload` frame on the SSE stream, or reject. */
function waitForReload(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = get(`${url}/events`, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        if (buf.includes("data: reload")) {
          req.destroy();
          resolve();
        }
      });
    });
    req.on("error", reject);
    const t = setTimeout(() => {
      req.destroy();
      reject(new Error("timed out waiting for reload event"));
    }, timeoutMs);
    t.unref();
  });
}

/** A git runner that answers `show` with the given ledger lines (the copy the
 *  cloud committed to origin/main) and no-ops `fetch`. */
function gitReturning(entries: LedgerEntry[]): GitRunner {
  const jsonl = entries.map((e) => JSON.stringify(e)).join("\n");
  return (args) => {
    if (args[0] === "fetch") return "";
    if (args[0] === "show") return jsonl;
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

/** Poll `fn` until it returns a defined value, or time out. Used to wait for the
 *  serve's kickoff poll / an async download to land. */
async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface RunDetail {
  run: LedgerEntry;
  artifacts: Array<{ name: string; url: string }>;
  sync?: { kind: string; reason?: string; detail?: string };
}

describe("serveLedger", () => {
  let handle: ServeLedgerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("serves the rendered ledger with the live-reload client", async () => {
    const ledgerPath = tmpLedger();
    appendLedger(ledgerPath, entry({ status: "vetoed", reason: "regenerated the entire lockfile" }));

    handle = await serveLedger({ ledgerPath, port: 0 });
    const res = await fetch(handle.url);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("FLEET LEDGER");
    // A real row from the ledger is rendered...
    expect(html).toContain("regenerated the entire lockfile");
    // ...and the live-reload client is injected.
    expect(html).toContain("new EventSource");
    expect(html).toContain('"/events"');
  });

  it("pushes a reload event when the ledger changes", async () => {
    const ledgerPath = tmpLedger();
    appendLedger(ledgerPath, entry({ status: "approved" }));

    handle = await serveLedger({ ledgerPath, port: 0 });
    const reloaded = waitForReload(handle.url, 3000);
    // Give the SSE stream a moment to attach before mutating the ledger.
    await new Promise((r) => setTimeout(r, 100));
    appendLedger(ledgerPath, entry({ status: "vetoed", reason: "a new kill landed" }));

    await expect(reloaded).resolves.toBeUndefined();
  });

  it("renders the Live lane from the in-flight store", async () => {
    const ledgerPath = tmpLedger();
    const claim = beginInflight({
      ledgerPath,
      runId: "run-live",
      startedAt: new Date(),
      task: "002-dedupe-feed-items",
      repo: "demo-feed-service",
      title: "Dedupe feed items on ingest",
      log: () => {},
    });
    claim.enter("verify");

    handle = await serveLedger({ ledgerPath, port: 0 });
    const html = await (await fetch(handle.url)).text();
    claim.clear();

    expect(html).toContain("In flight · 1");
    expect(html).toContain("Dedupe feed items on ingest");
  });

  it("serves ledger, in-flight, run-detail, and catalog JSON", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    appendLedger(ledgerPath, entry({
      runId: "run-complete",
      task: "007-api",
      repo: "demo-api",
      title: "Add operator API",
    }));
    const live = beginInflight({
      ledgerPath,
      runId: "run-live",
      startedAt: new Date(),
      task: "007-api",
      repo: "demo-api",
      title: "Add operator API",
      log: () => {},
    });

    handle = await serveLedger({ ledgerPath, controlRepo: root, port: 0 });
    const [ledgerRes, inflightRes, runRes, catalogRes] = await Promise.all([
      fetch(`${handle.url}/api/ledger`),
      fetch(`${handle.url}/api/inflight`),
      fetch(`${handle.url}/api/runs/run-complete`),
      fetch(`${handle.url}/api/catalog`),
    ]);
    live.clear();

    expect(ledgerRes.status).toBe(200);
    expect((await ledgerRes.json() as { entries: LedgerEntry[] }).entries[0].runId).toBe("run-complete");
    expect((await inflightRes.json() as { runs: Array<{ runId: string }> }).runs[0].runId).toBe("run-live");
    expect(await runRes.json()).toMatchObject({ state: "completed", run: { runId: "run-complete" } });
    expect(await catalogRes.json()).toMatchObject({
      tasks: [{ id: "007-api", title: "Add operator API" }],
      repos: [{ name: "demo-api", language: "typescript", defaultBranch: "main" }],
    });
  });

  it("serves live co-sign state on ledger and run-detail JSON as soon as polling starts", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    const prUrl = "https://github.com/o/demo-api/pull/7";
    appendLedger(ledgerPath, entry({ runId: "run-complete", task: "007-api", repo: "demo-api", prUrl }));

    handle = await serveLedger({
      ledgerPath,
      controlRepo: root,
      port: 0,
      // Long cadence: only the immediate startup fetch can supply the state below.
      cosignPollMs: 60_000,
      fetchCosigns: () => ({ [prUrl]: { state: "merged", mergedBy: "fernando", mergedAt: "2026-07-13T10:00:00Z" } }),
    });

    // The startup fetch is async; give it a beat without waiting a poll tick.
    let ledgerBody: { cosigns?: Record<string, { state: string; mergedBy?: string }> } = {};
    for (let i = 0; i < 20; i++) {
      ledgerBody = await (await fetch(`${handle.url}/api/ledger`)).json() as typeof ledgerBody;
      if (ledgerBody.cosigns && Object.keys(ledgerBody.cosigns).length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(ledgerBody.cosigns).toEqual({
      [prUrl]: { state: "merged", mergedBy: "fernando", mergedAt: "2026-07-13T10:00:00Z" },
    });

    const runBody = await (await fetch(`${handle.url}/api/runs/run-complete`)).json();
    expect(runBody).toMatchObject({
      state: "completed",
      cosign: { state: "merged", mergedBy: "fernando" },
    });
  });

  it("omits co-sign state from the API when polling is off", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    appendLedger(ledgerPath, entry({ runId: "run-complete", task: "007-api", repo: "demo-api", prUrl: "https://github.com/o/demo-api/pull/7" }));

    handle = await serveLedger({ ledgerPath, controlRepo: root, port: 0 });
    const ledgerBody = await (await fetch(`${handle.url}/api/ledger`)).json() as Record<string, unknown>;
    const runBody = await (await fetch(`${handle.url}/api/runs/run-complete`)).json() as Record<string, unknown>;

    expect("cosigns" in ledgerBody).toBe(false);
    expect("cosign" in runBody).toBe(false);
  });

  it("pushes a reload event when polled co-sign state changes", async () => {
    const ledgerPath = tmpLedger();
    const prUrl = "https://github.com/o/demo-api/pull/7";
    appendLedger(ledgerPath, entry({ runId: "run-complete", prUrl }));

    let calls = 0;
    handle = await serveLedger({
      ledgerPath,
      port: 0,
      cosignPollMs: 100,
      // Empty at startup; the state lands on a later poll tick.
      fetchCosigns: (): Record<string, { state: "merged" }> => (++calls < 2 ? {} : { [prUrl]: { state: "merged" } }),
    });

    await expect(waitForReload(handle.url, 3000)).resolves.toBeUndefined();
  });

  it("serves only allowlisted artifacts and returns their metadata", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    const dir = path.join(root, "artifacts", "007-api", "demo-api");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "diff.patch"), "diff --git a/a b/a\n");
    writeFileSync(path.join(dir, "transcript.json"), "secret\n");

    handle = await serveLedger({ ledgerPath, controlRepo: root, port: 0 });
    const metadata = await fetch(`${handle.url}/api/artifacts/007-api/demo-api`);
    const body = await metadata.json() as { artifacts: Array<{ name: string; url: string }> };
    const artifact = await fetch(`${handle.url}${body.artifacts[0].url}`);
    const blocked = await fetch(`${handle.url}/api/artifacts/007-api/demo-api/transcript.json`);

    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].name).toBe("diff.patch");
    expect(artifact.headers.get("content-type")).toContain("text/x-diff");
    expect(await artifact.text()).toContain("diff --git");
    expect(blocked.status).toBe(404);
  });

  it("never attaches latest-run artifacts to an older run — and says the older evidence was superseded", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    const older = entry({
      ts: new Date(Date.now() - 60_000).toISOString(),
      runId: "run-older",
      task: "007-api",
      repo: "demo-api",
    });
    const latest = entry({ runId: "run-latest", task: "007-api", repo: "demo-api" });
    appendLedger(ledgerPath, older);
    appendLedger(ledgerPath, latest);
    const dir = path.join(root, "artifacts", "007-api", "demo-api");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "diff.patch"), "latest run only\n");

    handle = await serveLedger({ ledgerPath, controlRepo: root, port: 0 });
    const olderDetail = await (await fetch(`${handle.url}/api/runs/run-older`)).json();
    const latestDetail = await (await fetch(`${handle.url}/api/runs/run-latest`)).json();

    expect(olderDetail).toMatchObject({ artifacts: [], artifactsSuperseded: true });
    expect(latestDetail).toMatchObject({ artifacts: [{ name: "diff.patch" }] });
    expect("artifactsSuperseded" in (latestDetail as Record<string, unknown>)).toBe(false);
  });

  it("serves the per-run archive to its exact run even after a newer run replaces the shared set", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    appendLedger(ledgerPath, entry({
      ts: new Date(Date.now() - 60_000).toISOString(),
      runId: "run-older",
      task: "007-api",
      repo: "demo-api",
    }));
    appendLedger(ledgerPath, entry({ runId: "run-latest", task: "007-api", repo: "demo-api" }));
    const flat = path.join(root, "artifacts", "007-api", "demo-api");
    mkdirSync(flat, { recursive: true });
    writeFileSync(path.join(flat, "diff.patch"), "latest run only\n");
    const archive = path.join(root, "artifacts", "runs", "run-older");
    mkdirSync(archive, { recursive: true });
    writeFileSync(path.join(archive, "diff.patch"), "older run archived\n");

    handle = await serveLedger({ ledgerPath, controlRepo: root, port: 0 });
    const olderDetail = await (await fetch(`${handle.url}/api/runs/run-older`)).json() as {
      artifacts: Array<{ name: string; url: string }>;
    };
    const served = await fetch(`${handle.url}${olderDetail.artifacts[0].url}`);

    expect(olderDetail.artifacts).toHaveLength(1);
    expect(olderDetail.artifacts[0].url).toBe("/api/artifacts/runs/run-older/diff.patch");
    expect("artifactsSuperseded" in (olderDetail as unknown as Record<string, unknown>)).toBe(false);
    expect(await served.text()).toBe("older run archived\n");
  });

  it("does not claim superseded artifacts for cloud runs — they never had local evidence", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    appendLedger(ledgerPath, entry({
      ts: new Date(Date.now() - 60_000).toISOString(),
      runId: "run-cloud",
      task: "007-api",
      repo: "demo-api",
      mode: "cloud",
    }));
    appendLedger(ledgerPath, entry({ runId: "run-latest", task: "007-api", repo: "demo-api" }));

    handle = await serveLedger({ ledgerPath, controlRepo: root, port: 0 });
    const detail = await (await fetch(`${handle.url}/api/runs/run-cloud`)).json();

    expect(detail).toMatchObject({ artifacts: [] });
    expect("artifactsSuperseded" in (detail as Record<string, unknown>)).toBe(false);
  });

  it("does not attach in-flight artifacts to the previous completed run", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    appendLedger(ledgerPath, entry({ runId: "run-complete", task: "007-api", repo: "demo-api" }));
    const live = beginInflight({
      ledgerPath,
      runId: "run-new",
      startedAt: new Date(),
      task: "007-api",
      repo: "demo-api",
      title: "Add operator API",
      log: () => {},
    });
    const dir = path.join(root, "artifacts", "007-api", "demo-api");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "diff.patch"), "new run partial artifact\n");

    handle = await serveLedger({ ledgerPath, controlRepo: root, port: 0 });
    const detail = await fetch(`${handle.url}/api/runs/run-complete`);
    live.clear();

    expect(await detail.json()).toMatchObject({ artifacts: [] });
  });

  it("rejects traversal and symlink escapes from the artifact root", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    const dir = path.join(root, "artifacts", "007-api", "demo-api");
    mkdirSync(dir, { recursive: true });
    const outside = path.join(root, "outside.patch");
    writeFileSync(outside, "private\n");
    symlinkSync(outside, path.join(dir, "diff.patch"));

    handle = await serveLedger({ ledgerPath, controlRepo: root, port: 0 });
    const traversal = await fetch(`${handle.url}/api/artifacts/..%2Foutside/demo-api/diff.patch`);
    const symlink = await fetch(`${handle.url}/api/artifacts/007-api/demo-api/diff.patch`);

    expect(traversal.status).toBe(400);
    expect(symlink.status).toBe(404);
  });

  it("returns JSON 404s for missing runs and artifact sets", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    handle = await serveLedger({ ledgerPath, controlRepo: root, port: 0 });

    const missingRun = await fetch(`${handle.url}/api/runs/not-here`);
    const missingArtifacts = await fetch(`${handle.url}/api/artifacts/no-task/no-repo`);

    expect(missingRun.status).toBe(404);
    expect(await missingRun.json()).toEqual({ error: "run not found" });
    expect(missingArtifacts.status).toBe(404);
    expect(await missingArtifacts.json()).toEqual({ error: "artifact set not found" });
  });

  it("pushes a reload event when a run changes stage", async () => {
    const ledgerPath = tmpLedger();
    // `fs.watch` is non-recursive, so this only fires if the server watches
    // `inflight/` itself and not just the ledger's directory.
    const claim = beginInflight({
      ledgerPath,
      runId: "run-live",
      startedAt: new Date(),
      task: "002-dedupe-feed-items",
      repo: "demo-feed-service",
      title: "Dedupe feed items on ingest",
      log: () => {},
    });

    handle = await serveLedger({ ledgerPath, port: 0 });
    const reloaded = waitForReload(handle.url, 3000);
    await new Promise((r) => setTimeout(r, 100));
    claim.enter("judge");

    await expect(reloaded).resolves.toBeUndefined();
    claim.clear();
  });

  const cloudEntry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry =>
    entry({
      runId: "cloud-1",
      task: "007-api",
      repo: "demo-api",
      mode: "cloud",
      actionsRunId: "555",
      actionsArtifact: "007-api-demo-api",
      ...overrides,
    });

  it("brings cloud runs into the ledger view via origin/main (union read)", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    appendLedger(ledgerPath, entry({ runId: "local-1", task: "007-api", repo: "demo-api" }));
    // The cloud run's line lives only on origin/main, never in the local file.
    handle = await serveLedger({ ledgerPath, controlRepo: root, port: 0, git: gitReturning([cloudEntry()]) });

    const body = await waitFor(async () => {
      const b = (await (await fetch(`${handle!.url}/api/ledger`)).json()) as { entries: LedgerEntry[] };
      return b.entries.some((e) => e.runId === "cloud-1") ? b : undefined;
    });
    expect(body.entries.map((e) => e.runId).sort()).toEqual(["cloud-1", "local-1"]);
  });

  it("syncs a cloud run's evidence on demand: syncing, then the downloaded diff", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    const downloadGh: AsyncGhRunner = async (args) => {
      const dir = args[args.indexOf("--dir") + 1];
      writeFileSync(path.join(dir, "diff.patch"), "the cloud diff\n");
      return "";
    };
    handle = await serveLedger({
      ledgerPath,
      controlRepo: root,
      port: 0,
      git: gitReturning([cloudEntry()]),
      downloadGh,
    });

    // Once the run is visible, the first Review open reports syncing and kicks
    // the download.
    const first = await waitFor(async () => {
      const d = (await (await fetch(`${handle!.url}/api/runs/cloud-1`)).json()) as RunDetail;
      return d.run?.runId === "cloud-1" ? d : undefined;
    });
    expect(first.sync).toEqual({ kind: "syncing" });

    // The download lands in the per-run archive; a re-open serves the diff.
    const detail = await waitFor(async () => {
      const d = (await (await fetch(`${handle!.url}/api/runs/cloud-1`)).json()) as RunDetail;
      return d.artifacts.length > 0 ? d : undefined;
    });
    expect(detail.artifacts.map((a) => a.name)).toContain("diff.patch");
    expect(detail.sync).toBeUndefined();
    const served = await fetch(`${handle.url}${detail.artifacts[0].url}`);
    expect(await served.text()).toBe("the cloud diff\n");
  });

  it("names a gone cloud artifact as permanently unavailable", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    const downloadGh: AsyncGhRunner = async () => {
      throw new Error("no valid artifacts found to download");
    };
    handle = await serveLedger({
      ledgerPath,
      controlRepo: root,
      port: 0,
      git: gitReturning([cloudEntry()]),
      downloadGh,
    });

    const detail = await waitFor(async () => {
      const d = (await (await fetch(`${handle!.url}/api/runs/cloud-1`)).json()) as RunDetail;
      return d.sync?.kind === "unavailable" ? d : undefined;
    });
    expect(detail.artifacts).toEqual([]);
    expect(detail.sync?.reason).toContain("no longer on GitHub");
  });

  it("reports cloud evidence unavailable when the server can't download it", async () => {
    const { root, ledgerPath } = tmpControlRepo();
    // git (union) but no downloadGh: the run is visible, evidence is not fetchable here.
    handle = await serveLedger({ ledgerPath, controlRepo: root, port: 0, git: gitReturning([cloudEntry()]) });

    const detail = await waitFor(async () => {
      const d = (await (await fetch(`${handle!.url}/api/runs/cloud-1`)).json()) as RunDetail;
      return d.run?.runId === "cloud-1" ? d : undefined;
    });
    expect(detail.sync).toMatchObject({ kind: "unavailable" });
    expect(detail.sync?.reason).toContain("not enabled");
  });

  it("closes cleanly", async () => {
    const ledgerPath = tmpLedger();
    handle = await serveLedger({ ledgerPath, port: 0 });
    await expect(handle.close()).resolves.toBeUndefined();
    handle = undefined; // already closed; don't double-close in afterEach
  });
});
