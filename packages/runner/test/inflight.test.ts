import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  beginInflight,
  inflightDir,
  isLive,
  readInflight,
  readLiveInflight,
  sweepInflight,
  type InflightRecord,
} from "../src/inflight.js";
import { AGENT_TIMEOUT_MS, STALE_AFTER_MS } from "../src/timeouts.js";

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

  it("clears twice in silence, because finish() and run()'s finally both call it", () => {
    const ledgerPath = tmpLedger();
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

    inflight.clear();
    expect(() => inflight.clear()).not.toThrow();

    expect(warnings).toEqual([]); // an ENOENT warning on every green run
    expect(readInflight(ledgerPath)).toEqual([]);
  });
});

/** A pid that is certainly dead: a child we waited for. */
const deadPid = (): number => {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) throw new Error("no pid from spawnSync");
  return pid;
};

const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000).toISOString();

const msAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Write a record straight into the store, bypassing `beginInflight`. */
const seed = (ledgerPath: string, over: Partial<InflightRecord> & { pid: number }): string => {
  const dir = inflightDir(ledgerPath);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${over.pid}.json`);
  const record: InflightRecord = {
    v: 1,
    runId: `run-${over.pid}`,
    startedAt: minutesAgo(5),
    task: "001-ts-migrate-http-client",
    repo: "demo-ts-service",
    title: "Migrate the HTTP client",
    stage: "agent",
    attempt: 1,
    stageSince: minutesAgo(5),
    ...over,
  };
  writeFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
};

describe("inflight liveness", () => {
  it("sweeps a record whose process is gone, however fresh the stage looks", () => {
    const ledgerPath = tmpLedger();
    const file = seed(ledgerPath, { pid: deadPid(), stageSince: new Date().toISOString() });

    sweepInflight(ledgerPath, () => {});

    expect(existsSync(file)).toBe(false);
  });

  it("sweeps a live pid whose stage has outlived the backstop — the pid was reused", () => {
    const ledgerPath = tmpLedger();
    // Derived from the backstop, not a literal: a hardcoded age silently stops
    // testing the boundary the moment STALE_AFTER_MS moves.
    const file = seed(ledgerPath, { pid: process.pid, stageSince: msAgo(STALE_AFTER_MS + 60_000) });

    expect(isLive(readInflight(ledgerPath)[0])).toBe(false);
    sweepInflight(ledgerPath, () => {});

    expect(existsSync(file)).toBe(false);
  });

  it("never sweeps a concurrent runner's live claim", () => {
    const ledgerPath = tmpLedger();
    const file = seed(ledgerPath, { pid: process.pid, stageSince: minutesAgo(1) });

    sweepInflight(ledgerPath, () => {});

    expect(existsSync(file)).toBe(true);
    expect(readLiveInflight(ledgerPath)).toMatchObject([{ pid: process.pid }]);
  });

  it("filters dead records out of the live view while leaving the raw read alone", () => {
    const ledgerPath = tmpLedger();
    seed(ledgerPath, { pid: deadPid() });
    seed(ledgerPath, { pid: process.pid });

    expect(readInflight(ledgerPath)).toHaveLength(2); // #6 renders from the live view
    expect(readLiveInflight(ledgerPath)).toMatchObject([{ pid: process.pid }]);
  });

  // STALE_AFTER_MS is derived from AGENT_TIMEOUT_MS in timeouts.ts so the pair
  // cannot drift. Asserting that arithmetic here would only restate the
  // derivation and could never fail; this pins the behaviour it exists to
  // produce — the sweep must not reap a run still inside its longest stage.
  it("keeps a live run whose agent stage has run right up to the agent timeout", () => {
    const ledgerPath = tmpLedger();
    // The agent call is the longest stage a run can legitimately sit in. Drop
    // the backstop below it and this run gets reaped mid-agent — raising the
    // agent timeout would then shorten runs, which reads as a hang.
    const file = seed(ledgerPath, { pid: process.pid, stageSince: msAgo(AGENT_TIMEOUT_MS) });

    sweepInflight(ledgerPath, () => {});

    expect(existsSync(file)).toBe(true);
    expect(readLiveInflight(ledgerPath)).toMatchObject([{ pid: process.pid }]);
  });
});

describe("inflight signal handling", () => {
  it("clears the claim on SIGINT and still exits 130", async () => {
    const ledgerPath = tmpLedger();
    const dir = inflightDir(ledgerPath);
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const inflightModule = fileURLToPath(new URL("../src/inflight.ts", import.meta.url));
    // .mts, not .ts: the fixture's tmpdir has no package.json, so tsx would
    // read a bare .ts as CJS and reject its top-level await.
    const fixture = path.join(path.dirname(ledgerPath), "run.mts");
    writeFileSync(
      fixture,
      `const { beginInflight } = await import(${JSON.stringify(inflightModule)});\n` +
        `beginInflight({ ledgerPath: ${JSON.stringify(ledgerPath)}, runId: "sig", ` +
        `startedAt: new Date(), task: "t", repo: "r", title: "T", log: () => {} });\n` +
        `console.log("claimed");\n` +
        `setInterval(() => {}, 1000);\n`,
    );

    // node --import tsx, not the tsx shim: the shim re-spawns node, so the pid
    // we signal would not be the pid that staked the claim, and the exit code
    // we assert would be the shim's.
    const child = spawn(process.execPath, ["--import", "tsx", fixture], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const claimed = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (b: Buffer) => b.toString().includes("claimed") && resolve());
      child.on("exit", (code) => reject(new Error(`fixture exited early (${code})`)));
    });
    await claimed;
    expect(readdirSync(dir)).toEqual([`${child.pid}.json`]);

    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.kill("SIGINT");

    // 128 + SIGINT(2). Installing a listener replaces Node's default, so a
    // handler that forgets to re-exit makes a Ctrl-C'd run report success.
    expect(await exited).toBe(130);
    expect(readdirSync(dir)).toEqual([]);
  }, 20_000);
});
