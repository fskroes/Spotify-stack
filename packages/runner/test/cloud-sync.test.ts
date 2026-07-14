import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudArtifactSync, type AsyncGhRunner } from "../src/cloud-sync.js";
import { runArtifactsDir } from "../src/artifacts.js";
import type { LedgerEntry } from "../src/ledger.js";

const tmpDirs: string[] = [];
function tmpRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-cloudsync-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  // temp repos are OS-tmp; leaving them is harmless, but keep it tidy.
  tmpDirs.length = 0;
});

function cloudEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ts: "2026-07-14T10:00:00.000Z",
    task: "004-x",
    repo: "demo-feed-service",
    status: "approved",
    mode: "cloud",
    vetoes: 0,
    runId: "cloud-run-1",
    actionsRunId: "998877",
    actionsArtifact: "004-x-demo-feed-service",
    ...overrides,
  };
}

/** Find the `--dir` value in a `gh run download` argument list. */
function dirArg(args: string[]): string {
  const i = args.indexOf("--dir");
  return args[i + 1];
}

/** A gh runner that "downloads" by writing the given files into --dir. */
function ghWriting(files: Record<string, string>): { gh: AsyncGhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: AsyncGhRunner = async (args) => {
    calls.push(args);
    const dir = dirArg(args);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), content);
    }
    return "";
  };
  return { gh, calls };
}

describe("CloudArtifactSync", () => {
  it("downloads on demand and lands the review set in the per-run archive", async () => {
    const repo = tmpRepo();
    const { gh } = ghWriting({ "diff.patch": "the cloud diff\n", "verdict.json": "{}\n" });
    const sync = new CloudArtifactSync({ controlRepo: repo, gh });

    const state = sync.stateFor(cloudEntry());
    expect(state).toEqual({ kind: "syncing" });
    await sync.drain();

    const archive = runArtifactsDir(repo, "cloud-run-1");
    expect(readFileSync(path.join(archive, "diff.patch"), "utf8")).toBe("the cloud diff\n");
    expect(existsSync(path.join(archive, "verdict.json"))).toBe(true);
  });

  it("passes the run id and artifact name gh needs to target one matrix repo", async () => {
    const { gh, calls } = ghWriting({ "diff.patch": "x\n" });
    const sync = new CloudArtifactSync({ controlRepo: tmpRepo(), gh });
    sync.stateFor(cloudEntry());
    await sync.drain();
    expect(calls[0].slice(0, 5)).toEqual(["run", "download", "998877", "--name", "004-x-demo-feed-service"]);
  });

  it("dedupes concurrent opens into one download", async () => {
    const { gh, calls } = ghWriting({ "diff.patch": "x\n" });
    const sync = new CloudArtifactSync({ controlRepo: tmpRepo(), gh });
    expect(sync.stateFor(cloudEntry())).toEqual({ kind: "syncing" });
    expect(sync.stateFor(cloudEntry())).toEqual({ kind: "syncing" });
    await sync.drain();
    expect(calls).toHaveLength(1);
  });

  it("reports predates-sync for a cloud run missing its artifact reference", () => {
    const { gh } = ghWriting({});
    const sync = new CloudArtifactSync({ controlRepo: tmpRepo(), gh });
    const state = sync.stateFor(cloudEntry({ actionsRunId: undefined, actionsArtifact: undefined }));
    expect(state.kind).toBe("unavailable");
    expect(state).toMatchObject({ reason: expect.stringContaining("predates artifact sync") });
  });

  it("becomes permanently unavailable when the artifact is gone", async () => {
    const gh: AsyncGhRunner = async () => {
      throw new Error("no valid artifacts found to download");
    };
    const sync = new CloudArtifactSync({ controlRepo: tmpRepo(), gh });
    expect(sync.stateFor(cloudEntry())).toEqual({ kind: "syncing" });
    await sync.drain();
    const state = sync.stateFor(cloudEntry());
    expect(state.kind).toBe("unavailable");
    expect(state).toMatchObject({ reason: expect.stringContaining("no longer on GitHub") });
  });

  it("reports no-reviewable-evidence when the artifact is empty", async () => {
    const { gh } = ghWriting({ "transcript.json": "huge\n" }); // not a review artifact
    const sync = new CloudArtifactSync({ controlRepo: tmpRepo(), gh });
    sync.stateFor(cloudEntry());
    await sync.drain();
    const state = sync.stateFor(cloudEntry());
    expect(state).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("no reviewable evidence") });
  });

  it("marks a transient failure retryable, then retries after the cooldown", async () => {
    let attempts = 0;
    const gh: AsyncGhRunner = async (args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("HTTP 503: bad gateway");
      writeFileSync(path.join(dirArg(args), "diff.patch"), "recovered\n");
      return "";
    };
    let clock = 1_000;
    const sync = new CloudArtifactSync({ controlRepo: tmpRepo(), gh, retryAfterMs: 5_000, now: () => clock });

    sync.stateFor(cloudEntry());
    await sync.drain();
    const cooling = sync.stateFor(cloudEntry());
    expect(cooling.kind).toBe("retryable");
    expect(cooling).toMatchObject({ detail: expect.stringContaining("503") });

    clock += 6_000; // past the cooldown
    expect(sync.stateFor(cloudEntry())).toEqual({ kind: "syncing" });
    await sync.drain();
    expect(attempts).toBe(2);
  });

  it("notifies onSettled after a download settles", async () => {
    let settled = 0;
    const { gh } = ghWriting({ "diff.patch": "x\n" });
    const sync = new CloudArtifactSync({ controlRepo: tmpRepo(), gh, onSettled: () => (settled += 1) });
    sync.stateFor(cloudEntry());
    await sync.drain();
    // drain() awaits the download; the finally that fires onSettled is chained
    // after it, so give the microtask queue a turn.
    await Promise.resolve();
    expect(settled).toBe(1);
  });
});
