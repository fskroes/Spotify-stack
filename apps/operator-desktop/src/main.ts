import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  AlertCircle,
  Cable,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleStop,
  Clock3,
  createIcons,
  FileCode2,
  FileDiff,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  ListFilter,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  WifiOff,
  X,
  XCircle,
} from "lucide";
import { fleetRevision, ledgerRefreshDecision, refreshedLedgerUrl } from "./ledger-refresh";
import { parsePatch, type DiffFile, type ParsedDiff } from "./diff-parser";
import "./styles.css";

interface HostProfile {
  id: string;
  name: string;
  sshTarget: string;
  remoteRepoPath: string;
  remoteCommandPrefix: string;
  remotePort: number;
  preferredLocalPort: number | null;
}

interface ConnectionStatus {
  profileId: string | null;
  state: "disconnected" | "connected" | "stale";
  localPort: number | null;
  url: string | null;
  command: string | null;
  exitStatus: number | null;
  outputTail: string;
  startedAt: number | null;
}

interface RemoteCommandResult {
  command: string;
  exitStatus: number;
  stdoutTail: string;
  stderrTail: string;
  timestamp: number;
}

interface Catalog {
  tasks: Array<{ id: string; title: string; targets: string[]; risk: string }>;
  repos: Array<{ name: string; language: string; defaultBranch: string }>;
}

interface LedgerEntry {
  ts: string;
  runId?: string;
  task: string;
  repo: string;
  status: string;
  mode: "local" | "cloud";
  vetoes: number;
  reason?: string;
  prUrl?: string;
  title?: string;
  sha?: string;
  elapsedMs?: number;
  timings?: { agentMs: number; verifyMs: number; judgeMs: number };
  evidence?: string[];
}

interface InflightRecord {
  runId: string;
  startedAt: string;
  task: string;
  repo: string;
  title: string;
  stage: "agent" | "scope" | "verify" | "judge" | "shipping";
  attempt: number;
  stageSince: string;
}

interface ArtifactMetadata {
  name: string;
  size: number;
  modifiedAt: string;
  url: string;
  contentType: string;
}

/** Live PR merge state keyed by PR URL — present only while the serve polls GitHub (--cosign). */
interface Cosign {
  state: "open" | "merged" | "closed";
  mergedBy?: string;
  mergedAt?: string;
}

type FleetRun =
  | { kind: "completed"; key: string; sortAt: string; data: LedgerEntry }
  | { kind: "inflight"; key: string; sortAt: string; data: InflightRecord };

type QueueFilter = "all" | "attention";
type WorkspaceView = "run" | "review" | "ledger";

/** Review-tab diff, cached per run so polling never refetches a parsed patch. */
type ReviewState =
  | { runKey: string; state: "loading" }
  | { runKey: string; state: "ready"; diff: ParsedDiff }
  | { runKey: string; state: "error"; message: string };

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="workbench">
    <aside class="queue-pane">
      <header class="product-header">
        <div class="product-mark">F</div>
        <div class="product-name"><strong>Fleet Operator</strong><span>Runner control</span></div>
        <button id="profile-settings" class="icon-button" title="Edit host profile" aria-label="Edit host profile"><i data-lucide="settings"></i></button>
      </header>

      <div class="connection-bar">
        <span id="status-dot" class="status-dot"></span>
        <select id="profile-select" aria-label="Host profile"></select>
        <button id="connect" class="icon-button" title="Connect runner" aria-label="Connect runner"><i data-lucide="cable"></i></button>
        <button id="disconnect" class="icon-button" title="Disconnect runner" aria-label="Disconnect runner" hidden><i data-lucide="circle-stop"></i></button>
      </div>

      <nav class="queue-filters" aria-label="Run filters">
        <button class="queue-filter active" data-filter="all"><span>All runs</span><b id="all-count">0</b></button>
        <button class="queue-filter" data-filter="attention"><span>Needs attention</span><b id="attention-count">0</b></button>
      </nav>

      <div class="queue-heading">
        <span>Runs</span>
        <button id="refresh-runs" class="icon-button" title="Refresh runs" aria-label="Refresh runs"><i data-lucide="refresh-cw"></i></button>
      </div>
      <div id="queue-list" class="queue-list"></div>

      <footer class="queue-footer">
        <div><span id="connection-label">Disconnected</span><small id="freshness-label">No runner data</small></div>
        <button id="profile-add" class="icon-button" title="Add host profile" aria-label="Add host profile"><i data-lucide="plus"></i></button>
      </footer>
    </aside>

    <main class="workspace-pane">
      <header class="workspace-header">
        <div class="workspace-identity">
          <span id="selected-repo" class="workspace-repo">Fleet</span>
          <h1 id="selected-title">Ledger</h1>
          <div id="selected-meta" class="workspace-meta">No run selected</div>
        </div>
        <div class="workspace-actions">
          <span id="selected-status" class="status-badge neutral">Idle</span>
          <button id="open-pr" class="secondary compact" hidden><i data-lucide="git-pull-request"></i>Open PR</button>
          <button id="toggle-rail" class="icon-button" title="Hide evidence panel" aria-label="Hide evidence panel"><i data-lucide="panel-right-close"></i></button>
        </div>
      </header>

      <div id="connection-banner" class="connection-banner" hidden>
        <i data-lucide="wifi-off"></i>
        <div><strong>Runner connection lost</strong><span id="stale-detail">Remote state may be out of date.</span></div>
        <button id="reconnect" class="secondary compact"><i data-lucide="refresh-cw"></i>Reconnect</button>
      </div>

      <nav class="workspace-tabs" aria-label="Workspace views">
        <button class="workspace-tab active" data-view="run"><i data-lucide="activity"></i>Run</button>
        <button class="workspace-tab" data-view="review"><i data-lucide="file-diff"></i>Review</button>
        <button class="workspace-tab" data-view="ledger"><i data-lucide="file-code-2"></i>Fleet Ledger</button>
      </nav>

      <section id="run-view" class="workspace-view">
        <div id="run-empty" class="run-empty">
          <div class="empty-glyph"><i data-lucide="shield-check"></i></div>
          <h2>No run selected</h2>
          <p>Choose a run from the queue.</p>
        </div>

        <div id="run-detail" class="run-detail" hidden>
          <section class="pipeline-section">
            <div class="section-heading"><span>Pipeline</span><small id="pipeline-summary"></small></div>
            <ol id="pipeline" class="pipeline"></ol>
          </section>

          <section class="evidence-section">
            <div class="section-heading"><span>Gate evidence</span><small id="evidence-count"></small></div>
            <div id="evidence-log" class="evidence-log"></div>
          </section>
        </div>

        <div id="artifact-preview" class="artifact-preview" hidden>
          <header><button id="close-artifact" class="icon-button" title="Back to run" aria-label="Back to run"><i data-lucide="x"></i></button><div><strong id="artifact-title"></strong><span id="artifact-subtitle"></span></div></header>
          <iframe id="artifact-frame" title="Run artifact"></iframe>
        </div>
      </section>

      <section id="review-view" class="workspace-view" hidden>
        <div id="review-content" class="review-content"></div>
      </section>

      <section id="ledger-view" class="workspace-view" hidden>
        <div id="ledger-empty" class="ledger-empty"><i data-lucide="file-code-2"></i><strong>Fleet Ledger unavailable</strong><span>Connect a runner to load the ledger.</span></div>
        <iframe id="ledger-frame" title="Remote Fleet Ledger" hidden></iframe>
      </section>

      <footer class="dispatch-bar">
        <div class="dispatch-context"><i data-lucide="rocket"></i><span>Dispatch</span></div>
        <select id="task-select" aria-label="Task" disabled><option>Connect to load tasks</option></select>
        <select id="repo-select" aria-label="Target repository" disabled><option value="">All matching repos</option></select>
        <label class="pr-toggle" title="Open a pull request on the target repo when the run is approved — untick for an artifacts-only dry run"><input id="local-run-pr" type="checkbox" checked disabled />PR</label>
        <button id="local-run" class="secondary compact" disabled title="Run on the remote runner"><i data-lucide="play"></i>Run</button>
        <button id="dispatch-action" class="primary compact" disabled><i data-lucide="rocket"></i>Dispatch</button>
      </footer>
    </main>

    <aside class="evidence-pane">
      <header class="rail-header"><strong>Evidence</strong><span id="rail-run-state">No run selected</span></header>

      <section class="rail-section details-section">
        <div class="rail-section-heading"><span>Run details</span></div>
        <dl id="run-metadata" class="metadata-list">
          <div><dt>Status</dt><dd>—</dd></div>
          <div><dt>Task</dt><dd>—</dd></div>
          <div><dt>Repository</dt><dd>—</dd></div>
          <div><dt>Started</dt><dd>—</dd></div>
        </dl>
      </section>

      <section class="rail-section artifacts-section">
        <div class="rail-section-heading"><span>Artifacts</span><b id="artifact-count">0</b></div>
        <div id="artifact-list" class="artifact-list"><div class="rail-empty">No artifacts</div></div>
      </section>

      <section class="rail-section command-section">
        <div class="rail-section-heading"><span>Command receipts</span><button id="clear-activity" class="icon-button" title="Clear receipts" aria-label="Clear receipts"><i data-lucide="trash-2"></i></button></div>
        <div id="activity-list" class="activity-list"><div class="rail-empty">No remote commands</div></div>
      </section>
    </aside>
  </div>

  <dialog id="profile-dialog">
    <form id="profile-form" method="dialog">
      <div class="dialog-head">
        <div><span class="eyebrow">Runner connection</span><h2 id="dialog-title">Host profile</h2></div>
        <button type="button" id="close-dialog" class="icon-button" title="Close" aria-label="Close"><i data-lucide="x"></i></button>
      </div>
      <input id="profile-id" type="hidden" />
      <label>Profile name<input id="profile-name" autocomplete="off" required /></label>
      <label>SSH target<input id="ssh-target" placeholder="user@runner-host" autocomplete="off" required /></label>
      <label>Remote control repo<input id="remote-repo" placeholder="/srv/spotify-stack" autocomplete="off" required /></label>
      <label>Command prefix<input id="command-prefix" class="mono" readonly /></label>
      <div class="field-row">
        <label>Remote port<input id="remote-port" type="number" min="1" max="65535" value="4173" required /></label>
        <label>Preferred local port<input id="local-port" type="number" min="1" max="65535" placeholder="Auto" /></label>
      </div>
      <div class="dialog-actions">
        <button type="button" id="delete-profile" class="danger" hidden><i data-lucide="trash-2"></i>Delete</button>
        <span></span>
        <button type="button" id="cancel-profile" class="secondary">Cancel</button>
        <button type="submit" class="primary"><i data-lucide="save"></i>Save profile</button>
      </div>
    </form>
  </dialog>

  <div id="toast" class="toast" role="status" hidden></div>
`;

createIcons({
  icons: {
    Activity, AlertCircle, Cable, Check, CheckCircle2, ChevronDown, ChevronRight, Circle,
    CircleStop, Clock3, FileCode2, FileDiff, GitPullRequest, ListFilter, LoaderCircle,
    PanelRightClose, PanelRightOpen, Play, Plus, RefreshCw, Rocket, Save, Settings,
    ShieldCheck, TerminalSquare, Trash2, WifiOff, X, XCircle,
  },
});

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const workbench = $(".workbench");
const profileSelect = $("#profile-select") as HTMLSelectElement;
const taskSelect = $("#task-select") as HTMLSelectElement;
const repoSelect = $("#repo-select") as HTMLSelectElement;
const prToggle = $("#local-run-pr") as HTMLInputElement;
const ledgerFrame = $("#ledger-frame") as HTMLIFrameElement;
const artifactFrame = $("#artifact-frame") as HTMLIFrameElement;
const profileDialog = $("#profile-dialog") as HTMLDialogElement;
const profileForm = $("#profile-form") as HTMLFormElement;
const previewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview");

let profiles: HostProfile[] = [];
let status: ConnectionStatus = disconnectedStatus();
let catalog: Catalog | null = null;
let runs: FleetRun[] = [];
let cosigns: Record<string, Cosign> = {};
let artifacts: ArtifactMetadata[] = [];
let results: RemoteCommandResult[] = [];
let selectedKey = "";
let review: ReviewState | null = null;
/** Run key whose artifact list has actually loaded — before that, an empty
 *  `artifacts` means "still fetching", not "the run recorded nothing". */
let artifactsLoadedFor = "";
let artifactPreview: { runKey: string; name: string } | null = null;
let artifactRequest = 0;
let ledgerRevision = "";
let queueFilter: QueueFilter = "all";
let workspaceView: WorkspaceView = "run";
let lastUpdated: Date | null = null;
let busy = false;

function disconnectedStatus(): ConnectionStatus {
  return { profileId: null, state: "disconnected", localPort: null, url: null, command: null, exitStatus: null, outputTail: "", startedAt: null };
}

function selectedProfile(): HostProfile | undefined {
  return profiles.find((profile) => profile.id === profileSelect.value);
}

function activeProfile(): HostProfile | undefined {
  return profiles.find((profile) => profile.id === status.profileId);
}

function selectedRun(): FleetRun | undefined {
  return runs.find((run) => run.key === selectedKey);
}

function runStatus(run: FleetRun): string {
  return run.kind === "inflight" ? run.data.stage : run.data.status;
}

function runTitle(run: FleetRun): string {
  return run.data.title || run.data.task;
}

function runRepo(run: FleetRun): string {
  return run.data.repo;
}

/** Live merge state for a run's PR, when known. Runs without a PR have none. */
function cosignFor(run: FleetRun): Cosign | undefined {
  return run.kind === "completed" && run.data.prUrl ? cosigns[run.data.prUrl] : undefined;
}

/** Everything the UI says about a PR state, in one place — the queue chip and
 *  the run-details row must never disagree. For shipped runs the decision
 *  dimension (co-sign) supersedes the pipeline dimension (approved). */
const COSIGN_CHIP: Record<Cosign["state"], { label: string; detail: string; icon: string; tone: string }> = {
  open: { label: "PR open", detail: "Open — awaiting co-sign", icon: "git-pull-request", tone: "warning" },
  merged: { label: "Merged", detail: "Merged", icon: "git-merge", tone: "success" },
  closed: { label: "Closed", detail: "Closed without merging", icon: "git-pull-request-closed", tone: "neutral" },
};

function isAttention(run: FleetRun): boolean {
  return run.kind === "completed" && ["agent-failed", "verify-failed", "vetoed", "scope-violation", "engine-failed"].includes(run.data.status);
}

function statusTone(value: string): "success" | "failure" | "working" | "warning" | "neutral" {
  if (["approved", "shipped", "merged"].includes(value)) return "success";
  if (["agent-failed", "verify-failed", "vetoed", "scope-violation"].includes(value)) return "failure";
  if (["agent", "scope", "verify", "judge", "shipping", "running"].includes(value)) return "working";
  if (value === "engine-failed") return "warning";
  return "neutral";
}

function statusLabel(value: string): string {
  const labels: Record<string, string> = {
    agent: "Agent working", scope: "Scope gate", verify: "Verifying", judge: "Judging", shipping: "Opening PR",
    approved: "Approved", "agent-failed": "Agent failed", "verify-failed": "Verify failed", vetoed: "Vetoed",
    "scope-violation": "Scope violation", "engine-failed": "Runner error", "no-changes": "No changes",
  };
  return labels[value] ?? value.replaceAll("-", " ");
}

function statusIcon(value: string): string {
  const tone = statusTone(value);
  if (tone === "success") return "check-circle-2";
  if (tone === "failure") return "x-circle";
  if (tone === "warning") return "alert-circle";
  if (tone === "working") return "loader-circle";
  return "circle";
}

function relativeTime(value: string): string {
  const delta = Date.now() - Date.parse(value);
  const minutes = Math.max(0, Math.floor(delta / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function duration(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function prefixFor(repo: string): string {
  return repo ? `cd -- ${shellQuote(repo)} && exec pnpm fleet` : "";
}

function setOptions(select: HTMLSelectElement, options: Array<{ value: string; label: string }>, first?: { value: string; label: string }): void {
  select.replaceChildren();
  if (first) select.add(new Option(first.label, first.value));
  for (const option of options) select.add(new Option(option.label, option.value));
}

function refreshIcons(_root: HTMLElement = document.body): void {
  createIcons({
    icons: {
      Activity, AlertCircle, Cable, Check, CheckCircle2, ChevronDown, ChevronRight, Circle,
      CircleStop, Clock3, FileCode2, FileDiff, GitMerge, GitPullRequest, GitPullRequestClosed,
      ListFilter, LoaderCircle, PanelRightClose, PanelRightOpen, Play, Plus, RefreshCw, Rocket,
      Save, Settings, ShieldCheck, TerminalSquare, Trash2, WifiOff, X, XCircle,
    },
  });
}

function renderProfiles(): void {
  const current = profileSelect.value || profiles[0]?.id;
  setOptions(profileSelect, profiles.map((profile) => ({ value: profile.id, label: profile.name })), profiles.length ? undefined : { value: "", label: "No profiles" });
  if (profiles.some((profile) => profile.id === current)) profileSelect.value = current;
}

function renderConnection(): void {
  $("#status-dot").className = `status-dot ${status.state}`;
  $("#connection-label").textContent = status.state === "connected" ? "Runner connected" : status.state === "stale" ? "Connection stale" : "Disconnected";
  const freshness = lastUpdated ? relativeTime(lastUpdated.toISOString()) : "";
  $("#freshness-label").textContent = lastUpdated ? (freshness === "now" ? "Updated just now" : `Updated ${freshness} ago`) : status.localPort ? `Forwarded on :${status.localPort}` : "No runner data";
  $("#connect").toggleAttribute("hidden", status.state === "connected");
  $("#disconnect").toggleAttribute("hidden", status.state === "disconnected");
  $("#connection-banner").toggleAttribute("hidden", status.state !== "stale");
  $("#stale-detail").textContent = status.exitStatus === null ? "Remote state may be out of date." : `SSH exited with status ${status.exitStatus}. Remote state may be out of date.`;
  profileSelect.disabled = status.state === "connected" || busy;
  $("#profile-settings").toggleAttribute("disabled", status.state === "connected" || busy);
  $("#profile-add").toggleAttribute("disabled", status.state === "connected" || busy);
  $("#connect").toggleAttribute("disabled", !selectedProfile() || busy);
  $("#disconnect").toggleAttribute("disabled", busy);
  $("#reconnect").toggleAttribute("disabled", busy);
  $("#refresh-runs").toggleAttribute("disabled", status.state !== "connected" || busy);
}

function renderCatalog(): void {
  if (!catalog) {
    setOptions(taskSelect, [], { value: "", label: "No tasks" });
    setOptions(repoSelect, [], { value: "", label: "All matching repos" });
    taskSelect.disabled = true;
    repoSelect.disabled = true;
  } else {
    const taskValue = taskSelect.value;
    const repoValue = repoSelect.value;
    setOptions(taskSelect, catalog.tasks.map((task) => ({ value: task.id, label: `${task.id} · ${task.title}` })));
    setOptions(repoSelect, catalog.repos.map((repo) => ({ value: repo.name, label: repo.name })), { value: "", label: "All matching repos" });
    if (catalog.tasks.some((task) => task.id === taskValue)) taskSelect.value = taskValue;
    if (catalog.repos.some((repo) => repo.name === repoValue)) repoSelect.value = repoValue;
    taskSelect.disabled = catalog.tasks.length === 0 || status.state !== "connected" || busy;
    repoSelect.disabled = status.state !== "connected" || busy;
  }
  const canRun = status.state === "connected" && Boolean(activeProfile());
  const canDispatch = canRun && Boolean(catalog) && Boolean(taskSelect.value) && !busy;
  const canLocalRun = canDispatch && Boolean(repoSelect.value);
  $("#dispatch-action").toggleAttribute("disabled", !canDispatch);
  $("#local-run").toggleAttribute("disabled", !canLocalRun);
  prToggle.disabled = !canLocalRun;
}

function renderQueue(): void {
  const list = $("#queue-list");
  list.replaceChildren();
  $("#all-count").textContent = String(runs.length);
  $("#attention-count").textContent = String(runs.filter(isAttention).length + (status.state === "stale" ? 1 : 0));
  const visible = queueFilter === "attention" ? runs.filter(isAttention) : runs;
  const hasConnectionAttention = queueFilter === "attention" && status.state === "stale";

  if (status.state === "disconnected" && runs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "queue-empty";
    empty.innerHTML = `<i data-lucide="cable"></i><strong>Runner disconnected</strong><span>Select a profile and connect.</span>`;
    list.append(empty);
    refreshIcons(list);
    return;
  }
  if (visible.length === 0 && !hasConnectionAttention) {
    const empty = document.createElement("div");
    empty.className = "queue-empty compact-empty";
    empty.innerHTML = `<i data-lucide="check"></i><strong>Nothing needs attention</strong>`;
    list.append(empty);
    refreshIcons(list);
    return;
  }

  if (hasConnectionAttention) {
    const section = document.createElement("section");
    section.className = "repo-group connection-group";
    const header = document.createElement("div");
    header.className = "repo-heading";
    header.innerHTML = `<i data-lucide="chevron-down"></i><strong>Runner</strong><span>1</span>`;
    const row = document.createElement("button");
    row.className = "run-row connection-attention";
    row.innerHTML = `<span class="run-row-main"><strong>Connection lost</strong><span>Remote state may be stale</span></span><span class="run-row-state failure"><i data-lucide="wifi-off"></i><span>Reconnect</span></span>`;
    row.addEventListener("click", () => void connect());
    section.append(header, row);
    list.append(section);
  }

  const groups = new Map<string, FleetRun[]>();
  for (const run of visible) {
    const repo = runRepo(run);
    groups.set(repo, [...(groups.get(repo) ?? []), run]);
  }
  for (const [repo, repoRuns] of groups) {
    const section = document.createElement("section");
    section.className = "repo-group";
    const header = document.createElement("div");
    header.className = "repo-heading";
    header.innerHTML = `<i data-lucide="chevron-down"></i><strong></strong><span>${repoRuns.length}</span>`;
    header.querySelector("strong")!.textContent = repo;
    section.append(header);

    for (const run of repoRuns) {
      const value = runStatus(run);
      const row = document.createElement("button");
      row.className = `run-row ${run.key === selectedKey ? "selected" : ""}`;
      row.dataset.runKey = run.key;
      const main = document.createElement("span");
      main.className = "run-row-main";
      const title = document.createElement("strong");
      title.textContent = runTitle(run);
      const meta = document.createElement("span");
      meta.textContent = `${run.data.task} · ${relativeTime(run.sortAt)}`;
      main.append(title, meta);
      const cosign = cosignFor(run);
      const chip = cosign && COSIGN_CHIP[cosign.state];
      const state = document.createElement("span");
      state.className = `run-row-state ${chip?.tone ?? statusTone(value)}`;
      state.innerHTML = `<i data-lucide="${chip?.icon ?? statusIcon(value)}"></i><span></span>`;
      state.querySelector("span")!.textContent = chip?.label ?? statusLabel(value);
      row.append(main, state);
      row.addEventListener("click", () => void selectRun(run.key));
      section.append(row);
    }
    list.append(section);
  }
  refreshIcons(list);
}

function pipelineState(run: FleetRun, index: number): "passed" | "active" | "failed" | "pending" | "skipped" {
  const stages = ["agent", "scope", "verify", "judge", "shipping"];
  if (run.kind === "inflight") {
    const current = stages.indexOf(run.data.stage);
    return index < current ? "passed" : index === current ? "active" : "pending";
  }
  const failureStage: Record<string, number> = { "agent-failed": 0, "engine-failed": 0, "scope-violation": 1, "verify-failed": 2, vetoed: 3 };
  if (run.data.status in failureStage) {
    const failed = failureStage[run.data.status];
    return index < failed ? "passed" : index === failed ? "failed" : "pending";
  }
  if (run.data.status === "no-changes") return index === 0 ? "passed" : "skipped";
  return "passed";
}

function renderSelectedRun(): void {
  const run = selectedRun();
  const previewOpen = Boolean(run && artifactPreview?.runKey === run.key);
  $("#run-empty").toggleAttribute("hidden", Boolean(run));
  $("#run-detail").toggleAttribute("hidden", !run || previewOpen);
  $("#artifact-preview").toggleAttribute("hidden", !previewOpen);

  if (!run) {
    artifactPreview = null;
    artifactFrame.src = "about:blank";
    $("#selected-repo").textContent = "Fleet";
    $("#selected-title").textContent = "Ledger";
    $("#selected-meta").textContent = "No run selected";
    const badge = $("#selected-status");
    badge.textContent = "Idle";
    badge.className = "status-badge neutral";
    $("#open-pr").hidden = true;
    $("#rail-run-state").textContent = "No run selected";
    renderMetadata(undefined);
    return;
  }

  const value = runStatus(run);
  $("#selected-repo").textContent = runRepo(run);
  $("#selected-title").textContent = runTitle(run);
  $("#selected-meta").textContent = run.kind === "inflight"
    ? `${run.data.task} · attempt ${run.data.attempt} · started ${relativeTime(run.data.startedAt)} ago`
    : `${run.data.task} · ${run.data.mode} · completed ${relativeTime(run.data.ts)} ago`;
  const badge = $("#selected-status");
  badge.textContent = statusLabel(value);
  badge.className = `status-badge ${statusTone(value)}`;
  $("#open-pr").toggleAttribute("hidden", run.kind !== "completed" || !run.data.prUrl);
  $("#rail-run-state").textContent = statusLabel(value);

  const stageNames = ["Agent", "Scope", "Verify", "Judge", run.kind === "completed" && run.data.prUrl ? "Pull request" : "Approve"];
  const pipeline = $("#pipeline");
  pipeline.replaceChildren();
  stageNames.forEach((name, index) => {
    const state = pipelineState(run, index);
    const item = document.createElement("li");
    item.className = state;
    const icon = state === "passed" ? "check" : state === "failed" ? "x-circle" : state === "active" ? "loader-circle" : "circle";
    item.innerHTML = `<span class="stage-icon"><i data-lucide="${icon}"></i></span><strong>${name}</strong><small>${state === "passed" ? "Passed" : state === "failed" ? "Stopped" : state === "active" ? "Running" : state === "skipped" ? "Skipped" : "Waiting"}</small>`;
    pipeline.append(item);
  });
  refreshIcons(pipeline);
  $("#pipeline-summary").textContent = run.kind === "inflight" ? `Attempt ${run.data.attempt}` : duration(run.data.elapsedMs);

  const evidence = run.kind === "completed" ? run.data.evidence ?? (run.data.reason ? [run.data.reason] : []) : [
    `${statusLabel(run.data.stage)} since ${new Date(run.data.stageSince).toLocaleTimeString()}`,
    `Attempt ${run.data.attempt} is active on the remote runner`,
  ];
  $("#evidence-count").textContent = `${evidence.length} ${evidence.length === 1 ? "line" : "lines"}`;
  const log = $("#evidence-log");
  log.replaceChildren();
  if (evidence.length === 0) {
    const empty = document.createElement("div");
    empty.className = "evidence-empty";
    empty.textContent = "No gate evidence recorded.";
    log.append(empty);
  } else {
    evidence.forEach((line, index) => {
      const row = document.createElement("div");
      row.className = "evidence-line";
      const number = document.createElement("span");
      number.textContent = String(index + 1).padStart(2, "0");
      const content = document.createElement("code");
      content.textContent = line;
      row.append(number, content);
      log.append(row);
    });
  }
  renderMetadata(run);
}

/** Run-details rows for the PR's live merge state — the decision record. */
function cosignRows(run: FleetRun): Array<[string, string]> {
  const cosign = cosignFor(run);
  if (!cosign) return [];
  const rows: Array<[string, string]> = [["Pull request", COSIGN_CHIP[cosign.state].detail]];
  if (cosign.state === "merged" && cosign.mergedBy) rows.push(["Co-signed by", cosign.mergedBy]);
  if (cosign.state === "merged" && cosign.mergedAt) rows.push(["Co-signed", new Date(cosign.mergedAt).toLocaleString()]);
  return rows;
}

function renderMetadata(run: FleetRun | undefined): void {
  const list = $("#run-metadata");
  const rows: Array<[string, string]> = !run ? [["Status", "—"], ["Task", "—"], ["Repository", "—"], ["Started", "—"]] : run.kind === "inflight" ? [
    ["Status", statusLabel(run.data.stage)], ["Task", run.data.task], ["Repository", run.data.repo],
    ["Started", new Date(run.data.startedAt).toLocaleString()], ["Attempt", String(run.data.attempt)], ["Stage age", relativeTime(run.data.stageSince)],
  ] : [
    ["Status", statusLabel(run.data.status)], ["Task", run.data.task], ["Repository", run.data.repo],
    ["Completed", new Date(run.data.ts).toLocaleString()], ["Mode", run.data.mode], ["Duration", duration(run.data.elapsedMs)],
    ...(run.data.sha ? [["Commit", run.data.sha] as [string, string]] : []), ...(run.data.vetoes ? [["Vetoes", String(run.data.vetoes)] as [string, string]] : []),
    ...cosignRows(run),
  ];
  list.replaceChildren();
  for (const [term, value] of rows) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    row.append(dt, dd);
    list.append(row);
  }
}

function renderArtifacts(): void {
  $("#artifact-count").textContent = String(artifacts.length);
  const list = $("#artifact-list");
  list.replaceChildren();
  if (artifacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rail-empty";
    empty.textContent = selectedRun()?.kind === "inflight" ? "Available when the run completes" : "No artifacts";
    list.append(empty);
    return;
  }
  for (const artifact of artifacts) {
    const button = document.createElement("button");
    button.className = "artifact-row";
    const icon = artifact.name === "diff.patch" ? "file-diff" : artifact.name.endsWith(".json") ? "file-code-2" : "terminal-square";
    button.innerHTML = `<i data-lucide="${icon}"></i><span><strong></strong><small>${formatBytes(artifact.size)}</small></span><i data-lucide="chevron-right"></i>`;
    button.querySelector("strong")!.textContent = artifact.name;
    button.addEventListener("click", () => openArtifact(artifact));
    list.append(button);
  }
  refreshIcons(list);
}

function renderActivity(): void {
  const list = $("#activity-list");
  list.replaceChildren();
  const receipts = [...results];
  if (status.outputTail) {
    receipts.push({ command: status.command ?? "SSH tunnel", exitStatus: status.state === "stale" ? status.exitStatus ?? -1 : 0, stdoutTail: status.outputTail, stderrTail: "", timestamp: status.startedAt ?? Date.now() });
  }
  if (receipts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rail-empty";
    empty.textContent = "No remote commands";
    list.append(empty);
    return;
  }
  for (const receipt of receipts) {
    const details = document.createElement("details");
    details.className = "receipt-row";
    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="receipt-state ${receipt.exitStatus === 0 ? "success" : "failure"}"><i data-lucide="${receipt.exitStatus === 0 ? "check-circle-2" : "x-circle"}"></i></span><span class="receipt-command"><strong></strong><small>${new Date(receipt.timestamp).toLocaleTimeString()} · exit ${receipt.exitStatus}</small></span><i data-lucide="chevron-right"></i>`;
    summary.querySelector("strong")!.textContent = receipt.command;
    const output = document.createElement("pre");
    output.textContent = [receipt.stdoutTail, receipt.stderrTail].filter(Boolean).join("\n").trim() || "No output";
    details.append(summary, output);
    list.append(details);
  }
  refreshIcons(list);
}

function renderView(): void {
  document.querySelectorAll<HTMLElement>(".workspace-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === workspaceView));
  $("#run-view").toggleAttribute("hidden", workspaceView !== "run");
  $("#review-view").toggleAttribute("hidden", workspaceView !== "review");
  $("#ledger-view").toggleAttribute("hidden", workspaceView !== "ledger");
  renderReview();
}

const PREVIEW_PATCH = [
  "diff --git a/src/lib/feed.js b/src/lib/feed.js",
  "index 2f1c4aa..9be01c3 100644",
  "--- a/src/lib/feed.js",
  "+++ b/src/lib/feed.js",
  "@@ -12,7 +12,8 @@ export function buildFeed(source) {",
  "   const entries = source.items",
  "-    .map((item) => renderEntry(item));",
  "+    .filter((item) => item.id)",
  "+    .map((item) => renderEntry(item));",
  "   return wrap(entries);",
  " }",
  "diff --git a/tests/feed.test.js b/tests/feed.test.js",
  "new file mode 100644",
  "index 0000000..fd87402",
  "--- /dev/null",
  "+++ b/tests/feed.test.js",
  "@@ -0,0 +1,4 @@",
  '+import test from "node:test";',
  "+",
  '+test("buildFeed skips items without an id", () => {',
  "+});",
].join("\n");

/** Fetch and parse the selected run's diff.patch once per run; every state the
 *  tab can show (loading, parsed, honest refusals) renders from `review`. */
async function ensureReviewLoaded(): Promise<void> {
  const run = selectedRun();
  if (!run || run.kind !== "completed" || run.data.mode !== "local") return;
  const diffArtifact = artifacts.find((artifact) => artifact.name === "diff.patch");
  if (!diffArtifact) return;
  if (review?.runKey === run.key && review.state !== "error") return;
  review = { runKey: run.key, state: "loading" };
  renderReview();
  try {
    const text = previewMode
      ? PREVIEW_PATCH
      : await invoke<string>("operator_get_text", { path: diffArtifact.url });
    if (review?.runKey !== run.key) return;
    review = { runKey: run.key, state: "ready", diff: parsePatch(text) };
  } catch (error) {
    if (review?.runKey !== run.key) return;
    review = { runKey: run.key, state: "error", message: String(error) };
  }
  renderReview();
}

function reviewNotice(icon: string, title: string, detail: string): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "review-empty";
  empty.innerHTML = `<div class="empty-glyph"><i data-lucide="${icon}"></i></div><h2></h2><p></p>`;
  empty.querySelector("h2")!.textContent = title;
  empty.querySelector("p")!.textContent = detail;
  return empty;
}

function diffFileTags(file: DiffFile): string[] {
  const tags: string[] = [];
  if (file.status !== "modified") tags.push(file.status === "added" ? "new" : file.status);
  if (file.binary) tags.push("binary");
  return tags;
}

function renderDiffFile(file: DiffFile): HTMLElement {
  const details = document.createElement("details");
  details.className = "diff-file";
  details.open = file.hunks.length > 0;
  const summary = document.createElement("summary");
  summary.innerHTML = `<i data-lucide="chevron-right"></i><span class="diff-path"></span><span class="diff-tags"></span><span class="diff-counts"><b class="add"></b><b class="del"></b></span>`;
  summary.querySelector(".diff-path")!.textContent = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const tagList = summary.querySelector(".diff-tags")!;
  for (const tag of diffFileTags(file)) {
    const chip = document.createElement("i");
    chip.textContent = tag;
    tagList.append(chip);
  }
  summary.querySelector(".add")!.textContent = `+${file.additions}`;
  summary.querySelector(".del")!.textContent = `−${file.deletions}`;
  details.append(summary);

  const body = document.createElement("div");
  body.className = "diff-file-body";
  if (file.binary || file.hunks.length === 0) {
    const note = document.createElement("div");
    note.className = "diff-note";
    note.textContent = file.binary
      ? "Binary file — no text diff."
      : file.status === "renamed"
        ? "Renamed with no content changes."
        : "No content changes.";
    body.append(note);
  }
  for (const hunk of file.hunks) {
    const header = document.createElement("div");
    header.className = "diff-hunk-header";
    header.textContent = hunk.header;
    body.append(header);
    for (const line of hunk.lines) {
      const row = document.createElement("div");
      row.className = `diff-line ${line.kind}`;
      const sign = document.createElement("span");
      sign.textContent = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
      const text = document.createElement("code");
      text.textContent = line.text;
      row.append(sign, text);
      body.append(row);
    }
  }
  details.append(body);
  return details;
}

function renderReview(): void {
  if (workspaceView !== "review") return;
  const container = $("#review-content");
  container.replaceChildren();
  const run = selectedRun();

  if (!run) {
    container.append(reviewNotice("file-diff", "No run selected", "Choose a run from the queue to review its change."));
  } else if (run.kind === "inflight") {
    container.append(reviewNotice("loader-circle", "Run in progress", "The diff is captured when the run completes — nothing to review yet."));
  } else if (run.data.mode === "cloud") {
    const notice = reviewNotice("git-pull-request", "Review on GitHub", "Cloud runs keep their artifacts in the GitHub workflow — this runner holds no local diff.");
    if (run.data.prUrl) {
      const open = document.createElement("button");
      open.className = "secondary compact";
      open.innerHTML = `<i data-lucide="git-pull-request"></i>Open PR`;
      open.addEventListener("click", () => $("#open-pr").click());
      notice.append(open);
    }
    container.append(notice);
  } else if (artifactsLoadedFor !== run.key) {
    container.append(reviewNotice("loader-circle", "Loading diff", "Fetching the run's artifacts from the runner."));
  } else if (!artifacts.find((artifact) => artifact.name === "diff.patch")) {
    container.append(reviewNotice("file-diff", "No diff artifact", "This run recorded no diff.patch — it ended before a diff was captured, so there is nothing to review."));
  } else if (!review || review.runKey !== run.key || review.state === "loading") {
    container.append(reviewNotice("loader-circle", "Loading diff", "Fetching diff.patch from the runner."));
  } else if (review.state === "error") {
    container.append(reviewNotice("alert-circle", "Diff failed to load", review.message));
  } else if (review.diff.files.length === 0) {
    container.append(reviewNotice("file-diff", "Empty diff", "The captured diff.patch contains no file changes."));
  } else {
    const { files, additions, deletions } = review.diff;
    const summary = document.createElement("div");
    summary.className = "review-summary";
    summary.innerHTML = `<strong></strong><span class="diff-counts"><b class="add"></b><b class="del"></b></span>`;
    summary.querySelector("strong")!.textContent = `${files.length} ${files.length === 1 ? "file" : "files"} changed`;
    summary.querySelector(".add")!.textContent = `+${additions}`;
    summary.querySelector(".del")!.textContent = `−${deletions}`;
    container.append(summary);
    for (const file of files) container.append(renderDiffFile(file));
  }
  refreshIcons(container);
}

function renderAll(): void {
  renderProfiles();
  renderConnection();
  renderCatalog();
  renderQueue();
  renderSelectedRun();
  renderArtifacts();
  renderActivity();
  renderView();
}

function toast(message: string, isError = false): void {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast ${isError ? "error" : ""}`;
  element.hidden = false;
  window.setTimeout(() => { element.hidden = true; }, 3500);
}

function setBusy(next: boolean): void {
  busy = next;
  renderConnection();
  renderCatalog();
}

function showProfile(profile?: HostProfile): void {
  ($("#profile-id") as HTMLInputElement).value = profile?.id ?? crypto.randomUUID();
  ($("#profile-name") as HTMLInputElement).value = profile?.name ?? "";
  ($("#ssh-target") as HTMLInputElement).value = profile?.sshTarget ?? "";
  ($("#remote-repo") as HTMLInputElement).value = profile?.remoteRepoPath ?? "";
  ($("#command-prefix") as HTMLInputElement).value = prefixFor(profile?.remoteRepoPath ?? "");
  ($("#remote-port") as HTMLInputElement).value = String(profile?.remotePort ?? 4173);
  ($("#local-port") as HTMLInputElement).value = profile?.preferredLocalPort ? String(profile.preferredLocalPort) : "";
  $("#delete-profile").toggleAttribute("hidden", !profile);
  $("#dialog-title").textContent = profile ? "Edit host profile" : "New host profile";
  profileDialog.showModal();
}

async function operatorGet<T>(path: string): Promise<T> {
  return invoke<T>("operator_get", { path });
}

function refreshLedgerFrame(): void {
  if (!status.url) return;
  ledgerFrame.src = refreshedLedgerUrl(status.url, Date.now());
  ledgerFrame.hidden = false;
  $("#ledger-empty").hidden = true;
}

async function refreshFleetData(): Promise<void> {
  if (previewMode) return loadPreviewData();
  const [ledger, inflight] = await Promise.all([
    operatorGet<{ generatedAt: string; entries: LedgerEntry[]; cosigns?: Record<string, Cosign> }>("/api/ledger"),
    operatorGet<{ generatedAt: string; runs: InflightRecord[] }>("/api/inflight"),
  ]);
  cosigns = ledger.cosigns ?? {};
  const completed: FleetRun[] = ledger.entries.map((entry, index) => ({ kind: "completed", key: entry.runId ?? `ledger-${entry.ts}-${entry.task}-${entry.repo}-${index}`, sortAt: entry.ts, data: entry }));
  const live: FleetRun[] = inflight.runs.map((entry) => ({ kind: "inflight", key: entry.runId, sortAt: entry.startedAt, data: entry }));
  const nextRevision = fleetRevision(ledger.entries, inflight.runs);
  const ledgerChanged = ledgerRefreshDecision(ledgerRevision, nextRevision);
  ledgerRevision = nextRevision;
  runs = [...live, ...completed].sort((a, b) => Date.parse(b.sortAt) - Date.parse(a.sortAt));
  lastUpdated = new Date(ledger.generatedAt);
  if (!selectedKey || !runs.some((run) => run.key === selectedKey)) selectedKey = runs[0]?.key ?? "";
  await loadArtifactsForSelected();
  if (ledgerChanged) refreshLedgerFrame();
  renderAll();
  if (workspaceView === "review") void ensureReviewLoaded();
}

async function loadArtifactsForSelected(): Promise<void> {
  const run = selectedRun();
  const runKey = selectedKey;
  const request = ++artifactRequest;
  let next: ArtifactMetadata[] = [];
  if (run && run.kind === "completed") {
    if (previewMode) {
      next = previewArtifacts();
    } else if (run.data.runId) {
      try {
        const detail = await operatorGet<{ artifacts: ArtifactMetadata[] }>(`/api/runs/${encodeURIComponent(run.data.runId)}`);
        next = detail.artifacts;
      } catch {
        next = [];
      }
    }
  }
  if (request === artifactRequest && runKey === selectedKey) {
    artifacts = next;
    artifactsLoadedFor = runKey;
  }
}

async function selectRun(key: string): Promise<void> {
  if (selectedKey !== key) {
    artifactPreview = null;
    artifactFrame.src = "about:blank";
    review = null;
  }
  selectedKey = key;
  if (workspaceView === "ledger") workspaceView = "run";
  artifacts = [];
  renderQueue();
  renderSelectedRun();
  renderArtifacts();
  renderView();
  await loadArtifactsForSelected();
  renderArtifacts();
  if (workspaceView === "review") await ensureReviewLoaded();
  renderReview();
}

function openArtifact(artifact: ArtifactMetadata): void {
  const run = selectedRun();
  if (!run) return;
  artifactPreview = { runKey: run.key, name: artifact.name };
  $("#artifact-title").textContent = artifact.name;
  $("#artifact-subtitle").textContent = `${run.data.task} · ${run.data.repo} · ${formatBytes(artifact.size)}`;
  $("#run-detail").hidden = true;
  $("#run-empty").hidden = true;
  $("#artifact-preview").hidden = false;
  if (previewMode) {
    artifactFrame.srcdoc = `<style>body{margin:0;padding:24px;background:#111;color:#ddd;font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap}</style>diff --git a/src/client.ts b/src/client.ts\nindex 4b1..8ad 100644\n--- a/src/client.ts\n+++ b/src/client.ts\n@@ -18,4 +18,6 @@\n+export const verified = true;`;
  } else if (status.url) {
    artifactFrame.removeAttribute("srcdoc");
    artifactFrame.src = `${status.url}${artifact.url}`;
  }
}

async function connect(): Promise<void> {
  const profile = selectedProfile();
  if (!profile) return;
  setBusy(true);
  try {
    status = await invoke<ConnectionStatus>("connect_profile", { profile });
    if (status.state !== "connected" || !status.url) throw new Error(status.outputTail || "SSH connection stopped");
    catalog = await waitForCatalog();
    ledgerRevision = "";
    ledgerFrame.src = status.url;
    ledgerFrame.hidden = false;
    $("#ledger-empty").hidden = true;
    await refreshFleetData();
    toast(`Connected to ${profile.name}`);
  } catch (error) {
    status = await invoke<ConnectionStatus>("connection_status").catch(() => status);
    toast(String(error), true);
  } finally {
    setBusy(false);
    renderAll();
  }
}

async function waitForCatalog(): Promise<Catalog> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try { return await operatorGet<Catalog>("/api/catalog"); }
    catch (error) { lastError = error; await new Promise((resolve) => window.setTimeout(resolve, 500)); }
  }
  throw lastError;
}

async function runAction(kind: "dispatch" | "localRun"): Promise<void> {
  const profile = activeProfile();
  const task = taskSelect.value;
  const repo = repoSelect.value;
  if (status.state !== "connected" || !profile || !task || (kind === "localRun" && !repo)) return;
  setBusy(true);
  try {
    const pr = prToggle.checked;
    const action = kind === "dispatch" ? { kind, task, repo: repo || null } : { kind, task, repo, pr };
    const result = previewMode
      ? { command: `ssh ${profile.sshTarget} fleet ${kind === "dispatch" ? `dispatch ${task}` : `run ${task} --repo ${repo} --local${pr ? " --pr" : ""}`}`, exitStatus: 0, stdoutTail: kind === "dispatch" ? "workflow dispatch accepted" : `${pr ? "run" : "dry-run"} started on remote runner`, stderrTail: "", timestamp: Date.now() }
      : await invoke<RemoteCommandResult>("execute_fleet_action", { profile, action });
    results.unshift(result);
    toast(result.exitStatus === 0 ? "Remote command completed" : `Remote command exited ${result.exitStatus}`, result.exitStatus !== 0);
  } catch (error) {
    toast(String(error), true);
  } finally {
    setBusy(false);
    renderActivity();
  }
}

function loadPreviewData(): void {
  const now = Date.now();
  profiles = [{ id: "preview", name: "Production runner", sshTarget: "fleet@runner", remoteRepoPath: "/srv/spotify-stack", remoteCommandPrefix: "", remotePort: 4173, preferredLocalPort: null }];
  status = { profileId: "preview", state: "connected", localPort: 49152, url: null, command: "ssh fleet@runner [forward localhost:49152] fleet report --serve --cosign", exitStatus: null, outputTail: "Fleet Ledger live at http://127.0.0.1:4173", startedAt: now - 3_600_000 };
  catalog = {
    tasks: [{ id: "004-upstream-failure-mode-tests", title: "Cover upstream failure modes", targets: ["demo-feed-service"], risk: "low" }, { id: "onramp-1-feed-tests", title: "Add feed builder tests", targets: ["demo-feed-service"], risk: "low" }],
    repos: [{ name: "demo-feed-service", language: "javascript", defaultBranch: "main" }, { name: "demo-ts-service", language: "typescript", defaultBranch: "main" }],
  };
  const entries: LedgerEntry[] = [
    { ts: new Date(now - 12 * 60_000).toISOString(), runId: "approved", task: "004-upstream-failure-mode-tests", repo: "demo-feed-service", status: "approved", mode: "cloud", vetoes: 0, title: "Cover upstream failure modes", elapsedMs: 186_421, prUrl: "https://github.com/example/repo/pull/42", sha: "8df31c2", evidence: ["Scope contract passed for 4 changed files", "VERIFY PASSED", "npm run test passed (42 tests)", "Judge approved with no violations"] },
    { ts: new Date(now - 2 * 3_600_000).toISOString(), runId: "shipped", task: "onramp-1-feed-tests", repo: "demo-feed-service", status: "approved", mode: "local", vetoes: 0, title: "Add feed builder tests", elapsedMs: 121_204, prUrl: "https://github.com/example/repo/pull/38", sha: "1fa9b04", evidence: ["Scope contract passed", "VERIFY PASSED", "Judge approved with no violations"] },
    { ts: new Date(now - 47 * 60_000).toISOString(), runId: "failed", task: "onramp-1-feed-tests", repo: "demo-feed-service", status: "verify-failed", mode: "local", vetoes: 0, title: "Add feed builder tests", elapsedMs: 74_902, reason: "npm run test failed: expected 3 items, received 4", evidence: ["Scope contract passed", "VERIFY FAILED", "expected 3 items, received 4"] },
    { ts: new Date(now - 4 * 3_600_000).toISOString(), runId: "noop", task: "003-add-agent-badge", repo: "demo-ts-service", status: "no-changes", mode: "cloud", vetoes: 0, title: "Add agent badge", elapsedMs: 23_511, evidence: ["Task precondition is already satisfied", "NO_CHANGES_NEEDED"] },
    { ts: new Date(now - 26 * 3_600_000).toISOString(), runId: "vetoed", task: "002-dedupe-feed-items", repo: "demo-feed-service", status: "vetoed", mode: "cloud", vetoes: 3, title: "Dedupe feed items on ingest", elapsedMs: 224_007, reason: "Change regenerated the entire lockfile", evidence: ["Scope contract passed", "VERIFY PASSED", "Judge veto: regenerated the entire lockfile"] },
  ];
  const live: InflightRecord = { runId: "live", startedAt: new Date(now - 6 * 60_000).toISOString(), task: "004-upstream-failure-mode-tests", repo: "demo-ts-service", title: "Cover upstream failure modes", stage: "verify", attempt: 1, stageSince: new Date(now - 70_000).toISOString() };
  cosigns = {
    "https://github.com/example/repo/pull/42": { state: "open" },
    "https://github.com/example/repo/pull/38": { state: "merged", mergedBy: "fernando", mergedAt: new Date(now - 90 * 60_000).toISOString() },
  };
  runs = [
    { kind: "inflight", key: live.runId, sortAt: live.startedAt, data: live },
    ...entries.map((entry) => ({ kind: "completed" as const, key: entry.runId!, sortAt: entry.ts, data: entry })),
  ];
  selectedKey = "approved";
  artifacts = previewArtifacts();
  results = [{ command: "ssh fleet@runner fleet dispatch 004-upstream-failure-mode-tests --repo demo-feed-service", exitStatus: 0, stdoutTail: "dispatched agent-task.yml", stderrTail: "", timestamp: now - 17 * 60_000 }];
  lastUpdated = new Date(now - 18_000);
}

function previewArtifacts(): ArtifactMetadata[] {
  const stamp = new Date().toISOString();
  return [
    { name: "diff.patch", size: 8421, modifiedAt: stamp, url: "/api/artifacts/x/y/diff.patch", contentType: "text/x-diff" },
    { name: "verify.log", size: 1632, modifiedAt: stamp, url: "/api/artifacts/x/y/verify.log", contentType: "text/plain" },
    { name: "verdict.json", size: 421, modifiedAt: stamp, url: "/api/artifacts/x/y/verdict.json", contentType: "application/json" },
    { name: "pr-preview.md", size: 2104, modifiedAt: stamp, url: "/api/artifacts/x/y/pr-preview.md", contentType: "text/markdown" },
  ];
}

document.querySelectorAll<HTMLButtonElement>(".queue-filter").forEach((button) => button.addEventListener("click", () => {
  queueFilter = button.dataset.filter as QueueFilter;
  document.querySelectorAll(".queue-filter").forEach((item) => item.classList.toggle("active", item === button));
  renderQueue();
}));
document.querySelectorAll<HTMLButtonElement>(".workspace-tab").forEach((button) => button.addEventListener("click", () => {
  workspaceView = button.dataset.view as WorkspaceView;
  renderView();
  if (workspaceView === "review") void ensureReviewLoaded();
}));
$("#profile-settings").addEventListener("click", () => showProfile(selectedProfile()));
$("#profile-add").addEventListener("click", () => showProfile());
$("#connect").addEventListener("click", () => void connect());
$("#reconnect").addEventListener("click", () => void connect());
$("#refresh-runs").addEventListener("click", () => void refreshFleetData().catch((error) => toast(String(error), true)));
$("#disconnect").addEventListener("click", async () => {
  setBusy(true);
  try {
    status = previewMode ? disconnectedStatus() : await invoke<ConnectionStatus>("disconnect");
    catalog = null;
    runs = [];
    cosigns = {};
    selectedKey = "";
    artifacts = [];
    artifactsLoadedFor = "";
    review = null;
    ledgerRevision = "";
    ledgerFrame.src = "about:blank";
    ledgerFrame.hidden = true;
    $("#ledger-empty").hidden = false;
  } finally { setBusy(false); renderAll(); }
});
$("#dispatch-action").addEventListener("click", () => void runAction("dispatch"));
$("#local-run").addEventListener("click", () => void runAction("localRun"));
$("#clear-activity").addEventListener("click", () => { results = []; renderActivity(); });
$("#toggle-rail").addEventListener("click", () => {
  const collapsed = workbench.classList.toggle("rail-collapsed");
  $("#toggle-rail").setAttribute("title", collapsed ? "Show evidence panel" : "Hide evidence panel");
  $("#toggle-rail").innerHTML = `<i data-lucide="${collapsed ? "panel-right-open" : "panel-right-close"}"></i>`;
  refreshIcons($("#toggle-rail"));
});
$("#open-pr").addEventListener("click", () => {
  const run = selectedRun();
  if (run?.kind !== "completed" || !run.data.prUrl) return;
  try {
    const url = new URL(run.data.prUrl);
    if (url.protocol !== "https:") throw new Error("Pull request URL is not HTTPS");
    window.open(url, "_blank", "noopener");
  } catch (error) {
    toast(String(error), true);
  }
});
$("#close-artifact").addEventListener("click", () => { artifactPreview = null; $("#artifact-preview").hidden = true; $("#run-detail").hidden = !selectedRun(); $("#run-empty").hidden = Boolean(selectedRun()); artifactFrame.src = "about:blank"; });
taskSelect.addEventListener("change", renderCatalog);
repoSelect.addEventListener("change", renderCatalog);
profileSelect.addEventListener("change", renderConnection);
$("#close-dialog").addEventListener("click", () => profileDialog.close());
$("#cancel-profile").addEventListener("click", () => profileDialog.close());
$("#remote-repo").addEventListener("input", (event) => { ($("#command-prefix") as HTMLInputElement).value = prefixFor((event.target as HTMLInputElement).value); });
$("#delete-profile").addEventListener("click", async () => {
  const id = ($("#profile-id") as HTMLInputElement).value;
  if (status.profileId === id) status = await invoke<ConnectionStatus>("disconnect");
  profiles = await invoke<HostProfile[]>("save_profiles", { profiles: profiles.filter((profile) => profile.id !== id) });
  profileDialog.close();
  renderAll();
});
profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = (id: string): string => ($(id) as HTMLInputElement).value.trim();
  const localPort = value("#local-port");
  const profile: HostProfile = { id: value("#profile-id"), name: value("#profile-name"), sshTarget: value("#ssh-target"), remoteRepoPath: value("#remote-repo"), remoteCommandPrefix: "", remotePort: Number(value("#remote-port")), preferredLocalPort: localPort ? Number(localPort) : null };
  const next = [...profiles.filter((item) => item.id !== profile.id), profile];
  try {
    profiles = previewMode ? next : await invoke<HostProfile[]>("save_profiles", { profiles: next });
    profileDialog.close();
    renderProfiles();
    profileSelect.value = profile.id;
    renderConnection();
  } catch (error) { toast(String(error), true); }
});

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || profileDialog.open) return;
  if (event.metaKey && event.key === "1") { event.preventDefault(); workspaceView = "run"; renderView(); return; }
  if (event.metaKey && event.key === "2") { event.preventDefault(); workspaceView = "review"; renderView(); void ensureReviewLoaded(); return; }
  if (event.metaKey && event.key === "3") { event.preventDefault(); workspaceView = "ledger"; renderView(); return; }
  if (!["ArrowUp", "ArrowDown"].includes(event.key) || runs.length === 0) return;
  event.preventDefault();
  const index = Math.max(0, runs.findIndex((run) => run.key === selectedKey));
  const next = event.key === "ArrowDown" ? Math.min(runs.length - 1, index + 1) : Math.max(0, index - 1);
  void selectRun(runs[next].key);
});

async function initialize(): Promise<void> {
  if (previewMode) {
    loadPreviewData();
    renderAll();
    return;
  }
  profiles = await invoke<HostProfile[]>("load_profiles");
  status = await invoke<ConnectionStatus>("connection_status");
  renderAll();
  if (status.state === "connected") {
    catalog = await waitForCatalog();
    if (status.url) { ledgerFrame.src = status.url; ledgerFrame.hidden = false; $("#ledger-empty").hidden = true; }
    await refreshFleetData();
  }
  if (profiles.length === 0) showProfile();
  window.setInterval(async () => {
    if (status.state === "disconnected") return;
    try {
      const next = await invoke<ConnectionStatus>("connection_status");
      const changed = next.state !== status.state || next.outputTail !== status.outputTail;
      status = next;
      if (status.state === "connected") await refreshFleetData();
      else if (changed) renderAll();
    } catch { /* next poll retries */ }
  }, 5000);
}

void initialize().catch((error) => toast(String(error), true));
