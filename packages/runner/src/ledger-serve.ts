/**
 * The live Fleet Ledger server (`fleet report --serve`).
 *
 * A tiny local HTTP endpoint that re-renders `fleet/ledger.jsonl` on every
 * request and pushes a reload signal to open browser pages over SSE whenever the
 * ledger changes — so the report updates as runs land, with no manual
 * regenerate. Node builtins only (no deps).
 *
 * Discipline mirrors the rest of the codebase: rendering stays pure (it calls
 * the runner's `renderLedgerHtml`), and network (`gh`) never leaks in here — the
 * CLI supplies co-sign state through the injected `fetchCosigns` callback.
 */
import { type IncomingMessage, type ServerResponse, createServer, type Server } from "node:http";
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import path from "node:path";
import { readLedger } from "./ledger.js";
import {
  type Cosign,
  type RenderOptions,
  LEDGER_EVENTS_PATH,
  renderLedgerHtml,
} from "./ledger-html.js";

export interface ServeLedgerOptions {
  /** Path to the watched ledger (fleet/ledger.jsonl). */
  ledgerPath: string;
  /** Port to listen on; 0 lets the OS pick a free one (used in tests). */
  port: number;
  /** Bind address; defaults to loopback. */
  host?: string;
  /** Forwarded to `renderLedgerHtml` (e.g. `{ days }`) on every request. */
  renderOpts?: RenderOptions;
  /**
   * CLI-supplied live co-sign fetch (owns `gh`). Undefined = offline, no poll.
   * Polled on an interval; when the result changes, open pages are reloaded.
   */
  fetchCosigns?: () => Record<string, Cosign>;
  /** Co-sign poll cadence in ms (only when `fetchCosigns` is set). */
  cosignPollMs?: number;
  /** Called once the server is listening, with the resolved URL. */
  onListen?: (url: string) => void;
}

export interface ServeLedgerHandle {
  url: string;
  close: () => Promise<void>;
}

/**
 * Start the live ledger server. Resolves once listening. `close()` stops the
 * watcher and poll, ends open SSE responses, and shuts the server down cleanly
 * (for Ctrl-C).
 */
export function serveLedger(opts: ServeLedgerOptions): Promise<ServeLedgerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const renderOpts = opts.renderOpts ?? {};
  const cosignPollMs = opts.cosignPollMs ?? 60_000;

  // Open SSE responses. A reload is broadcast to all of them on ledger change.
  const clients = new Set<ServerResponse>();
  // Current co-sign state, refreshed by the poll (never known when offline).
  let cosigns: Record<string, Cosign> | undefined = opts.fetchCosigns ? {} : undefined;

  const broadcastReload = (): void => {
    for (const res of clients) res.write("data: reload\n\n");
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
      const entries = readLedger(opts.ledgerPath);
      const html = renderLedgerHtml(entries, { ...renderOpts, liveReload: true, cosigns });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url === LEDGER_EVENTS_PATH) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":ok\n\n");
      clients.add(res);
      const drop = (): void => {
        clients.delete(res);
      };
      res.on("close", drop);
      req.on("close", drop);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  // SSE heartbeat — keeps intermediaries from dropping idle streams.
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(":heartbeat\n\n");
  }, 25_000);
  heartbeat.unref();

  // Watch the ledger's directory (atomic writes replace the inode, so watching
  // the file directly can miss updates), filtered to the ledger basename.
  const dir = path.dirname(opts.ledgerPath);
  const base = path.basename(opts.ledgerPath);
  mkdirSync(dir, { recursive: true });
  let watcher: FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename && filename !== base) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(broadcastReload, 150);
    });
  } catch {
    // Some platforms/filesystems can't watch; the page still serves and
    // refreshes manually. Don't take the server down over it.
  }

  // Co-sign poll — only when the CLI supplied a fetcher. A `gh` hiccup must
  // never kill the server, so every call is guarded.
  let cosignTimer: NodeJS.Timeout | undefined;
  if (opts.fetchCosigns) {
    let last = JSON.stringify(cosigns ?? {});
    const fetchCosigns = opts.fetchCosigns;
    cosignTimer = setInterval(() => {
      try {
        const next = fetchCosigns();
        const serialized = JSON.stringify(next);
        if (serialized !== last) {
          last = serialized;
          cosigns = next;
          broadcastReload();
        }
      } catch (err) {
        console.error(`(co-sign poll failed — keeping last state: ${(err as Error).message})`);
      }
    }, cosignPollMs);
    cosignTimer.unref();
  }

  return new Promise((resolve) => {
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;
      const url = `http://${host}:${boundPort}`;
      opts.onListen?.(url);

      const close = (): Promise<void> => {
        clearInterval(heartbeat);
        if (cosignTimer) clearInterval(cosignTimer);
        if (debounce) clearTimeout(debounce);
        watcher?.close();
        for (const res of clients) res.end();
        clients.clear();
        return new Promise((res) => server.close(() => res()));
      };

      resolve({ url, close });
    });
  });
}
