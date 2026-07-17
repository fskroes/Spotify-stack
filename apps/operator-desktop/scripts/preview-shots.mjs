/**
 * Multi-state headless screenshots of the operator preview (`?preview`).
 *
 * The operator is a live SPA: unlike the static ledger HTML you can't `sed` an
 * opener into it, and the repo carries no Playwright/puppeteer/ws — so this is a
 * zero-dep Chrome DevTools Protocol driver over a raw socket. It spawns headless
 * Chrome with remote debugging, navigates the preview, and for each run state
 * clicks the queue row whose visible status text matches, then screenshots it.
 *
 * Prereq: the dev server is already running (`pnpm --filter @fleet/operator-desktop dev`).
 * Usage:  node apps/operator-desktop/scripts/preview-shots.mjs
 * Env:    PREVIEW_URL (default http://127.0.0.1:1420/?preview)
 *         OUT_DIR     (default apps/operator-desktop/artifacts — gitignored)
 *         CDP_PORT    (default 9222)
 *
 * The state list below is the run's full fate vocabulary; edit it to capture a
 * subset. Each entry is [visible status label to click, output file stem].
 */
import net from "node:net";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const URL_ = process.env.PREVIEW_URL ?? "http://127.0.0.1:1420/?preview";
const OUT = process.env.OUT_DIR ?? "apps/operator-desktop/artifacts";
const PORT = Number(process.env.CDP_PORT ?? 9222);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STATES = [
  ["Needs review", "review"],
  ["Verify failed", "failed"],
  ["Verifying", "live"],
  ["Merged", "merged"],
  ["No changes", "nochanges"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) =>
  new Promise((res, rej) =>
    http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => res(JSON.parse(d)));
    }).on("error", rej),
  );

/** Minimal CDP client: WebSocket handshake + masked text frames over raw net. */
function connect(wsUrl) {
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(Number(u.port), u.hostname, () =>
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    let buf = Buffer.alloc(0), up = false, id = 0;
    const waiters = new Map();
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!up) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        buf = buf.subarray(i + 4);
        up = true;
        resolve({
          send(method, params) {
            const body = Buffer.from(JSON.stringify({ id: ++id, method, params: params ?? {} }));
            const mask = crypto.randomBytes(4);
            const len = body.length;
            const head = len < 126 ? Buffer.from([0x81, 0x80 | len]) : Buffer.from([0x81, 0xfe, (len >> 8) & 255, len & 255]);
            const masked = Buffer.alloc(len);
            for (let k = 0; k < len; k++) masked[k] = body[k] ^ mask[k % 4];
            sock.write(Buffer.concat([head, mask, masked]));
            return new Promise((r) => waiters.set(id, r));
          },
        });
      }
      while (buf.length >= 2) {
        const l0 = buf[1] & 127;
        let off = 2, len = l0;
        if (l0 === 126) (len = buf.readUInt16BE(2)), (off = 4);
        else if (l0 === 127) (len = Number(buf.readBigUInt64BE(2))), (off = 10);
        if (buf.length < off + len) break;
        const data = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        try {
          const m = JSON.parse(data.toString());
          if (m.id && waiters.has(m.id)) waiters.get(m.id)(m.result), waiters.delete(m.id);
        } catch {}
      }
    });
  });
}

const chrome = spawn(CHROME, [
  "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--window-size=1360,860", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TMPDIR ?? "/tmp", "operator-cdp-profile")}`,
  "about:blank",
]);
process.on("exit", () => chrome.kill());

try {
  fs.mkdirSync(OUT, { recursive: true });
  for (let i = 0; i < 40; i++) { // wait for CDP to accept connections
    try { await getJSON("/json/version"); break; } catch { await sleep(150); }
  }
  const page = (await getJSON("/json")).find((t) => t.type === "page");
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: URL_ });
  await sleep(2200); // preview boot + default select
  let failures = 0;
  for (const [label, name] of STATES) {
    const clicked = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(()=>{const r=[...document.querySelectorAll('.run-row')].find(x=>x.textContent.includes(${JSON.stringify(label)}));if(r){r.click();return true}return false})()`,
    });
    if (!clicked?.result?.value) { console.error(`✖ no queue row matches "${label}"`); failures++; continue; }
    await sleep(900);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const out = path.join(OUT, `preview-${name}.png`);
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log(`✓ ${name.padEnd(10)} → ${out}`);
  }
  process.exit(failures ? 1 : 0);
} catch (e) {
  console.error("preview-shots failed:", e.message);
  process.exit(1);
}
