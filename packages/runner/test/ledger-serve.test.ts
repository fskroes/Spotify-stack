import { get } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendLedger, type LedgerEntry } from "../src/ledger.js";
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

  it("never attaches latest-run artifacts to an older run with the same task and repo", async () => {
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
    const olderDetail = await fetch(`${handle.url}/api/runs/run-older`);
    const latestDetail = await fetch(`${handle.url}/api/runs/run-latest`);

    expect(await olderDetail.json()).toMatchObject({ artifacts: [] });
    expect(await latestDetail.json()).toMatchObject({ artifacts: [{ name: "diff.patch" }] });
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

  it("closes cleanly", async () => {
    const ledgerPath = tmpLedger();
    handle = await serveLedger({ ledgerPath, port: 0 });
    await expect(handle.close()).resolves.toBeUndefined();
    handle = undefined; // already closed; don't double-close in afterEach
  });
});
