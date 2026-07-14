import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendLedger, type LedgerEntry } from "../src/ledger.js";
import {
  readRemoteLedger,
  readUnionLedger,
  unionLedgers,
  type GitRunner,
} from "../src/ledger-union.js";

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    ts: "2026-07-14T10:00:00.000Z",
    task: "004-x",
    repo: "demo-feed-service",
    status: "approved",
    mode: "local",
    vetoes: 0,
    ...overrides,
  };
}

function tmpLedger(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-union-")), "ledger.jsonl");
}

/** A git stub: records calls, answers `show` with canned JSONL. */
function gitStub(opts: { show?: string | Error; fetchError?: Error } = {}): {
  git: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    if (args[0] === "fetch") {
      if (opts.fetchError) throw opts.fetchError;
      return "";
    }
    if (args[0] === "show") {
      if (opts.show instanceof Error) throw opts.show;
      return opts.show ?? "";
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  return { git, calls };
}

const line = (e: LedgerEntry): string => `${JSON.stringify(e)}\n`;

describe("unionLedgers", () => {
  it("dedupes a run present on both sides by runId, keeping the later ts", () => {
    const local = entry({ runId: "r1", status: "approved", ts: "2026-07-14T10:00:00.000Z" });
    const remoteNewer = entry({ runId: "r1", status: "approved", ts: "2026-07-14T11:00:00.000Z" });
    const merged = unionLedgers([local], [remoteNewer]);
    expect(merged).toHaveLength(1);
    expect(merged[0].ts).toBe("2026-07-14T11:00:00.000Z");
  });

  it("keeps distinct runs from both sides and orders them chronologically", () => {
    const localRun = entry({ runId: "local-1", ts: "2026-07-14T12:00:00.000Z" });
    const cloudRun = entry({ runId: "cloud-1", ts: "2026-07-14T09:00:00.000Z", mode: "cloud" });
    const merged = unionLedgers([localRun], [cloudRun]);
    expect(merged.map((e) => e.runId)).toEqual(["cloud-1", "local-1"]);
  });

  it("dedupes runId-less legacy lines by exact content, not by identity", () => {
    const legacy = entry({ ts: "2026-07-01T00:00:00.000Z" });
    delete (legacy as Partial<LedgerEntry>).runId;
    // The same committed line appears in both the local file and origin/main.
    const merged = unionLedgers([{ ...legacy }], [{ ...legacy }]);
    expect(merged).toHaveLength(1);
  });

  it("returns an empty array for empty sources", () => {
    expect(unionLedgers([], [])).toEqual([]);
  });
});

describe("readRemoteLedger", () => {
  it("fetches then reads origin/main:fleet/ledger.jsonl", () => {
    const cloud = entry({ runId: "cloud-1", mode: "cloud" });
    const { git, calls } = gitStub({ show: line(cloud) });
    const entries = readRemoteLedger(git);
    expect(entries).toEqual([cloud]);
    expect(calls[0]).toEqual(["fetch", "origin", "main", "--quiet"]);
    expect(calls[1]).toEqual(["show", "origin/main:fleet/ledger.jsonl"]);
  });

  it("still reads the ref when fetch fails (offline)", () => {
    const cloud = entry({ runId: "cloud-1", mode: "cloud" });
    const { git } = gitStub({ show: line(cloud), fetchError: new Error("no network") });
    expect(readRemoteLedger(git)).toEqual([cloud]);
  });

  it("returns [] when the ledger does not exist on the branch", () => {
    const { git } = gitStub({ show: new Error("path 'fleet/ledger.jsonl' does not exist") });
    expect(readRemoteLedger(git)).toEqual([]);
  });

  it("returns [] rather than crashing on a malformed blob", () => {
    const { git } = gitStub({ show: "{not json\n" });
    expect(readRemoteLedger(git)).toEqual([]);
  });
});

describe("readUnionLedger", () => {
  it("merges a dirty local ledger with the committed remote copy", () => {
    const ledgerPath = tmpLedger();
    const localUncommitted = entry({ runId: "local-1", ts: "2026-07-14T12:00:00.000Z" });
    appendLedger(ledgerPath, localUncommitted);
    const cloud = entry({ runId: "cloud-1", ts: "2026-07-14T09:00:00.000Z", mode: "cloud" });
    const { git } = gitStub({ show: line(cloud) });

    const merged = readUnionLedger(ledgerPath, git);
    expect(merged.map((e) => e.runId)).toEqual(["cloud-1", "local-1"]);
  });
});
