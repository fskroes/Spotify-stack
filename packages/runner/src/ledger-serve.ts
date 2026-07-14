/**
 * The live Fleet Ledger server (`fleet report --serve`).
 *
 * A tiny local HTTP endpoint that re-renders `fleet/ledger.jsonl` and the
 * in-flight store on every request, and pushes a reload signal to open browser
 * pages over SSE whenever either changes — so the report updates as runs move
 * through the pipeline and land, with no manual regenerate. Node builtins only
 * (no deps).
 *
 * Discipline mirrors the rest of the codebase: rendering stays pure (it calls
 * the runner's `renderLedgerHtml`), and network (`gh`) never leaks in here — the
 * CLI supplies co-sign state through the injected `fetchCosigns` callback.
 */
import { type IncomingMessage, type ServerResponse, createServer, type Server } from "node:http";
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import path from "node:path";
import { readLedger, type LedgerEntry } from "./ledger.js";
import { readRemoteLedger, type GitRunner } from "./ledger-union.js";
import { CloudArtifactSync, type AsyncGhRunner } from "./cloud-sync.js";
import { inflightDir, readLiveInflight } from "./inflight.js";
import { handleOperatorApi } from "./operator-api.js";
import {
  type Cosign,
  type RenderOptions,
  LEDGER_EVENTS_PATH,
  renderLedgerHtml,
} from "./ledger-html.js";

export interface ServeLedgerOptions {
  /** Path to the watched ledger (fleet/ledger.jsonl). */
  ledgerPath: string;
  /** Control repository root. Inferred from `<repo>/fleet/ledger.jsonl`. */
  controlRepo?: string;
  /** Artifact root exposed by the read-only operator API. */
  artifactsRoot?: string;
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
  /** Poll cadence in ms for the live pollers (co-sign + remote ledger). */
  cosignPollMs?: number;
  /**
   * CLI-supplied `git` runner (owns the subprocess). When set, the poll reads
   * origin/main's committed ledger on the same cadence and the operator API
   * serves the union — bringing cloud runs (pushed to main, never to the local
   * file) into every view. Undefined = local ledger only.
   */
  git?: GitRunner;
  /**
   * CLI-supplied async `gh` runner for `gh run download`. When set, opening a
   * cloud run's Review pulls its Actions artifact on demand. Undefined = cloud
   * evidence is reported unavailable on this server (the CLI stays the path).
   */
  downloadGh?: AsyncGhRunner;
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
  const controlRepo = opts.controlRepo ?? path.dirname(path.dirname(opts.ledgerPath));

  // Open SSE responses. A reload is broadcast to all of them on ledger change.
  const clients = new Set<ServerResponse>();
  // Current co-sign state, refreshed by the poll (never known when offline).
  let cosigns: Record<string, Cosign> | undefined = opts.fetchCosigns ? {} : undefined;
  // Committed ledger on origin/main, refreshed by the poll (empty when offline).
  let remoteEntries: LedgerEntry[] = [];
  // Cloud artifact sync, built below once scheduleReload exists to notify it.
  let cloudSync: CloudArtifactSync | undefined;

  const broadcastReload = (): void => {
    for (const res of clients) res.write("data: reload\n\n");
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (
      handleOperatorApi(req, res, {
        ledgerPath: opts.ledgerPath,
        controlRepo,
        artifactsRoot: opts.artifactsRoot,
        // Live state, not a snapshot — the poll below replaces `cosigns` and
        // `remoteEntries`; both are read at request time.
        getCosigns: opts.fetchCosigns ? () => cosigns ?? {} : undefined,
        getRemoteEntries: opts.git ? () => remoteEntries : undefined,
        cloudSync,
      })
    ) {
      return;
    }
    if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
      const entries = readLedger(opts.ledgerPath);
      // Read, never sweep: a GET stays side-effect-free and so cannot race a
      // runner staking its claim. Orphan files are the runner's to reap.
      const inflight = readLiveInflight(opts.ledgerPath);
      const html = renderLedgerHtml(entries, { ...renderOpts, liveReload: true, cosigns, inflight });
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

  let debounce: NodeJS.Timeout | undefined;
  const scheduleReload = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(broadcastReload, 150);
  };

  // A settled download writes into artifacts/runs/<id> (unwatched); nudge open
  // pages to re-fetch so a `syncing` rail resolves to evidence without a manual
  // refresh.
  if (opts.downloadGh) {
    cloudSync = new CloudArtifactSync({ controlRepo, gh: opts.downloadGh, onSettled: scheduleReload });
  }

  const watchers: FSWatcher[] = [];
  /** Some platforms/filesystems can't watch; the page still serves and refreshes
   *  manually. Don't take the server down over it. */
  const tryWatch = (dir: string, onChange: (filename: string | null) => void): void => {
    try {
      watchers.push(watch(dir, (_event, filename) => onChange(filename)));
    } catch {
      /* unwatchable */
    }
  };

  // Watch the ledger's directory (atomic writes replace the inode, so watching
  // the file directly can miss updates), filtered to the ledger basename.
  const dir = path.dirname(opts.ledgerPath);
  const base = path.basename(opts.ledgerPath);
  mkdirSync(dir, { recursive: true });
  tryWatch(dir, (filename) => {
    if (filename && filename !== base) return;
    scheduleReload();
  });

  // And the in-flight store, for the Live lane. A second watcher is not optional:
  // `fs.watch` is non-recursive, so the ledger's watcher never sees a write
  // inside the `inflight/` subdirectory. The 150ms debounce also absorbs the
  // window in which `finish()` has appended the ledger line but not yet unlinked
  // the record — both events collapse into one reload.
  const liveDir = inflightDir(opts.ledgerPath);
  mkdirSync(liveDir, { recursive: true });
  tryWatch(liveDir, scheduleReload);

  // Live pollers — each supplied by the CLI (which owns the `gh`/`git`
  // subprocess). A poller reads some live state and, when its serialized form
  // changes since the last tick, applies it and reloads open pages. A `gh`/`git`
  // hiccup must never kill the server, so each read is guarded — the last good
  // state simply persists. All pollers share one cadence.
  const pollers: Array<() => void> = [];
  const addPoller = <T>(label: string, read: () => T, apply: (value: T) => void, initial: T): void => {
    let last = JSON.stringify(initial);
    pollers.push(() => {
      try {
        const next = read();
        const serialized = JSON.stringify(next);
        if (serialized === last) return;
        last = serialized;
        apply(next);
        broadcastReload();
      } catch (err) {
        console.error(`(${label} poll failed — keeping last state: ${(err as Error).message})`);
      }
    });
  };

  if (opts.fetchCosigns) {
    const fetchCosigns = opts.fetchCosigns;
    addPoller("co-sign", fetchCosigns, (next) => {
      cosigns = next;
    }, cosigns ?? {});
  }
  if (opts.git) {
    const git = opts.git;
    addPoller("remote ledger", () => readRemoteLedger(git), (next) => {
      remoteEntries = next;
    }, remoteEntries);
  }

  // Poll once at startup, off the listen path so startup itself is never gated
  // on `gh`/`git` — without this a fresh operator connect would show no cloud
  // runs or co-sign state until the first interval tick (a whole minute).
  let pollTimer: NodeJS.Timeout | undefined;
  let pollKickoff: NodeJS.Timeout | undefined;
  if (pollers.length > 0) {
    const tick = (): void => {
      for (const poll of pollers) poll();
    };
    pollKickoff = setTimeout(tick, 0);
    pollKickoff.unref();
    pollTimer = setInterval(tick, cosignPollMs);
    pollTimer.unref();
  }

  return new Promise((resolve) => {
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;
      const url = `http://${host}:${boundPort}`;
      opts.onListen?.(url);

      const close = (): Promise<void> => {
        clearInterval(heartbeat);
        if (pollTimer) clearInterval(pollTimer);
        if (pollKickoff) clearTimeout(pollKickoff);
        if (debounce) clearTimeout(debounce);
        for (const w of watchers) w.close();
        for (const res of clients) res.end();
        clients.clear();
        return new Promise((res) => server.close(() => res()));
      };

      resolve({ url, close });
    });
  });
}
