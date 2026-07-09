import { get } from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendLedger, type LedgerEntry } from "../src/ledger.js";
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

  it("closes cleanly", async () => {
    const ledgerPath = tmpLedger();
    handle = await serveLedger({ ledgerPath, port: 0 });
    await expect(handle.close()).resolves.toBeUndefined();
    handle = undefined; // already closed; don't double-close in afterEach
  });
});
