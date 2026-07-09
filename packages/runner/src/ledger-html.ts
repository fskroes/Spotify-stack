/**
 * The Fleet Ledger, rendered as a self-contained HTML page.
 *
 * This is the "Fleet Ledger v2" design (a Claude Design project) re-authored as
 * a standalone report bound to real ledger data — not the interactive mockup.
 * It renders only what fleet/ledger.jsonl actually records: the stat chips, the
 * 14-day trend, the pipeline funnel, and the run table with per-run timings and
 * evidence. The human co-sign / merge state is the one thing the ledger cannot
 * know (it happens on GitHub after the run) — it is rendered only when the
 * caller passes live-fetched state in (`fleet report --html --cosign`), never
 * invented.
 *
 * Output is a single file: no external fonts, no scripts beyond a little inline
 * filtering, nothing to fetch. Open it anywhere, commit it, attach it to a PR.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fleetRecord, KILL_STATUSES, readLedger, type LedgerEntry } from "./ledger.js";

/** Nord palette — the design's colours, kept as named constants. */
const C = {
  bg: "#2E3440",
  panel: "#3B4252",
  panel2: "#333A48",
  line: "rgba(236,239,244,0.08)",
  text: "#ECEFF4",
  muted: "#D8DEE9",
  dim: "rgba(216,222,233,0.55)",
  green: "#A3BE8C", // shipped
  red: "#BF616A", // killed / kill-rate
  orange: "#D08770", // scope
  blue: "#81A1C1", // verify
  purple: "#B48EAD", // judge veto
  yellow: "#EBCB8B", // neutral / reached
  frost: "#88C0D0",
  gray: "#4C566A",
} as const;

interface Verdict {
  label: string;
  color: string;
  /** The pipeline gate a kill happened at, if any. */
  stage: "agent" | "scope" | "verify" | "judge" | null;
  kind: "shipped" | "killed" | "infra" | "neutral";
}

/**
 * The human co-sign state of a shipped PR, fetched live from GitHub at render
 * time (the ledger itself never records it — the merge happens after the run).
 */
export interface Cosign {
  state: "merged" | "open" | "closed";
  mergedBy?: string;
  /** ISO-8601 merge timestamp. */
  mergedAt?: string;
}

/** Map a raw ledger status onto the design's verdict vocabulary. */
function verdictFor(status: string): Verdict {
  switch (status) {
    case "approved":
      return { label: "SHIPPED", color: C.green, stage: null, kind: "shipped" };
    case "vetoed":
      return { label: "VETOED · JUDGE", color: C.purple, stage: "judge", kind: "killed" };
    case "verify-failed":
      return { label: "KILLED · VERIFY", color: C.blue, stage: "verify", kind: "killed" };
    case "scope-violation":
      return { label: "KILLED · SCOPE", color: C.orange, stage: "scope", kind: "killed" };
    case "agent-failed":
      return { label: "KILLED · AGENT", color: C.red, stage: "agent", kind: "killed" };
    case "engine-failed":
      return { label: "INFRA", color: C.gray, stage: null, kind: "infra" };
    case "no-changes":
      return { label: "NO-CHANGE", color: C.gray, stage: null, kind: "neutral" };
    default:
      return { label: status.toUpperCase(), color: C.muted, stage: null, kind: "neutral" };
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** #RRGGBB → rgba() at the given alpha, for translucent badge/bar fills. */
function hexA(hex: string, a: number): string {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function badge(v: Verdict): string {
  return `<span style="display:inline-block;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:0.03em;padding:3px 8px;border-radius:4px;color:${v.color};background:${hexA(v.color, 0.14)};border:1px solid ${hexA(v.color, 0.45)}">${esc(v.label)}</span>`;
}

/** Colour + wording for a co-sign state, shared by the PR cell and the drawer. */
function cosignLook(c: Cosign): { color: string; label: string } {
  switch (c.state) {
    case "merged":
      return { color: C.green, label: c.mergedBy ? `co-signed by ${c.mergedBy}` : "co-signed" };
    case "open":
      return { color: C.yellow, label: "awaiting co-sign" };
    case "closed":
      return { color: C.red, label: "closed unmerged" };
  }
}

/** The pull-request cell: a link when we have one, otherwise a dash. */
function prCell(url?: string, cosign?: Cosign): string {
  if (!url) return `<span style="color:${C.gray}">—</span>`;
  const m = url.match(/\/pull\/(\d+)/);
  const label = m ? `#${m[1]}` : "open";
  const state = cosign
    ? `<div style="font-size:10px;font-weight:600;color:${cosignLook(cosign).color};margin-top:2px">${esc(cosign.state)}</div>`
    : "";
  return `<a href="${esc(url)}" style="color:${C.frost};text-decoration:none">${label} ↗</a>${state}`;
}

function chip(label: string, value: string, color: string, sub?: string): string {
  return `<div style="padding:13px 26px 12px 0;margin-right:26px;border-right:1px solid rgba(236,239,244,0.07)">
      <div style="font-family:var(--mono);font-size:22px;font-weight:500;line-height:1;color:${color}">${esc(value)}</div>
      <div style="font-size:10.5px;letter-spacing:0.09em;text-transform:uppercase;color:${C.dim};margin-top:6px">${esc(label)}${sub ? `<span style="color:${C.gray};text-transform:none;letter-spacing:0"> ${esc(sub)}</span>` : ""}</div>
    </div>`;
}

interface FunnelStage {
  label: string;
  sub: string;
  color: string;
  passed: number;
  killCount: number;
  topReason?: string;
}

function renderFunnel(stages: FunnelStage[], entered: number, note: string): string {
  const base = Math.max(entered, 1);
  const rows = stages
    .map((s) => {
      const pct = ((s.passed / base) * 100).toFixed(1);
      const kill =
        s.killCount > 0
          ? `<div style="margin-left:16px;display:flex;align-items:center;gap:10px">
              <span style="font-family:var(--mono);font-size:12.5px;color:${C.red};font-weight:600">− ${s.killCount} killed</span>
              ${s.topReason ? `<span style="font-size:11.5px;color:${C.dim};max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">top: ${esc(s.topReason)}</span>` : ""}
            </div>`
          : "";
      return `<div style="display:flex;align-items:stretch;gap:0">
          <div style="width:150px;flex:none;padding:16px 16px 16px 0;text-align:right">
            <div style="font-size:12.5px;font-weight:600;color:${s.color}">${esc(s.label)}</div>
            <div style="font-family:var(--mono);font-size:10.5px;color:rgba(216,222,233,0.45);margin-top:3px">${esc(s.sub)}</div>
          </div>
          <div style="flex:1;position:relative;display:flex;align-items:center;border-left:1px solid rgba(236,239,244,0.12);padding:12px 0">
            <div style="height:38px;width:${pct}%;min-width:2px;background:${hexA(s.color, 0.16)};border-left:3px solid ${s.color};display:flex;align-items:center;padding:0 14px;border-radius:0 4px 4px 0">
              <span style="font-family:var(--mono);font-size:13px;font-weight:600;color:${C.text}">${s.passed} passed</span>
            </div>
            ${kill}
          </div>
        </div>`;
    })
    .join("");
  return `<div style="max-width:1080px">${rows}
      <div style="font-family:var(--mono);font-size:11px;color:${C.gray};margin-top:22px">${esc(note)}</div>
    </div>`;
}

/** Most common reason among windowed kills of a given raw status. */
function topReasonFor(kills: LedgerEntry[], status: string): string | undefined {
  const counts = new Map<string, number>();
  for (const k of kills) {
    if (k.status === status && k.reason) counts.set(k.reason, (counts.get(k.reason) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [reason, n] of counts) {
    if (n > bestN) {
      best = reason;
      bestN = n;
    }
  }
  return best;
}

interface TrendDay {
  iso: string;
  shipped: number;
  killed: number;
  other: number;
}

/**
 * The per-day shipped/killed/other counts for the last `days` UTC days, ending
 * today. Pure ledger data — days with no runs stay zero, so a young ledger
 * reads as exactly that rather than pretending to a history it doesn't have.
 */
function computeTrendDays(entries: LedgerEntry[], now: Date, days = 14): TrendDay[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const todayUtc = Math.floor(now.getTime() / dayMs);
  return Array.from({ length: days }, (_, i) => {
    const dayStart = (todayUtc - (days - 1 - i)) * dayMs;
    const iso = new Date(dayStart).toISOString().slice(0, 10);
    let shipped = 0;
    let killed = 0;
    let other = 0;
    for (const e of entries) {
      const t = Date.parse(e.ts);
      if (t < dayStart || t >= dayStart + dayMs) continue;
      if (e.status === "approved") shipped += 1;
      else if ((KILL_STATUSES as readonly string[]).includes(e.status)) killed += 1;
      else other += 1;
    }
    return { iso, shipped, killed, other };
  });
}

/**
 * 0-based UTC day index of a timestamp within the report window (0 = oldest day
 * in the window, `days - 1` = today). Shared by the ledger rows' `data-day`
 * attribute and the time-window scrubber's bucketing.
 */
function dayIndex(ts: string, now: Date, days: number): number {
  const dayMs = 24 * 60 * 60 * 1000;
  const todayUtc = Math.floor(now.getTime() / dayMs);
  const tUtc = Math.floor(Date.parse(ts) / dayMs);
  return tUtc - (todayUtc - (days - 1));
}

/**
 * The Trend tab: a full-size 14-day stacked bar chart. Column height tracks the
 * day's dispatched count; segments stack shipped (green) over killed (red) over
 * other (gray) — the only three the ledger can source. A kill-rate label rides
 * above each column; today is outlined. Headline and cards are computed from
 * real totals, with a young-ledger branch so a thin ledger doesn't overclaim.
 */
function renderTrendTab(
  days: TrendDay[],
  cosign: { merged: number; known: number } | null,
): string {
  const max = Math.max(1, ...days.map((d) => d.shipped + d.killed + d.other));
  const AREA = 180;
  const px = (n: number, total: number) =>
    total === 0 ? 0 : Math.max(1, Math.round((n / total) * Math.max(2, Math.round((total / max) * AREA))));

  const cols = days
    .map((d, i) => {
      const total = d.shipped + d.killed + d.other;
      const decided = d.shipped + d.killed;
      const rate = decided > 0 ? `${Math.round((d.killed / decided) * 100)}%` : "—";
      const isToday = i === days.length - 1;
      const title = `${d.iso} · ${d.shipped} shipped · ${d.killed} killed${d.other > 0 ? ` · ${d.other} other` : ""}`;
      const barH = total === 0 ? 2 : Math.max(2, Math.round((total / max) * AREA));
      const seg = (h: number, color: string) =>
        h > 0 ? `<div style="height:${h}px;background:${color}"></div>` : "";
      const inner =
        total === 0
          ? `<div style="height:2px;background:rgba(236,239,244,0.10)"></div>`
          : `${seg(px(d.shipped, total), C.green)}${seg(px(d.killed, total), C.red)}${seg(px(d.other, total), C.gray)}`;
      const label = isToday ? "today" : d.iso.slice(5);
      const rateColor = isToday ? C.frost : C.dim;
      const labelColor = isToday ? C.frost : "rgba(216,222,233,0.5)";
      return `<div title="${esc(title)}" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:6px">
          <div style="font-family:var(--mono);font-size:10.5px;color:${rateColor};font-weight:600">${rate}</div>
          <div style="width:100%;max-width:44px;display:flex;flex-direction:column;height:${barH}px;border-radius:4px 4px 0 0;overflow:hidden;border:1px solid ${isToday ? C.frost : "transparent"}">${inner}</div>
          <div style="font-family:var(--mono);font-size:10px;color:${labelColor}">${esc(label)}</div>
        </div>`;
    })
    .join("");

  let totalShipped = 0;
  let totalKilled = 0;
  let totalOther = 0;
  let rateSum = 0;
  let ratedDays = 0;
  let activeDays = 0;
  for (const d of days) {
    totalShipped += d.shipped;
    totalKilled += d.killed;
    totalOther += d.other;
    if (d.shipped + d.killed + d.other > 0) activeDays += 1;
    if (d.shipped + d.killed > 0) {
      rateSum += Math.round((d.killed / (d.shipped + d.killed)) * 100);
      ratedDays += 1;
    }
  }
  const totalDispatched = totalShipped + totalKilled + totalOther;
  const avgRate = ratedDays > 0 ? Math.round(rateSum / ratedDays) : null;

  const headline =
    ratedDays >= 2 && avgRate !== null
      ? `The filter holds: ~${avgRate}% of decided runs killed before review across the last 14 days.`
      : `Too little history to call a trend — ${totalDispatched} run${totalDispatched === 1 ? "" : "s"} across ${activeDays} of the last 14 days.`;
  const sub = `${totalShipped} shipped for review · ${totalKilled} killed · ${totalOther} infra/neutral, over ${totalDispatched} dispatched runs.`;

  const legend = (color: string, label: string) =>
    `<span style="display:flex;align-items:center;gap:7px;font-size:11.5px;color:rgba(216,222,233,0.65)"><span style="width:10px;height:10px;background:${color};border-radius:2px;display:inline-block"></span>${label}</span>`;

  const shippedNote = cosign
    ? `${cosign.merged}/${cosign.known} of those with known PR state were co-signed`
    : "merge state not fetched — generate with --cosign";
  const cards = [
    {
      value: avgRate === null ? "—" : `${avgRate}%`,
      color: C.red,
      title: "average kill rate of decided runs",
      note: "across days that decided at least one run",
    },
    {
      value: String(totalShipped),
      color: C.green,
      title: "shipped for review in 14 days",
      note: shippedNote,
    },
    {
      value: String(totalDispatched),
      color: C.text,
      title: "dispatched in 14 days",
      note: `${totalKilled} killed · ${totalOther} infra/neutral (not verdicts)`,
    },
  ]
    .map(
      (c) => `<div style="flex:1;min-width:220px;background:${C.panel};border:1px solid rgba(236,239,244,0.09);border-radius:8px;padding:18px 20px">
        <div style="font-family:var(--mono);font-size:26px;font-weight:500;color:${c.color};line-height:1">${esc(c.value)}</div>
        <div style="font-size:12.5px;color:${C.muted};margin-top:8px;font-weight:600">${esc(c.title)}</div>
        <div style="font-size:11.5px;color:rgba(216,222,233,0.5);margin-top:5px;line-height:1.45">${esc(c.note)}</div>
      </div>`,
    )
    .join("");

  return `<div style="padding:30px 34px">
    <div style="max-width:1080px;margin:0 auto">
      <div style="font-size:13px;color:${C.dim};margin-bottom:4px">Aggregate trend · last 14 days</div>
      <div style="font-size:20px;font-weight:600;margin-bottom:8px;color:${C.text}">${esc(headline)}</div>
      <div style="font-size:12.5px;color:rgba(216,222,233,0.6);margin-bottom:30px;line-height:1.5">${esc(sub)}</div>
      <div style="display:flex;align-items:flex-end;gap:10px;height:${AREA + 40}px;border-bottom:1px solid rgba(236,239,244,0.12);padding:0 6px">${cols}</div>
      <div style="display:flex;gap:22px;margin-top:18px;flex-wrap:wrap;align-items:center">
        ${legend(C.red, "killed by fleet")}${legend(C.green, "shipped for review")}${legend(C.gray, "infra · neutral")}
      </div>
      <div style="display:flex;gap:14px;margin-top:30px;flex-wrap:wrap">${cards}</div>
    </div>
  </div>`;
}

/** ms → a compact human duration, or a dash when we didn't record one. */
function fmtDur(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Colour an evidence line by a light diff/log heuristic. */
function evLineStyle(line: string): string {
  const t = line.trimStart();
  let c: string = C.dim;
  if (t.startsWith("+")) c = C.green;
  else if (t.startsWith("-")) c = C.red;
  else if (t.startsWith("✓")) c = C.green;
  else if (/^(✗|veto:)|error|fail/i.test(t)) c = C.red;
  else if (/^⧗|warn/i.test(t)) c = C.yellow;
  return `font-family:var(--mono);font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;padding:1px 14px;color:${c}`;
}

interface Stage {
  label: string;
  sub: string;
  color: string;
  ms?: number;
}

/** The pipeline-trace timeline: which gate a run reached, and how long each took. */
function renderTimeline(e: LedgerEntry, cosign?: Cosign): string {
  const stages: Stage[] = [
    { label: "Agent", sub: "produced a diff", color: C.red, ms: e.timings?.agentMs },
    { label: "Scope gate", sub: "declared-scope check", color: C.orange },
    { label: "Verify", sub: "build · test · lint", color: C.blue, ms: e.timings?.verifyMs },
    { label: "Judge", sub: "LLM diff review", color: C.purple, ms: e.timings?.judgeMs },
    { label: "Human review", sub: "the merge button", color: C.green },
  ];
  const deathIdx: Record<string, number> = {
    "agent-failed": 0,
    "scope-violation": 1,
    "verify-failed": 2,
    vetoed: 3,
  };

  // Special cases that don't map onto the linear gate walk.
  if (e.status === "engine-failed") {
    return `<div style="font-family:var(--mono);font-size:12px;color:${C.gray};padding:9px 0">infra — the engine crashed mid-run; no verdict was reached.</div>`;
  }
  if (e.status === "no-changes") {
    return `<div style="font-family:var(--mono);font-size:12px;color:${C.gray};padding:9px 0">agent correctly made no change — preconditions were not met.</div>`;
  }

  const dot = (bg: string, halo: string): string =>
    `<span style="width:10px;height:10px;border-radius:50%;background:${bg};flex:none;box-shadow:0 0 0 3px ${halo}"></span>`;
  const d = deathIdx[e.status]; // undefined for approved

  return stages
    .map((s, i) => {
      let status: string;
      let color: string;
      let bg: string;
      let time = fmtDur(s.ms);
      if (d === undefined) {
        // approved — everything passed; the human queue is the last gate
        if (i < 4) {
          status = "passed";
          color = C.green;
          bg = C.green;
        } else if (cosign) {
          // Live co-sign state, fetched from GitHub at render time.
          const look = cosignLook(cosign);
          status = look.label;
          color = look.color;
          bg = look.color;
          time = cosign.mergedAt ? cosign.mergedAt.replace("T", " ").slice(0, 16) : "—";
        } else {
          status = "shipped for review";
          color = C.green;
          bg = C.green;
          time = "—";
        }
      } else if (i < d) {
        status = "passed";
        color = C.green;
        bg = C.green;
      } else if (i === d) {
        status = i === 3 ? "VETOED" : "KILLED";
        color = C.red;
        bg = C.red;
      } else {
        status = "skipped";
        color = C.gray;
        bg = C.gray;
        time = "—";
      }
      return `<div style="display:flex;align-items:center;gap:13px;padding:9px 0;border-bottom:1px solid rgba(236,239,244,0.05)">
          ${dot(bg, hexA(bg, 0.18))}
          <span style="font-size:12.5px;color:${C.muted};width:120px;flex:none">${esc(s.label)}</span>
          <span style="font-size:11.5px;font-weight:600;color:${color};flex:1;font-family:var(--mono)">${esc(status)}</span>
          <span style="font-family:var(--mono);font-size:11px;color:rgba(216,222,233,0.5)">${time}</span>
        </div>`;
    })
    .join("");
}

interface FlowStation {
  n: string;
  accent: string;
  tag: string;
  title: string;
  body: string;
  chips?: { glyph: string; color: string; label: string; sub: string }[];
  pills?: { glyph: string; label: string }[];
  killNote?: string;
  loopNote?: string;
  emphasis?: boolean;
  logbook?: boolean;
}

/**
 * The Flow tab: a static "how the fleet works" explainer — an assembly line of
 * inspectors, work in one end, killed or shipped at the other. Pure narrative
 * (no ledger data), so nothing here is escaped-from-user or windowed. Ported
 * from the design minus its live-flight animation (which needs a backend).
 */
const FLOW_STATIONS: FlowStation[] = [
  {
    n: "1",
    accent: "#D8DEE9",
    tag: "the task",
    title: "Write down the job",
    body: "A short description of what needs doing — and, importantly, a hard boundary: “you may only change these specific things.” That boundary is what every inspector measures against later.",
  },
  {
    n: "2",
    accent: "#88C0D0",
    tag: "dispatch",
    title: "Hand it off",
    body: "Choose where the task runs. It can run quietly on your own machine, or fan out across several projects at once — one worker per project.",
    chips: [
      { glyph: "›_", color: "#A3BE8C", label: "Local machine", sub: "runs on your box, in an isolated worktree" },
      { glyph: "⎇", color: "#88C0D0", label: "GitHub Flow", sub: "fans out on Actions — one worker per repo" },
    ],
  },
  {
    n: "3",
    accent: "#EBCB8B",
    tag: "sandbox",
    title: "The worker gets a sealed room",
    body: "It’s handed a private copy of the project to work in — and that’s all. It can only ever suggest changes; it can never push them out into the world on its own.",
    pills: [
      { glyph: "⦸", label: "no internet access" },
      { glyph: "⇧", label: "cannot publish or push" },
    ],
  },
  {
    n: "4",
    accent: "#8FBCBB",
    tag: "draft the diff",
    title: "The assistant does the work",
    body: "It makes the change the job asked for and checks its own work until everything looks right. If the job turns out to be unnecessary, it’s expected to say so and leave everything untouched.",
  },
  {
    n: "5",
    accent: "#D08770",
    tag: "inspector 1",
    title: "Did you stay in your lane?",
    body: "The system compares what was actually changed against the boundary set in step 1.",
    killNote: "Touch anything you weren’t allowed to → thrown out on the spot.",
  },
  {
    n: "6",
    accent: "#81A1C1",
    tag: "inspector 2",
    title: "Does it actually work?",
    body: "The project’s own tests, build and checks are run independently — not the ones the assistant claims to have run.",
    killNote: "Anything broken → rejected before a person ever sees it.",
  },
  {
    n: "7",
    accent: "#B48EAD",
    tag: "inspector 3",
    title: "A senior reviewer reads it",
    body: "A separate, more capable reviewer reads the whole change and decides: good to go, or send it back.",
    killNote: "Vetoed → the work is thrown out.",
    loopNote:
      "Sent back → the original assistant gets the feedback and retries — a couple of rounds — before finally giving up.",
  },
  {
    n: "8",
    accent: "#A3BE8C",
    tag: "the merge button",
    title: "A finished proposal lands on a desk",
    emphasis: true,
    body: "Only work that cleared every inspector reaches a person — as a clear write-up: what changed, why, what was deliberately left alone, who checked it, and how to undo it in one click. The person gives the final yes.",
  },
  {
    n: "9",
    accent: "#D8DEE9",
    tag: "the logbook",
    title: "Everything is written down",
    logbook: true,
    body: "Every run is recorded with its reason — the ones that shipped and the ones that were thrown out. The rejects matter as much as the successes: they’re the proof the successes were actually earned.",
  },
];

const FLOW_RULES = [
  {
    glyph: "⇧",
    color: C.yellow,
    title: "Propose, never publish",
    body: "The assistant can only suggest changes. So a rejected piece of work simply vanishes — there’s nothing to clean up.",
  },
  {
    glyph: "⛒",
    color: C.red,
    title: "Any inspector can stop it",
    body: "Every gate can kill bad work before a human sees it. So people approve finished, checked work — they don’t babysit a rough draft.",
  },
];

function renderFlowTab(): string {
  const stations = FLOW_STATIONS.map((s, i) => {
    const hasNext = i < FLOW_STATIONS.length - 1;
    const connector = hasNext
      ? `<div style="flex:1;width:3px;margin:6px 0;border-radius:2px;background:repeating-linear-gradient(180deg,rgba(136,192,208,0.7) 0 6px,transparent 6px 14px);background-size:100% 16px;animation:flowDash 1.1s linear infinite;min-height:26px"></div>`
      : "";
    const chips = s.chips
      ? `<div style="display:flex;gap:10px;margin-top:13px;flex-wrap:wrap">${s.chips
          .map(
            (c) => `<div style="flex:1;min-width:200px;display:flex;align-items:center;gap:11px;background:${C.bg};border:1px solid rgba(236,239,244,0.1);border-radius:7px;padding:10px 12px">
              <span style="width:28px;height:28px;flex:none;border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:13px;color:${c.color};background:rgba(236,239,244,0.05);border:1px solid rgba(236,239,244,0.1)">${esc(c.glyph)}</span>
              <div style="min-width:0"><div style="font-size:12.5px;font-weight:600;color:${C.text}">${esc(c.label)}</div><div style="font-size:11px;color:rgba(216,222,233,0.55);margin-top:2px">${esc(c.sub)}</div></div>
            </div>`,
          )
          .join("")}</div>`
      : "";
    const pills = s.pills
      ? `<div style="display:flex;gap:9px;margin-top:13px;flex-wrap:wrap">${s.pills
          .map(
            (p) => `<span style="display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11.5px;color:${C.yellow};background:rgba(235,203,139,0.1);border:1px dashed rgba(235,203,139,0.45);border-radius:20px;padding:6px 13px"><span style="font-size:13px">${esc(p.glyph)}</span>${esc(p.label)}</span>`,
          )
          .join("")}</div>`
      : "";
    const killNote = s.killNote
      ? `<div style="display:flex;align-items:flex-start;gap:9px;margin-top:13px;background:rgba(191,97,106,0.09);border:1px solid rgba(191,97,106,0.32);border-radius:7px;padding:9px 12px">
          <span style="color:${C.red};font-family:var(--mono);font-size:12px;font-weight:700;flex:none;margin-top:1px">↳ ✗</span>
          <span style="font-size:12px;color:#E5A5AB;line-height:1.45">${esc(s.killNote)}</span>
        </div>`
      : "";
    const loopNote = s.loopNote
      ? `<div style="display:flex;align-items:flex-start;gap:9px;margin-top:9px;background:rgba(180,142,173,0.09);border:1px solid rgba(180,142,173,0.32);border-radius:7px;padding:9px 12px">
          <span style="color:${C.purple};font-family:var(--mono);font-size:13px;font-weight:700;flex:none;margin-top:-1px">↺</span>
          <span style="font-size:12px;color:#CBB4C6;line-height:1.45">${esc(s.loopNote)}</span>
        </div>`
      : "";
    const emphasis = s.emphasis
      ? `<div style="display:flex;align-items:center;gap:9px;margin-top:13px;background:rgba(163,190,140,0.1);border:1px solid rgba(163,190,140,0.35);border-radius:7px;padding:9px 12px">
          <span style="color:${C.green};font-size:13px;font-weight:700;flex:none">✓</span>
          <span style="font-size:12px;color:#C3D2AF;line-height:1.45">This is the only work a person is ever asked to approve.</span>
        </div>`
      : "";
    const logbook = s.logbook
      ? `<div style="display:flex;align-items:center;gap:9px;margin-top:13px;font-family:var(--mono);font-size:11.5px;color:rgba(216,222,233,0.6)">
          <span style="width:7px;height:7px;background:${C.green};border-radius:50%;display:inline-block"></span>shipped
          <span style="width:7px;height:7px;background:${C.red};border-radius:50%;display:inline-block;margin-left:8px"></span>thrown out
          <span style="margin-left:8px">— both live in the Ledger, with a reason.</span>
        </div>`
      : "";
    return `<div style="display:flex;gap:18px;align-items:stretch">
        <div style="width:44px;flex:none;display:flex;flex-direction:column;align-items:center">
          <div style="width:40px;height:40px;flex:none;border-radius:50%;border:2px solid ${s.accent};background:${C.panel2};display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:15px;font-weight:600;color:${s.accent}">${esc(s.n)}</div>
          ${connector}
        </div>
        <div style="flex:1;min-width:0;padding-bottom:20px">
          <div style="background:${C.panel};border:1px solid rgba(236,239,244,0.09);border-left:3px solid ${s.accent};border-radius:8px;padding:15px 18px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:7px">
              <div style="font-size:15px;font-weight:600;color:${C.text};line-height:1.3">${esc(s.title)}</div>
              <span style="font-family:var(--mono);font-size:9.5px;letter-spacing:0.09em;text-transform:uppercase;color:${s.accent};background:rgba(236,239,244,0.05);border:1px solid rgba(236,239,244,0.1);padding:3px 8px;border-radius:20px;white-space:nowrap;flex:none">${esc(s.tag)}</span>
            </div>
            <div style="font-size:12.5px;color:rgba(216,222,233,0.72);line-height:1.55">${esc(s.body)}</div>
            ${chips}${pills}${killNote}${loopNote}${emphasis}${logbook}
          </div>
        </div>
      </div>`;
  }).join("");

  const rules = FLOW_RULES.map(
    (r) => `<div style="flex:1;min-width:250px;background:${C.panel2};border:1px solid rgba(236,239,244,0.1);border-radius:9px;padding:17px 19px">
      <div style="display:flex;align-items:center;gap:11px;margin-bottom:9px">
        <span style="width:32px;height:32px;flex:none;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:15px;color:${r.color};background:rgba(236,239,244,0.05);border:1px solid rgba(236,239,244,0.12)">${esc(r.glyph)}</span>
        <span style="font-size:13.5px;font-weight:600;color:${C.text}">${esc(r.title)}</span>
      </div>
      <div style="font-size:12px;color:rgba(216,222,233,0.65);line-height:1.55">${esc(r.body)}</div>
    </div>`,
  ).join("");

  return `<div style="padding:32px 34px 60px">
    <div style="max-width:860px;margin:0 auto">
      <div style="font-size:13px;color:${C.dim};margin-bottom:4px">How the fleet works · the path of one dispatched task</div>
      <div style="font-size:20px;font-weight:600;color:${C.text};line-height:1.35;margin-bottom:10px">An assembly line of inspectors. Work goes in one end; at every station an inspector can stop it and throw it out — noting exactly why.</div>
      <div style="font-size:13px;color:rgba(216,222,233,0.62);line-height:1.55;margin-bottom:28px">By the time anything reaches a person it has already proven itself. The person isn’t hunting for mistakes — they’re giving a final nod to something that’s already been checked.</div>
      <div style="display:flex;align-items:center;gap:20px;margin-bottom:26px;flex-wrap:wrap;font-family:var(--mono);font-size:11px;color:rgba(216,222,233,0.6)">
        <span style="display:flex;align-items:center;gap:8px"><span style="width:22px;height:2px;background:${C.frost};display:inline-block;border-radius:1px"></span>work moves down the line</span>
        <span style="display:flex;align-items:center;gap:8px"><span style="color:${C.red};font-weight:700">↳ ✗</span>an inspector kills it → logged</span>
        <span style="display:flex;align-items:center;gap:8px"><span style="color:${C.purple};font-weight:700">↺</span>sent back to retry</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:0">${stations}</div>
      <div style="font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:${C.dim};margin:14px 0 14px 62px">The two rules that make it trustworthy</div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-left:62px">${rules}</div>
    </div>
  </div>`;
}

interface ReasonBar {
  label: string;
  count: number;
  color: string;
}

interface TaskOffender {
  task: string;
  repo: string;
  title: string;
  kills: number;
  domStage: string;
  domStageCount: number;
}

/** Aggregate windowed kills into by-reason bars and by-task repeat offenders. */
function computePatterns(kills: LedgerEntry[]): { byReason: ReasonBar[]; byTask: TaskOffender[] } {
  const reasonCounts = new Map<string, { count: number; status: string }>();
  for (const k of kills) {
    const label = k.reason ?? "(no reason recorded)";
    const cur = reasonCounts.get(label);
    if (cur) cur.count += 1;
    else reasonCounts.set(label, { count: 1, status: k.status });
  }
  const byReason = [...reasonCounts.entries()]
    .map(([label, v]) => ({ label, count: v.count, color: verdictFor(v.status).color }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const taskAgg = new Map<
    string,
    { task: string; repo: string; title: string; kills: number; stages: Map<string, number> }
  >();
  for (const k of kills) {
    let agg = taskAgg.get(k.task);
    if (!agg) {
      agg = { task: k.task, repo: k.repo, title: k.title ?? k.task, kills: 0, stages: new Map() };
      taskAgg.set(k.task, agg);
    }
    agg.kills += 1;
    const stage = verdictFor(k.status).stage ?? "other";
    agg.stages.set(stage, (agg.stages.get(stage) ?? 0) + 1);
  }
  const byTask = [...taskAgg.values()]
    .map((a) => {
      const [domStage, domStageCount] = [...a.stages.entries()].sort((x, y) => y[1] - x[1])[0];
      return { task: a.task, repo: a.repo, title: a.title, kills: a.kills, domStage, domStageCount };
    })
    .sort((a, b) => b.kills - a.kills)
    .slice(0, 6);

  return { byReason, byTask };
}

/**
 * The flagged-for-review banner text — computed from real data, or undefined
 * when nothing stands out. Fires when one task is killed ≥3× in the window and
 * a single gate accounts for at least half of those kills.
 */
function patternsFlag(byTask: TaskOffender[], kills: LedgerEntry[]): string | undefined {
  const top = byTask[0];
  if (!top || top.kills < 3 || top.domStageCount * 2 < top.kills) return undefined;
  const topReason = topReasonFor(
    kills.filter((k) => k.task === top.task),
    kills.find((k) => k.task === top.task && (verdictFor(k.status).stage ?? "other") === top.domStage)?.status ?? "",
  );
  const reasonClause = topReason ? ` (top reason: “${topReason}”)` : "";
  return `${top.task} (${top.title}) was killed ${top.kills}× in this window — ${top.domStageCount} of them at the ${top.domStage} gate${reasonClause}. Repeated kills at one gate usually mean the task prompt or that gate's constraint needs tightening.`;
}

function renderPatternsTab(
  p: { byReason: ReasonBar[]; byTask: TaskOffender[]; flag?: string },
  killedTotal: number,
  days: number,
): string {
  if (killedTotal === 0) {
    return `<div style="padding:30px 34px"><div style="max-width:1180px;margin:0 auto;font-family:var(--mono);font-size:12px;color:${C.gray}">No kills in the last ${days} days — nothing to pattern-match.</div></div>`;
  }
  const maxReason = Math.max(1, ...p.byReason.map((r) => r.count));
  const reasonBars = p.byReason
    .map(
      (r) => `<div style="margin-bottom:13px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
          <span style="font-size:12.5px;color:${C.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%">${esc(r.label)}</span>
          <span style="font-family:var(--mono);font-size:11.5px;color:rgba(216,222,233,0.55)">${r.count} · ${Math.round((r.count / killedTotal) * 100)}%</span>
        </div>
        <div style="height:6px;background:${C.panel};border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${(r.count / maxReason) * 100}%;background:${r.color};border-radius:3px"></div>
        </div>
      </div>`,
    )
    .join("");

  const flagged = new Set(p.flag ? [p.byTask[0]?.task] : []);
  const taskCards = p.byTask
    .map((t) => {
      const isFlagged = flagged.has(t.task);
      const accent = isFlagged ? C.red : "rgba(216,222,233,0.6)";
      const bg = isFlagged ? "rgba(191,97,106,0.09)" : C.panel;
      const border = isFlagged ? "rgba(191,97,106,0.35)" : "rgba(236,239,244,0.09)";
      return `<div data-task="${esc(t.task)}" onclick="jumpToTask('${esc(t.task)}')" style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:${bg};border:1px solid ${border};border-radius:7px;margin-bottom:9px;cursor:pointer">
        <div style="min-width:0">
          <div style="font-family:var(--mono);font-size:11px;color:${accent};margin-bottom:2px">${esc(t.task)} · ${esc(t.repo)}</div>
          <div style="font-size:12.5px;color:${C.muted};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</div>
          <div style="font-size:11px;color:rgba(216,222,233,0.5);margin-top:3px">mostly at ${esc(t.domStage)} (${t.domStageCount})</div>
        </div>
        <div style="text-align:right;flex:none;padding-left:14px">
          <div style="font-family:var(--mono);font-size:18px;font-weight:600;color:${accent};line-height:1">${t.kills}</div>
          <div style="font-size:10px;color:rgba(216,222,233,0.5);margin-top:2px">kills</div>
        </div>
      </div>`;
    })
    .join("");

  const flagBanner = p.flag
    ? `<div style="background:rgba(191,97,106,0.09);border:1px solid rgba(191,97,106,0.35);border-radius:8px;padding:16px 20px;margin-bottom:26px;display:flex;gap:14px;align-items:flex-start">
        <span style="color:${C.red};font-size:15px;line-height:1.4">⚑</span>
        <div>
          <div style="font-size:13px;font-weight:600;color:${C.text};margin-bottom:4px">Flagged for prompt/verifier review</div>
          <div style="font-size:12.5px;color:rgba(216,222,233,0.7);line-height:1.5">${esc(p.flag)}</div>
        </div>
      </div>`
    : "";

  return `<div style="padding:30px 34px">
    <div style="max-width:1180px;margin:0 auto">
      ${flagBanner}
      <div style="display:grid;grid-template-columns:1.15fr 1fr;gap:26px;align-items:start">
        <div>
          <div style="font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:${C.dim};margin-bottom:14px">Kills by reason</div>
          ${reasonBars}
        </div>
        <div>
          <div style="font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:${C.dim};margin-bottom:14px">Repeat offenders · by task</div>
          ${taskCards}
        </div>
      </div>
    </div>
  </div>`;
}

/**
 * The time-window scrubber: a per-day histogram of run counts under two range
 * sliders that narrow which ledger rows are visible. Client-side only (like the
 * search/verdict/repo filters) — it narrows the table, not the server-computed
 * chips/funnel/patterns, so it's shown on the Ledger tab alone.
 */
function renderScrubber(windowed: LedgerEntry[], days: number, now: Date): string {
  const counts = Array.from({ length: days }, () => 0);
  for (const e of windowed) {
    const i = dayIndex(e.ts, now, days);
    if (i >= 0 && i < days) counts[i] += 1;
  }
  const maxB = Math.max(1, ...counts);
  const bars = counts
    .map(
      (c, i) => `<div data-b="${i}" style="flex:1;height:${Math.round(4 + (c / maxB) * 28)}px;background:${C.blue};border-radius:2px 2px 0 0"></div>`,
    )
    .join("");
  const dayMs = 24 * 60 * 60 * 1000;
  const todayUtc = Math.floor(now.getTime() / dayMs);
  const labels = Array.from({ length: days }, (_, i) =>
    new Date((todayUtc - (days - 1 - i)) * dayMs).toISOString().slice(5, 10),
  );
  return `<div id="scrub" style="display:flex;align-items:center;gap:16px;padding:10px 22px;background:${C.panel2};border-bottom:1px solid rgba(236,239,244,0.07)">
    <div style="font-size:10.5px;letter-spacing:0.09em;text-transform:uppercase;color:${C.dim};width:64px;flex:none">Window</div>
    <span id="tFrom" style="font-family:var(--mono);font-size:11.5px;color:${C.frost};width:44px;flex:none;text-align:right">${esc(labels[0])}</span>
    <div style="flex:1;position:relative;height:38px;display:flex;align-items:flex-end;gap:2px;padding:0 4px">
      ${bars}
      <input data-scrub="1" id="scrubFrom" type="range" min="0" max="${days - 1}" step="1" value="0" />
      <input data-scrub="1" id="scrubTo" type="range" min="0" max="${days - 1}" step="1" value="${days - 1}" />
    </div>
    <span id="tTo" style="font-family:var(--mono);font-size:11.5px;color:${C.frost};width:44px;flex:none">${esc(labels[days - 1])}</span>
    <button id="scrubReset" style="background:transparent;border:1px solid rgba(236,239,244,0.14);color:${C.dim};font-size:11px;padding:5px 10px;border-radius:5px;cursor:pointer;flex:none">full window</button>
  </div>
  <script>window.DAY_LABELS=${JSON.stringify(labels)};</script>`;
}

/** The "Dispatched to" card in the drawer — where the run executed, from `mode`. */
function dispatchCard(e: LedgerEntry): string {
  const isCloud = e.mode === "cloud";
  const glyph = isCloud ? "⎇" : "›_";
  const color = isCloud ? C.frost : C.green;
  const label = isCloud ? "GitHub Flow" : "Local machine";
  const line1 = esc(e.repo);
  const line2 = isCloud
    ? e.prUrl
      ? `<a href="${esc(e.prUrl)}" style="color:${C.frost};text-decoration:none">${esc(prCell(e.prUrl).replace(/<[^>]+>/g, ""))} — pull request ↗</a>`
      : "no PR opened"
    : "isolated worktree · nothing pushed by the run itself";
  return `<div style="display:flex;gap:12px;align-items:center;background:${C.panel};border:1px solid rgba(236,239,244,0.1);border-radius:8px;padding:12px 14px;margin-bottom:24px">
    <span style="width:34px;height:34px;border-radius:7px;background:${hexA(color, 0.14)};border:1px solid ${hexA(color, 0.45)};display:flex;align-items:center;justify-content:center;color:${color};font-family:var(--mono);font-size:14px;flex:none">${glyph}</span>
    <div style="min-width:0">
      <div style="font-size:12.5px;font-weight:600;color:${C.text}">Dispatched to ${esc(label)}</div>
      <div style="font-family:var(--mono);font-size:11px;color:rgba(216,222,233,0.6);margin-top:3px">${line1}</div>
      <div style="font-family:var(--mono);font-size:11px;color:rgba(216,222,233,0.5)">${line2}</div>
    </div>
  </div>`;
}

/** The slide-over detail for one run — trace, evidence, what we do and don't record. */
function renderDrawer(e: LedgerEntry, idx: number, cosign?: Cosign): string {
  const v = verdictFor(e.status);
  const title = e.title ?? e.task;
  const meta = [e.task, e.repo, e.mode, e.ts.replace("T", " ").slice(0, 16)].join(" · ");
  const reasonBox = e.reason
    ? `<div style="background:${hexA(v.color, 0.09)};border:1px solid ${hexA(v.color, 0.35)};border-radius:8px;padding:15px 17px;margin-bottom:24px">
        <div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:${C.dim};margin-bottom:7px">Reason on record</div>
        <div style="font-size:14px;color:${C.text};line-height:1.45;font-weight:500">${esc(e.reason)}</div>
      </div>`
    : "";
  const evidence =
    e.evidence && e.evidence.length > 0
      ? `<div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:${C.dim};margin-bottom:10px">Evidence on record</div>
        <div style="background:#272C36;border:1px solid rgba(236,239,244,0.08);border-radius:8px;overflow:hidden;margin-bottom:24px;padding:11px 0">
          ${e.evidence.map((ln) => `<div style="${evLineStyle(ln)}">${esc(ln)}</div>`).join("")}
        </div>`
      : "";
  const prLine = e.prUrl
    ? `<div style="margin-top:6px"><a href="${esc(e.prUrl)}" style="color:${C.frost};text-decoration:none;font-family:var(--mono);font-size:12px">${esc(prCell(e.prUrl).replace(/<[^>]+>/g, ""))} — open the pull request ↗</a></div>`
    : "";
  const footNote =
    v.kind === "shipped"
      ? "Survived the filter — your read is the last gate."
      : v.kind === "killed"
        ? "Killed by the fleet. You never had to spend attention on it."
        : "Not a verdict on the change.";

  return `<div id="drawer-${idx}" class="drawer" style="position:fixed;inset:0;z-index:40;display:none;justify-content:flex-end">
    <div class="drawer-scrim" data-close style="position:absolute;inset:0;background:rgba(20,23,30,0.6)"></div>
    <div style="position:relative;width:540px;max-width:92vw;height:100%;background:${C.panel2};border-left:1px solid rgba(236,239,244,0.12);box-shadow:-24px 0 60px rgba(0,0,0,0.45);display:flex;flex-direction:column">
      <div style="padding:18px 22px 16px;border-bottom:1px solid rgba(236,239,244,0.09);flex:none">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
              <span style="font-family:var(--mono);font-size:12px;color:rgba(216,222,233,0.6)">${e.sha ? esc(e.sha) : "no commit"}</span>
              ${badge(v)}
            </div>
            <div style="font-size:15px;font-weight:600;color:${C.text};line-height:1.3">${esc(title)}</div>
            <div style="font-family:var(--mono);font-size:11px;color:${C.dim};margin-top:5px">${esc(meta)}</div>
          </div>
          <button data-close style="background:transparent;border:1px solid rgba(236,239,244,0.14);color:${C.dim};width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:14px;flex:none;line-height:1">✕</button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:20px 22px 40px">
        ${reasonBox}
        ${dispatchCard(e)}
        <div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:${C.dim};margin-bottom:12px">Pipeline trace${e.elapsedMs != null ? ` · ${fmtDur(e.elapsedMs)} total` : ""}</div>
        <div style="margin-bottom:24px">${renderTimeline(e, cosign)}</div>
        ${evidence}
        ${prLine}
      </div>
      <div style="padding:14px 22px;border-top:1px solid rgba(236,239,244,0.09);flex:none;background:${C.bg}">
        <div style="font-size:11.5px;color:rgba(216,222,233,0.6);margin-bottom:6px">${esc(footNote)}</div>
        <div style="font-family:var(--mono);font-size:10.5px;color:${C.gray};line-height:1.6">Timings and evidence are what the runner recorded to the ledger. The task prompt and full diff live in artifacts/ (gitignored, latest-run-wins) — not in this record.</div>
      </div>
    </div>
  </div>`;
}

/**
 * The SSE endpoint the live server exposes and the injected client script
 * subscribes to. Exported so the two can't drift (see `ledger-serve.ts`).
 */
export const LEDGER_EVENTS_PATH = "/events";

export interface RenderOptions {
  days?: number;
  now?: Date;
  /** Stamped into the header; defaults to `now`. */
  generatedAt?: Date;
  /**
   * Live co-sign state per PR URL (see `Cosign`). Supplied by the caller —
   * `fleet report --html --cosign` fetches it via gh; when absent the report
   * shows "shipped for review" and claims nothing about merges.
   */
  cosigns?: Record<string, Cosign>;
  /**
   * Inject the live-reload client script (only `fleet report --serve` sets this).
   * When falsy the output is byte-identical to the static report — the committed
   * `fleet report --html` path and the after-run regenerate never carry it.
   */
  liveReload?: boolean;
}

export function renderLedgerHtml(entries: LedgerEntry[], opts: RenderOptions = {}): string {
  const days = opts.days ?? 30;
  const now = opts.now ?? new Date();
  const generatedAt = opts.generatedAt ?? now;
  const record = fleetRecord(entries, { days, now });

  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const windowed = entries
    .filter((e) => Date.parse(e.ts) >= cutoff)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

  const dispatched = windowed.length;
  const decided = record.shipped + record.killed;
  const killRate = decided > 0 ? Math.round((record.killed / decided) * 100) : null;

  // The co-sign chip only exists when live state was fetched: merged count
  // over shipped count, of the shipped runs whose PR state we actually know.
  const cosigns = opts.cosigns ?? {};
  const shippedWithPr = windowed.filter((e) => e.status === "approved" && e.prUrl && cosigns[e.prUrl]);
  const cosigned = shippedWithPr.filter((e) => cosigns[e.prUrl as string].state === "merged").length;

  const chips = [
    chip("Dispatched", String(dispatched), C.text),
    chip("Killed pre-review", String(record.killed), C.red),
    chip("Shipped for review", String(record.shipped), C.green),
    ...(shippedWithPr.length > 0
      ? [chip("Co-signed", `${cosigned}/${shippedWithPr.length}`, C.green, "merged by a human")]
      : []),
    chip("Infra · neutral", `${record.infra + record.neutral}`, C.dim, "not verdicts"),
    chip("Kill rate", killRate === null ? "—" : `${killRate}%`, C.red, "of decided"),
  ].join("");

  // Funnel — real pipeline order: agent → scope → verify → judge → shipped.
  let passed = decided;
  const stages: FunnelStage[] = [];
  const step = (label: string, sub: string, color: string, killCount: number, status: string) => {
    passed -= killCount;
    stages.push({
      label,
      sub,
      color,
      passed,
      killCount,
      topReason: killCount > 0 ? topReasonFor(record.kills, status) : undefined,
    });
  };
  step("Agent", "produced a diff", C.red, record.agentFailures, "agent-failed");
  step("Scope gate", "declared-scope check", C.orange, record.scopeViolations, "scope-violation");
  step("Verify", "build · test · lint", C.blue, record.verifyFailures, "verify-failed");
  step("Judge", "LLM diff review", C.purple, record.judgeVetoes, "vetoed");
  stages.push({ label: "Shipped for review", sub: "opened as a PR", color: C.green, passed: record.shipped, killCount: 0 });
  const funnelNote = `${record.infra} infra (engine failures — not a verdict) · ${record.neutral} no-change (preconditions correctly not met) — excluded from the funnel.`;
  const funnel = renderFunnel(stages, decided, funnelNote);

  // Trend tab — the last 14 UTC days, plus the co-sign fraction over the 14-day
  // window when live state was fetched (mirrors the header chip's discipline).
  const trendDays = computeTrendDays(entries, now, 14);
  const trendCutoff = now.getTime() - 14 * 24 * 60 * 60 * 1000;
  const trendShippedWithPr = entries.filter(
    (e) => Date.parse(e.ts) >= trendCutoff && e.status === "approved" && e.prUrl && cosigns[e.prUrl],
  );
  const trendCosign =
    trendShippedWithPr.length > 0
      ? {
          merged: trendShippedWithPr.filter((e) => cosigns[e.prUrl as string].state === "merged").length,
          known: trendShippedWithPr.length,
        }
      : null;
  const trendTab = renderTrendTab(trendDays, trendCosign);

  // Patterns tab — aggregate the windowed kills by reason and by task.
  const patterns = computePatterns(record.kills);
  const flag = patternsFlag(patterns.byTask, record.kills);
  const patternsTab = renderPatternsTab({ ...patterns, flag }, record.killed, days);

  // Repo filter — the distinct repos present in the window.
  const repos = [...new Set(windowed.map((e) => e.repo))].sort();
  const repoFilterOpts = [
    `<option value="all">All repos</option>`,
    ...repos.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`),
  ].join("");

  // The scrubber only makes sense with ≥2 day-buckets to slide between.
  const showScrubber = Number.isFinite(days) && days >= 2;
  const scrubber = showScrubber ? renderScrubber(windowed, days, now) : "";

  // Ledger rows — each opens a detail drawer on click.
  const drawers: string[] = [];
  const rows =
    windowed
      .map((e, idx) => {
        const v = verdictFor(e.status);
        const cosign = e.prUrl ? cosigns[e.prUrl] : undefined;
        const day = e.ts.slice(0, 10);
        const time = e.ts.slice(11, 16);
        const title = e.title ?? e.task;
        const hay = `${e.task} ${title} ${e.repo} ${e.status} ${v.label} ${e.reason ?? ""} ${e.mode} ${e.sha ?? ""}`.toLowerCase();
        drawers.push(renderDrawer(e, idx, cosign));
        return `<tr data-status="${esc(e.status)}" data-repo="${esc(e.repo)}" data-day="${dayIndex(e.ts, now, days)}" data-search="${esc(hay)}" onclick="openDrawer(${idx})" style="border-bottom:1px solid rgba(236,239,244,0.05);cursor:pointer">
            <td style="padding:11px 22px;font-family:var(--mono);font-size:11px;color:rgba(216,222,233,0.55);white-space:nowrap">${day} ${time}<div style="color:${C.gray};font-size:10px">${esc(e.mode)}</div></td>
            <td style="padding:11px 22px;font-family:var(--mono);font-size:11px;color:rgba(216,222,233,0.6)">${e.sha ? esc(e.sha) : `<span style="color:${C.gray}">—</span>`}</td>
            <td style="padding:11px 22px;max-width:340px">
              <div style="color:${C.muted};font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</div>
              <div style="font-family:var(--mono);font-size:10.5px;color:${C.gray};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.task)} · ${esc(e.repo)}</div>
            </td>
            <td style="padding:11px 22px">${badge(v)}</td>
            <td style="padding:11px 22px;color:rgba(216,222,233,0.65);font-size:12px">${e.reason ? esc(e.reason) : `<span style="color:${C.gray}">—</span>`}</td>
            <td style="padding:11px 22px;font-family:var(--mono);font-size:11px;color:rgba(216,222,233,0.6);text-align:right">${fmtDur(e.elapsedMs)}</td>
            <td style="padding:11px 22px;font-family:var(--mono);font-size:11px;text-align:right" onclick="event.stopPropagation()">${prCell(e.prUrl, cosign)}</td>
          </tr>`;
      })
      .join("") ||
    `<tr><td colspan="7" style="padding:26px 22px;font-family:var(--mono);font-size:12px;color:${C.gray}">No runs in the last ${days} days.${entries.length > 0 ? " Widen the window (--days) to see older entries." : " The ledger is empty — every fleet run appends one line here."}</td></tr>`;

  const verdictFilterOpts = [
    ["all", "All verdicts"],
    ["approved", "Shipped"],
    ["vetoed", "Vetoed · judge"],
    ["verify-failed", "Killed · verify"],
    ["scope-violation", "Killed · scope"],
    ["agent-failed", "Killed · agent"],
    ["engine-failed", "Infra"],
    ["no-changes", "No-change"],
  ]
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");

  const selectStyle = `background:${C.panel};border:1px solid rgba(236,239,244,0.12);color:${C.muted};font-size:12px;padding:8px 11px;border-radius:6px;outline:none`;
  const stamp = generatedAt.toISOString().slice(0, 16).replace("T", " ");

  // Live-reload client (only under `fleet report --serve`). Subscribes to the
  // SSE stream and reloads on a `reload` message, preserving the UI state
  // (search, filters, active tab, scrubber, scroll) across the reload so a run
  // landing mid-read isn't jarring. Absent — and thus the output byte-identical
  // to the static report — when liveReload is off.
  const liveReloadScript = opts.liveReload
    ? `
<script>
  (function(){
    var KEY = 'fleetLedgerState';
    window.addEventListener('beforeunload', function(){
      try {
        var active = document.querySelector('.tab.active');
        sessionStorage.setItem(KEY, JSON.stringify({
          q: (document.getElementById('q')||{}).value || '',
          verdict: (document.getElementById('fVerdict')||{}).value || 'all',
          repo: (document.getElementById('fRepo')||{}).value || 'all',
          view: active ? active.dataset.view : 'ledger',
          from: (document.getElementById('scrubFrom')||{}).value,
          to: (document.getElementById('scrubTo')||{}).value,
          scrollY: window.scrollY
        }));
      } catch (e) {}
    });
    window.addEventListener('load', function(){
      try {
        var raw = sessionStorage.getItem(KEY);
        if (!raw) return;
        sessionStorage.removeItem(KEY);
        var s = JSON.parse(raw);
        var q = document.getElementById('q'); if (q) q.value = s.q || '';
        var fv = document.getElementById('fVerdict'); if (fv) fv.value = s.verdict || 'all';
        var fr = document.getElementById('fRepo'); if (fr) fr.value = s.repo || 'all';
        var sf = document.getElementById('scrubFrom'), st = document.getElementById('scrubTo');
        if (sf && s.from != null) sf.value = s.from;
        if (st && s.to != null) st.value = s.to;
        if (typeof showView === 'function') showView(s.view || 'ledger');
        if (typeof paintScrub === 'function') paintScrub();
        if (typeof apply === 'function') apply();
        if (s.scrollY) window.scrollTo(0, s.scrollY);
      } catch (e) {}
    });
    var backoff = 1000;
    function connect(){
      var es = new EventSource(${JSON.stringify(LEDGER_EVENTS_PATH)});
      es.onmessage = function(e){ if (e.data === 'reload') location.reload(); };
      es.onopen = function(){ backoff = 1000; };
      es.onerror = function(){ es.close(); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 10000); };
    }
    connect();
  })();
</script>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet Ledger</title>
<style>
  :root{--mono:ui-monospace,'SF Mono','IBM Plex Mono',Menlo,monospace;--sans:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:${C.bg};color:${C.text};font-family:var(--sans)}
  ::selection{background:${C.gray};color:${C.text}}
  a{color:${C.frost}}
  table{width:100%;border-collapse:collapse}
  thead th{position:sticky;top:0;background:${C.panel};text-align:left;font-size:10px;letter-spacing:0.09em;text-transform:uppercase;color:${C.dim};padding:10px 22px;border-bottom:1px solid rgba(236,239,244,0.1);z-index:2}
  thead th:last-child{text-align:right}
  tbody tr:hover{background:rgba(236,239,244,0.04)}
  .tab{background:transparent;border:none;border-bottom:2px solid transparent;color:${C.dim};font-family:var(--sans);font-size:13px;font-weight:600;padding:10px 16px;cursor:pointer}
  .tab.active{border-bottom-color:${C.frost};color:${C.text}}
  .view{display:none}
  .view.active{display:block}
  @keyframes flowDash{to{background-position:0 -16px}}
  input[data-scrub]{-webkit-appearance:none;appearance:none;background:transparent;position:absolute;inset:0;width:100%;height:100%;margin:0;pointer-events:none;z-index:3}
  input[data-scrub]::-webkit-slider-runnable-track{background:transparent}
  input[data-scrub]::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:11px;height:34px;border-radius:4px;background:${C.frost};border:2px solid ${C.bg};cursor:ew-resize;box-shadow:0 1px 4px rgba(0,0,0,0.4)}
  input[data-scrub]::-moz-range-track{background:transparent}
  input[data-scrub]::-moz-range-thumb{pointer-events:auto;width:11px;height:34px;border-radius:4px;background:${C.frost};border:2px solid ${C.bg};cursor:ew-resize}
</style>
</head>
<body>
  <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid ${C.line};background:${C.panel}">
    <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:9px">
        <span style="width:9px;height:9px;background:${C.red};border-radius:2px;display:inline-block;transform:rotate(45deg)"></span>
        <span style="font-weight:700;letter-spacing:0.14em;font-size:14px">FLEET LEDGER</span>
      </div>
      <span style="font-size:12px;color:${C.dim}">the kill log — every shipped PR is a survivor of this filter</span>
    </div>
    <div style="display:flex;align-items:center;gap:16px;font-family:var(--mono);font-size:11.5px;color:rgba(216,222,233,0.6)">
      <span>last ${days} days</span>
      <span style="color:${C.text}">${dispatched} runs · in window</span>
      <span title="generated">gen ${stamp}Z</span>
    </div>
  </div>

  <div style="display:flex;flex-wrap:wrap;align-items:flex-end;padding:0 22px;background:${C.panel};border-bottom:1px solid ${C.line}">
    ${chips}
    <div style="flex:1"></div>
    <div style="display:flex;align-items:flex-end;padding-bottom:2px">
      <button class="tab active" data-view="ledger">Ledger</button>
      <button class="tab" data-view="flow">Flow</button>
      <button class="tab" data-view="funnel">Funnel</button>
      <button class="tab" data-view="patterns">Patterns</button>
      <button class="tab" data-view="trend">Trend</button>
    </div>
  </div>

  ${scrubber}

  <div id="view-ledger" class="view active">
    <div style="display:flex;align-items:center;gap:10px;padding:11px 22px;background:${C.bg};border-bottom:1px solid rgba(236,239,244,0.06);flex-wrap:wrap">
      <div style="position:relative;display:flex;align-items:center">
        <span style="position:absolute;left:11px;color:${C.gray};font-size:12px;pointer-events:none">⌕</span>
        <input id="q" placeholder="search task, repo, reason…" style="background:${C.panel};border:1px solid rgba(236,239,244,0.12);color:${C.text};font-size:12px;padding:8px 12px 8px 30px;border-radius:6px;width:280px;outline:none;font-family:var(--mono)">
      </div>
      <select id="fVerdict" style="${selectStyle}">${verdictFilterOpts}</select>
      <select id="fRepo" style="${selectStyle}">${repoFilterOpts}</select>
      <button id="clear" style="background:transparent;border:1px solid rgba(236,239,244,0.12);color:${C.dim};font-size:11.5px;padding:8px 12px;border-radius:6px;cursor:pointer">clear</button>
      <div style="flex:1"></div>
      <div style="font-family:var(--mono);font-size:11.5px;color:${C.dim}">showing <span id="shown" style="color:${C.muted}">${windowed.length}</span> of ${windowed.length}</div>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Time</th><th>Run</th><th>Task</th><th>Verdict</th><th>Reason on record</th><th style="text-align:right">Elapsed</th><th>PR</th>
        </tr></thead>
        <tbody id="rows">${rows}</tbody>
      </table>
    </div>
  </div>

  <div id="view-flow" class="view">${renderFlowTab()}</div>

  <div id="view-funnel" class="view">
    <div style="padding:30px 34px">
      <div style="font-size:13px;color:${C.dim};margin-bottom:4px">Pipeline attrition · last ${days} days</div>
      <div style="font-size:20px;font-weight:600;margin-bottom:26px;color:${C.text}">Of ${decided} decided runs, <span style="color:${C.red}">${record.killed}</span> died before a human was asked to look.</div>
      ${funnel}
    </div>
  </div>

  <div id="view-patterns" class="view">${patternsTab}</div>

  <div id="view-trend" class="view">${trendTab}</div>

  <div style="padding:16px 22px;border-top:1px solid ${C.line};font-family:var(--mono);font-size:10.5px;color:${C.gray};line-height:1.7">
    Rendered from fleet/ledger.jsonl — real data only. Click any run for its pipeline trace and the evidence on record.
    ${Object.keys(cosigns).length > 0 ? "Co-sign states were fetched live from GitHub when this report was generated and may have moved since." : "Co-sign / merge state is not shown — generate with <span style=\"color:" + C.muted + "\">fleet report --html --cosign</span> to fetch it live from GitHub."}
  </div>

  ${drawers.join("")}

<script>
  function openDrawer(i){ var d = document.getElementById('drawer-' + i); if (d) d.style.display = 'flex'; }
  function closeDrawers(){ document.querySelectorAll('.drawer').forEach(function(d){ d.style.display = 'none'; }); }
  document.querySelectorAll('[data-close]').forEach(function(el){ el.addEventListener('click', closeDrawers); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeDrawers(); });

  var scrub = document.getElementById('scrub');
  function showView(view){
    document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active', x.dataset.view === view)});
    document.querySelectorAll('.view').forEach(function(x){x.classList.remove('active')});
    document.getElementById('view-' + view).classList.add('active');
    // The scrubber narrows only the ledger table, so it's shown on the Ledger tab alone.
    if (scrub) scrub.style.display = (view === 'ledger') ? 'flex' : 'none';
  }
  document.querySelectorAll('.tab').forEach(function(t){
    t.addEventListener('click', function(){ showView(t.dataset.view); });
  });

  var q = document.getElementById('q'), fv = document.getElementById('fVerdict'), fr = document.getElementById('fRepo'), shown = document.getElementById('shown');
  var sFrom = document.getElementById('scrubFrom'), sTo = document.getElementById('scrubTo');
  var tFrom = document.getElementById('tFrom'), tTo = document.getElementById('tTo');
  function scrubRange(){
    if (!sFrom || !sTo) return [ -Infinity, Infinity ];
    var a = +sFrom.value, b = +sTo.value;
    return [ Math.min(a, b), Math.max(a, b) ];
  }
  function apply(){
    var term = q.value.toLowerCase().trim(), verdict = fv.value, repo = fr ? fr.value : 'all', n = 0;
    var range = scrubRange();
    document.querySelectorAll('#rows tr').forEach(function(tr){
      if (!tr.dataset.search) return;
      var day = +tr.dataset.day;
      var ok = (verdict === 'all' || tr.dataset.status === verdict)
        && (repo === 'all' || tr.dataset.repo === repo)
        && (!term || tr.dataset.search.indexOf(term) !== -1)
        && (day >= range[0] && day <= range[1]);
      tr.style.display = ok ? '' : 'none';
      if (ok) n++;
    });
    shown.textContent = n;
  }
  q.addEventListener('input', apply);
  fv.addEventListener('change', apply);
  if (fr) fr.addEventListener('change', apply);

  function paintScrub(){
    if (!sFrom || !sTo) return;
    var range = scrubRange();
    document.querySelectorAll('#scrub [data-b]').forEach(function(b){
      var i = +b.dataset.b;
      b.style.background = (i >= range[0] && i <= range[1]) ? '${C.blue}' : '${C.gray}';
    });
    var labels = window.DAY_LABELS || [];
    if (tFrom) tFrom.textContent = labels[range[0]] || '';
    if (tTo) tTo.textContent = labels[range[1]] || '';
  }
  function onScrub(){ paintScrub(); apply(); }
  if (sFrom) sFrom.addEventListener('input', onScrub);
  if (sTo) sTo.addEventListener('input', onScrub);
  var scrubReset = document.getElementById('scrubReset');
  if (scrubReset) scrubReset.addEventListener('click', function(){
    if (sFrom && sTo){ sFrom.value = sFrom.min; sTo.value = sTo.max; }
    onScrub();
  });

  function jumpToTask(id){
    q.value = id;
    fv.value = 'all';
    if (fr) fr.value = 'all';
    if (sFrom && sTo){ sFrom.value = sFrom.min; sTo.value = sTo.max; paintScrub(); }
    showView('ledger');
    apply();
  }
  window.jumpToTask = jumpToTask;

  document.getElementById('clear').addEventListener('click', function(){
    q.value=''; fv.value='all'; if (fr) fr.value='all';
    if (sFrom && sTo){ sFrom.value = sFrom.min; sTo.value = sTo.max; paintScrub(); }
    apply();
  });
</script>${liveReloadScript}
</body>
</html>
`;
}

/**
 * The canonical rendered-report path — shared by `fleet report --html` and the
 * runner's regenerate-on-run so both write the same file. Lives under
 * artifacts/ (gitignored, latest-run-wins), matching `fleet report`'s default.
 */
export function defaultLedgerHtmlPath(controlRepo: string): string {
  return path.join(controlRepo, "artifacts", "ledger.html");
}

/**
 * Read the ledger and (re)render the HTML report to `outPath`, returning the
 * number of entries rendered. The single place that turns ledger data into the
 * report file, so the CLI command and the after-every-run regeneration can't
 * drift apart.
 */
export function writeLedgerHtml(ledgerPath: string, outPath: string, opts: RenderOptions = {}): number {
  const entries = readLedger(ledgerPath);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderLedgerHtml(entries, opts));
  return entries.length;
}
