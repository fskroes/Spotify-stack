import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { beginInflight, inflightDir, readInflight, type InflightRecord } from "../src/inflight.js";

const tmpLedger = () =>
  path.join(mkdtempSync(path.join(os.tmpdir(), "fleet-inflight-")), "ledger.jsonl");

const begin = (ledgerPath: string, over: { pid?: number; runId?: string } = {}) =>
  beginInflight({
    ledgerPath,
    runId: over.runId ?? "run-1",
    startedAt: new Date("2026-07-09T12:00:00.000Z"),
    task: "001-ts-migrate-http-client",
    repo: "demo-ts-service",
    title: "Migrate the HTTP client",
    pid: over.pid ?? 4242,
    log: () => {},
  });

describe("inflight store", () => {
  it("derives the store from the ledger's directory, so tests stay hermetic", () => {
    expect(inflightDir("/x/fleet/ledger.jsonl")).toBe("/x/fleet/inflight");
  });

  it("reads back nothing when no run has ever claimed the store", () => {
    expect(readInflight(tmpLedger())).toEqual([]);
  });

  it("stakes a claim at <pid>.json the moment the run begins", () => {
    const ledgerPath = tmpLedger();
    begin(ledgerPath);

    expect(readdirSync(inflightDir(ledgerPath))).toEqual(["4242.json"]);
    expect(readInflight(ledgerPath)).toEqual([
      {
        v: 1,
        runId: "run-1",
        pid: 4242,
        startedAt: "2026-07-09T12:00:00.000Z",
        task: "001-ts-migrate-http-client",
        repo: "demo-ts-service",
        title: "Migrate the HTTP client",
        stage: "agent",
        attempt: 1,
        stageSince: "2026-07-09T12:00:00.000Z",
      } satisfies InflightRecord,
    ]);
  });

  it("overwrites one record per transition and stamps when the stage was entered", () => {
    const ledgerPath = tmpLedger();
    const inflight = begin(ledgerPath);
    inflight.enter("verify");

    const [record] = readInflight(ledgerPath);
    expect(readdirSync(inflightDir(ledgerPath))).toEqual(["4242.json"]); // never an event log
    expect(record.stage).toBe("verify");
    expect(record.attempt).toBe(1); // carried forward
    expect(Date.parse(record.stageSince)).toBeGreaterThan(Date.parse(record.startedAt));
  });

  it("carries the attempt count, because the agent→verify→judge loop is not monotonic", () => {
    const ledgerPath = tmpLedger();
    const inflight = begin(ledgerPath);

    inflight.enter("agent", 2);
    expect(readInflight(ledgerPath)[0]).toMatchObject({ stage: "agent", attempt: 2 });

    inflight.enter("judge");
    expect(readInflight(ledgerPath)[0]).toMatchObject({ stage: "judge", attempt: 2 });
  });

  it("clears only its own claim, leaving concurrent runs in flight", () => {
    const ledgerPath = tmpLedger();
    const mine = begin(ledgerPath, { pid: 1, runId: "mine" });
    begin(ledgerPath, { pid: 2, runId: "theirs" });

    mine.clear();

    expect(readInflight(ledgerPath)).toMatchObject([{ runId: "theirs", pid: 2 }]);
  });

  it("skips a file it caught mid-write rather than crashing the reader", () => {
    const ledgerPath = tmpLedger();
    begin(ledgerPath, { pid: 1 });
    writeFileSync(path.join(inflightDir(ledgerPath), "2.json"), '{"v":1,"runId":"tor');

    expect(readInflight(ledgerPath)).toHaveLength(1);
  });

  it("never throws when the store is unwritable — a live view must not fail a run", () => {
    const ledgerPath = tmpLedger();
    const dir = inflightDir(ledgerPath);
    const warnings: string[] = [];
    const inflight = beginInflight({
      ledgerPath,
      runId: "run-1",
      startedAt: new Date(),
      task: "t",
      repo: "r",
      title: "T",
      pid: 4242,
      log: (line) => warnings.push(line),
    });
    chmodSync(dir, 0o500); // read + execute: no new files, no unlink

    expect(() => inflight.enter("verify")).not.toThrow();
    expect(() => inflight.clear()).not.toThrow();
    expect(warnings.join("\n")).toContain("in-flight state not written");
    expect(warnings.join("\n")).toContain("in-flight state not cleared");

    chmodSync(dir, 0o700);
    expect(existsSync(path.join(dir, "4242.json"))).toBe(true);
  });
});
