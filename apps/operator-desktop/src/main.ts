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
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  WifiOff,
  X,
  XCircle,
} from "lucide";
import {
  dedupeInflight,
  Endpoints,
  parseCosignStdout,
  runFacts,
  STAGES,
  TERMINAL_STAGES,
  type ArtifactMetadata,
  type CatalogResponse,
  type CosignResult,
  type InflightRecord,
  type LedgerEntry,
  type PrLiveState,
  type RunStatus,
  type Stage,
  type SyncState,
  type WireGet,
  WireParseError,
} from "@fleet/contract";
import { fleetRevision, ledgerRefreshDecision, refreshedLedgerUrl } from "./ledger-refresh";
import { parsePatch, type DiffFile, type ParsedDiff } from "./diff-parser";
import { cosignAffordance, mergeStakesClaim, outcomeDetail, verifyReadout } from "./verify-view";
import {
  awaitingReview,
  closeReasonProblem,
  MAX_REASON_LENGTH,
  mergeBlocker,
  type MergeGateInput,
} from "./cosign-result";
import { ingestInflight, ingestLedger, type InflightIngest, type LedgerIngest } from "./ingest";
import {
  PREVIEW_CATALOG,
  PREVIEW_PATCH,
  PREVIEW_SYNC_STATES,
  previewArtifacts,
  previewCosigns,
  previewInflight,
  previewLedgerEntries,
} from "./preview-fixtures";
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

/** A command receipt; cosign receipts also carry the runner's structured result. */
type Receipt = RemoteCommandResult & { cosign?: CosignResult };

/** The wire shapes — LedgerEntry, InflightRecord, ArtifactMetadata, the co-sign
 *  map value (PrLiveState), and a cloud run's evidence SyncState — all come from
 *  @fleet/contract now, the one declaration of what the runner tells the operator. */

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
        <div class="queue-heading-actions">
          <small id="unreadable-count" class="unreadable-count" hidden></small>
          <button id="refresh-runs" class="icon-button" title="Refresh runs" aria-label="Refresh runs"><i data-lucide="refresh-cw"></i></button>
        </div>
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

      <div class="banner-stack">
        <div id="connection-banner" class="connection-banner" hidden>
          <i data-lucide="wifi-off"></i>
          <div><strong>Runner connection lost</strong><span id="stale-detail">Remote state may be out of date.</span></div>
          <button id="reconnect" class="secondary compact"><i data-lucide="refresh-cw"></i>Reconnect</button>
        </div>
        <div id="wire-banner" class="connection-banner wire-banner" hidden>
          <i data-lucide="alert-circle"></i>
          <div><strong>Runner sent data this build can't read</strong><span id="wire-detail"></span></div>
        </div>
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
          <section class="pipeline-band">
            <div class="section-heading"><span>Pipeline</span><small id="pipeline-sub"></small></div>
            <div id="pipeline" class="inst-track" aria-label="Run pipeline"></div>
          </section>

          <section class="gate-band-sec">
            <div class="section-heading"><span>Gate</span></div>
            <div id="gate-spotlight" class="gate-spot"></div>
          </section>

          <section class="ev-sec">
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
        <button id="dispatch-action" class="primary compact" disabled><i data-lucide="rocket"></i>Dispatch<span class="commit-sweep"></span></button>
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
        <div id="cosign-decision" class="cosign-decision" hidden></div>
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

  <dialog id="close-dialog">
    <form id="close-form" method="dialog">
      <div class="dialog-head">
        <div><span class="eyebrow">Co-sign</span><h2>Close pull request</h2></div>
        <button type="button" id="dismiss-close-dialog" class="icon-button" title="Cancel" aria-label="Cancel"><i data-lucide="x"></i></button>
      </div>
      <p id="close-stakes" class="merge-stakes"></p>
      <label class="close-reason">Reason<textarea id="close-reason" rows="3" maxlength="${MAX_REASON_LENGTH}" required placeholder="Why this change should not merge — posted verbatim as the PR comment"></textarea></label>
      <div id="close-reason-count" class="close-reason-count">0 / ${MAX_REASON_LENGTH}</div>
      <div class="dialog-actions">
        <span></span><span></span>
        <button type="button" id="cancel-close" class="secondary">Cancel</button>
        <button type="submit" class="danger"><i data-lucide="git-pull-request-closed"></i>Close PR</button>
      </div>
    </form>
  </dialog>

  <dialog id="merge-dialog">
    <form id="merge-form" method="dialog">
      <div class="dialog-head">
        <div><span class="eyebrow">Co-sign</span><h2>Squash-merge pull request</h2></div>
        <button type="button" id="close-merge-dialog" class="icon-button" title="Cancel" aria-label="Cancel"><i data-lucide="x"></i></button>
      </div>
      <p id="merge-stakes" class="merge-stakes"></p>
      <dl id="merge-facts" class="metadata-list merge-facts"></dl>
      <div class="dialog-actions">
        <span></span><span></span>
        <button type="button" id="cancel-merge" class="secondary">Cancel</button>
        <button type="submit" id="confirm-merge" class="primary"><i data-lucide="git-merge"></i><span>Squash-merge</span></button>
      </div>
    </form>
  </dialog>

  <div id="toast" class="toast" role="status" hidden></div>
`;

const LUCIDE_ICONS = {
  Activity, AlertCircle, Cable, Check, CheckCircle2, ChevronDown, ChevronRight, Circle,
  CircleStop, Clock3, FileCode2, FileDiff, GitMerge, GitPullRequest, GitPullRequestClosed,
  ListFilter, LoaderCircle, PanelRightClose, PanelRightOpen, Play, Plus, RefreshCw, Rocket,
  RotateCcw, Save, Settings, ShieldCheck, TerminalSquare, Trash2, WifiOff, X, XCircle,
};

createIcons({ icons: LUCIDE_ICONS });

// Motion register for the Run view (map #16 flagship): strong custom curves —
// the built-in easings are too weak to read as intentional. ease-out for
// entrances, ease-in-out for on-screen movement, a subtle back-out for stamps.
// Every WAAPI call is guarded by prefersReducedMotion(); the CSS honours it too.
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_INOUT = "cubic-bezier(0.77, 0, 0.175, 1)";
const EASE_SETTLE = "cubic-bezier(0.34, 1.4, 0.64, 1)";
const prefersReducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
const mergeDialog = $("#merge-dialog") as HTMLDialogElement;
const closeDialog = $("#close-dialog") as HTMLDialogElement;
const closeReasonInput = $("#close-reason") as HTMLTextAreaElement;
const previewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview");

let profiles: HostProfile[] = [];
let status: ConnectionStatus = disconnectedStatus();
let catalog: CatalogResponse | null = null;
let runs: FleetRun[] = [];
let cosigns: Record<string, PrLiveState> = {};
let artifacts: ArtifactMetadata[] = [];
let results: Receipt[] = [];
/** Witnessed cosign refusals (merge and close) by run key — first-class state,
 *  rendered where the buttons were until the next co-sign poll moves the PR
 *  off "open". The result's `action` names which verb was refused. */
let cosignRefusals: Record<string, CosignResult> = {};
let selectedKey = "";
/** The pipeline state the Run view last rendered for the selected run — the
 *  seam that lets a poll-driven rebuild still animate: same run + a stage that
 *  advanced since this snapshot fires the connector fill / check stamp / gate
 *  spotlight slide; a different run (or nothing changed) plays no advance. */
let prevRunView: { key: string; states: string[]; spot: string } | null = null;
/** The visible queue order the list last rendered, in order — the seam that lets
 *  a poll-driven rebuild FLIP-animate the attention reorder: same set of rows in
 *  a new order slides each moved row to its slot; a changed set (filter, connect)
 *  or an unchanged order plays nothing. The queue's analogue of `prevRunView`. */
let prevQueueKeys: string[] = [];
/** The top command receipt the activity feed last rendered ({ts}:{command}) —
 *  so a freshly-arrived receipt slides into the feed while a plain re-render of
 *  the same top row stays still. Empty until the first render. */
let prevTopReceipt = "";
let review: ReviewState | null = null;
/** Run key whose artifact list has actually loaded — before that, an empty
 *  `artifacts` means "still fetching", not "the run recorded nothing". */
let artifactsLoadedFor = "";
/** The selected run's artifacts were overwritten by a later run of the same
 *  task (runner reports `artifactsSuperseded`) — "gone", not "never existed". */
let artifactsSuperseded = false;
/** The selected cloud run's evidence-sync state, when its diff archive is not
 *  yet on the runner (`syncing`), gone for good (`unavailable`), or waiting to
 *  retry (`retryable`). null once the archive is local — then it reviews and
 *  co-signs exactly like a local run. */
let artifactSync: SyncState | null = null;
let artifactPreview: { runKey: string; name: string } | null = null;
let artifactRequest = 0;
let ledgerRevision = "";
let queueFilter: QueueFilter = "all";
let workspaceView: WorkspaceView = "run";
let lastUpdated: Date | null = null;
let busy = false;
/** The last refresh envelope the runner sent that this build couldn't read —
 *  endpoint and field path from the contract, banner-ready. Set when a refresh
 *  envelope's container is malformed; the last-good runs stay rendered and
 *  timestamped underneath, and the next clean refresh clears it. */
let wireError: WireParseError | null = null;
/** How many individual records the last refresh had to skip — a bad ledger
 *  entry or live row is dropped, not fatal, and this owns up to the gap. */
let unreadableRecords = 0;

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
function cosignFor(run: FleetRun): PrLiveState | undefined {
  return run.kind === "completed" && run.data.prUrl ? cosigns[run.data.prUrl] : undefined;
}

/** The merge gate's view of a run — the decision block, the queue's attention
 *  state, and the chip all judge this same input (the decision block adds one
 *  check of its own: a live runner connection). */
function gateInput(run: FleetRun): MergeGateInput {
  return run.kind === "inflight"
    ? { kind: "inflight" }
    : { kind: "completed", mode: run.data.mode, status: run.data.status, prUrl: run.data.prUrl, cosignState: cosignFor(run)?.state };
}

/** One PR state as the UI tells it — label for the queue chip, detail for the
 *  run-details row, icon and tone shared by both. */
interface CosignChip {
  label: string;
  detail: string;
  icon: string;
  tone: string;
}

/** Everything the UI says about a PR state, in one place — the queue chip and
 *  the run-details row must never disagree. For shipped runs the decision
 *  dimension (co-sign) supersedes the pipeline dimension (approved). */
// PrLiveState.state is an open string on the wire (a newer runner may report a
// state this build doesn't know); an unknown state simply has no chip, and the
// run falls back to its pipeline-status treatment.
const COSIGN_CHIP: Record<string, CosignChip> = {
  open: { label: "PR open", detail: "Open — awaiting co-sign", icon: "git-pull-request", tone: "warning" },
  merged: { label: "Merged", detail: "Merged", icon: "git-merge", tone: "success" },
  closed: { label: "Closed", detail: "Closed without merging", icon: "git-pull-request-closed", tone: "neutral" },
};

/** An open PR the gate would accept is the operator's awaiting-review attention
 *  state — the same in-app co-sign for a local or a cloud run (#36), since a
 *  synced cloud run is reviewed and merged here just like a local one. */
function cosignChip(run: FleetRun): CosignChip | undefined {
  const cosign = cosignFor(run);
  if (!cosign) return undefined;
  if (cosign.state === "open" && awaitingReview(gateInput(run))) {
    return { label: "Needs review", detail: "Open — awaiting your co-sign", icon: "git-pull-request", tone: "review" };
  }
  return COSIGN_CHIP[cosign.state];
}

function isAttention(run: FleetRun): boolean {
  if (run.kind !== "completed") return false;
  // A kill or an infra failure both want the operator's eye — read the fate from
  // the contract's table rather than re-listing the statuses.
  const kind = runFacts(run.data.status)?.kind;
  return kind === "killed" || kind === "infra" || awaitingReview(gateInput(run));
}

/** Attention-first queue order: runs that need the operator (failures and
 *  shipped-awaiting-review) sort above the rest; recency breaks ties. */
function queueOrder(a: FleetRun, b: FleetRun): number {
  return Number(isAttention(b)) - Number(isAttention(a)) || Date.parse(b.sortAt) - Date.parse(a.sortAt);
}

/** `statusTone`/`statusLabel` paint a value that may be a terminal run status,
 *  a live pipeline stage, or a PR state ("shipped"/"merged"/"running") — so they
 *  take a plain string and lean on the contract's vocabulary. The run-status
 *  tones come from the fate table (`kind`), so nothing here restates a fact the
 *  contract owns; only the PR-state and live extras are named locally. */
function statusTone(value: string): "success" | "failure" | "working" | "warning" | "neutral" {
  const kind = runFacts(value)?.kind;
  if (kind === "killed") return "failure";
  if (kind === "infra") return "warning";
  if (kind === "shipped" || value === "shipped" || value === "merged") return "success";
  if ((STAGES as readonly string[]).includes(value) || value === "running") return "working";
  return "neutral";
}

/** Operator wording for each terminal status — sentence case, distinct from the
 *  ledger report's uppercase badges. `satisfies Record<RunStatus, string>` makes
 *  a status the contract adds a compile error until it is given a label here. */
const STATUS_LABELS = {
  approved: "Approved",
  "no-changes": "No changes",
  "agent-failed": "Agent failed",
  "verify-failed": "Verify failed",
  vetoed: "Vetoed",
  "scope-violation": "Scope violation",
  "engine-failed": "Runner error",
} as const satisfies Record<RunStatus, string>;

/** Operator wording for the live pipeline stages a run passes through (STAGES). */
const STAGE_LABELS: Record<Stage, string> = {
  agent: "Agent working",
  scope: "Scope gate",
  verify: "Verifying",
  judge: "Judging",
  shipping: "Opening PR",
};

function statusLabel(value: string): string {
  return (
    (STATUS_LABELS as Record<string, string>)[value] ??
    (STAGE_LABELS as Record<string, string>)[value] ??
    value.replaceAll("-", " ")
  );
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
  createIcons({ icons: LUCIDE_ICONS });
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
  // Re-order on every render, not only on poll — a merge or close moves the
  // run out of the attention slot the moment its live state changes.
  runs.sort(queueOrder);
  const list = $("#queue-list");
  const reduce = prefersReducedMotion();
  // Capture the current rows' positions before the rebuild, for a FLIP reorder.
  const firstRects = new Map<string, DOMRect>();
  if (!reduce) list.querySelectorAll<HTMLElement>(".run-row[data-run-key]").forEach((el) => firstRects.set(el.dataset.runKey!, el.getBoundingClientRect()));
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
    prevQueueKeys = [];
    refreshIcons(list);
    return;
  }
  if (visible.length === 0 && !hasConnectionAttention) {
    const empty = document.createElement("div");
    empty.className = "queue-empty compact-empty";
    empty.innerHTML = `<i data-lucide="check"></i><strong>Nothing needs attention</strong>`;
    list.append(empty);
    prevQueueKeys = [];
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
      row.className = `run-row ${run.key === selectedKey ? "selected" : ""} ${awaitingReview(gateInput(run)) ? "needs-review" : ""}`;
      row.dataset.runKey = run.key;
      const main = document.createElement("span");
      main.className = "run-row-main";
      const title = document.createElement("strong");
      title.textContent = runTitle(run);
      const meta = document.createElement("span");
      meta.textContent = `${run.data.task} · ${relativeTime(run.sortAt)}`;
      main.append(title, meta, runTrack(run));
      const chip = cosignChip(run);
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

  // FLIP the attention reorder: a run that bubbled into (or out of) the attention
  // cluster slides to its new slot instead of teleporting. Only a *pure* reorder
  // animates — the same set of visible rows in a new order — so selecting a run or
  // switching filters (which change the set) never triggers a slide. The queue's
  // live-advance, the way the Run view's connectors fill: change made visible.
  const nextKeys = [...list.querySelectorAll<HTMLElement>(".run-row[data-run-key]")].map((el) => el.dataset.runKey!);
  if (!reduce) {
    const sameSet = nextKeys.length === prevQueueKeys.length && nextKeys.every((key) => prevQueueKeys.includes(key));
    if (sameSet && nextKeys.join(" ") !== prevQueueKeys.join(" ")) {
      list.querySelectorAll<HTMLElement>(".run-row[data-run-key]").forEach((el) => {
        const first = firstRects.get(el.dataset.runKey!);
        if (!first) return;
        const dy = first.top - el.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 440, easing: EASE_INOUT, fill: "both" });
      });
    }
  }
  prevQueueKeys = nextKeys;
  refreshIcons(list);
}

function pipelineState(run: FleetRun, index: number): "passed" | "active" | "failed" | "pending" | "skipped" {
  if (run.kind === "inflight") {
    const current = (STAGES as readonly string[]).indexOf(run.data.stage);
    return index < current ? "passed" : index === current ? "active" : "pending";
  }
  // Which gate the run failed at, from the contract's fate table: TERMINAL_STAGES
  // (agent·scope·verify·judge) lines up with STAGES[0..3]. Infra (the engine
  // crashed) has no gate, so it is shown failing at the first one.
  const facts = runFacts(run.data.status);
  const failed = facts?.diedAt ? TERMINAL_STAGES.indexOf(facts.diedAt) : facts?.kind === "infra" ? 0 : undefined;
  if (failed !== undefined) {
    return index < failed ? "passed" : index === failed ? "failed" : "pending";
  }
  if (run.data.status === "no-changes") return index === 0 ? "passed" : "skipped";
  return "passed";
}

/** The five pipeline labels — the last reads "PR" once a pull request exists,
 *  else "Approve" (the terminal gate). Kept short: the track labels are tiny. */
function trackLabels(run: FleetRun): string[] {
  return ["Agent", "Scope", "Verify", "Judge", run.kind === "completed" && run.data.prUrl ? "PR" : "Approve"];
}

/** A queue row's miniature pipeline: the same `pipelineState` the Run view reads,
 *  rendered as five 8px nodes with filling connectors between them. A compact
 *  readout of where the run got to — the Instrument's language, at row scale. */
function runTrack(run: FleetRun): HTMLElement {
  const track = document.createElement("span");
  track.className = "run-row-track";
  for (let index = 0; index < 5; index += 1) {
    if (index > 0) {
      const connector = document.createElement("span");
      connector.className = "mt-conn";
      const fill = document.createElement("span");
      fill.className = "mt-fill";
      fill.style.transform = pipelineState(run, index - 1) === "passed" ? "scaleX(1)" : "scaleX(0)";
      connector.append(fill);
      track.append(connector);
    }
    const node = document.createElement("span");
    node.className = `mt-node ${pipelineState(run, index)}`;
    track.append(node);
  }
  return track;
}

/** The evidence transcript, in order — a completed run's recorded gate lines
 *  (or its reason), or a synthesised pair for a run still live on the runner. */
function runEvidence(run: FleetRun): string[] {
  return run.kind === "completed"
    ? run.data.evidence ?? (run.data.reason ? [run.data.reason] : [])
    : [
        `${statusLabel(run.data.stage)} since ${new Date(run.data.stageSince).toLocaleTimeString()}`,
        `Attempt ${run.data.attempt} is active on the remote runner`,
      ];
}

type SpotTone = "live" | "review" | "failure" | "done" | "neutral";
/** The gate the operator's eye should land on, and how to say it. `key` is the
 *  identity the render diffs on — when it changes the card slides in anew. */
interface Spotlight {
  key: string;
  eyebrow: string;
  title: string;
  detail: string;
  tone: SpotTone;
  icon: string;
}

/** The Instrument's focus: the live gate while a run is in flight, the gate it
 *  *stopped at* when it failed, and the outcome (awaiting co-sign / merged /
 *  closed / approved / no-changes) once it is decided. One derivation, read
 *  from the contract's fate table so it never restates a status the contract
 *  owns — the pipeline track shows every gate; this names the one that matters. */
function spotlightFor(run: FleetRun): Spotlight {
  if (run.kind === "inflight") {
    return {
      key: `live:${run.data.stage}`,
      eyebrow: "Live gate",
      title: statusLabel(run.data.stage),
      detail: `Attempt ${run.data.attempt} · active since ${new Date(run.data.stageSince).toLocaleTimeString()}`,
      tone: "live",
      icon: "loader-circle",
    };
  }
  const data = run.data;
  if (awaitingReview(gateInput(run))) {
    return {
      key: "review",
      eyebrow: "Your move",
      title: "Awaiting your co-sign",
      detail: `PR #${prNumber(data.prUrl)} open · ${verifyReadout(data).phrase} · judge approved`,
      tone: "review",
      icon: "git-pull-request",
    };
  }
  const cosign = cosignFor(run);
  if (cosign?.state === "merged") {
    return {
      key: "merged",
      eyebrow: "Outcome",
      title: "Merged",
      detail: cosign.mergedBy ? `Co-signed by ${cosign.mergedBy}` : "Squash-merged into the base branch",
      tone: "done",
      icon: "git-merge",
    };
  }
  if (cosign?.state === "closed") {
    return {
      key: "closed",
      eyebrow: "Outcome",
      title: "Closed",
      detail: "Closed without merging — reason posted to the PR",
      tone: "neutral",
      icon: "git-pull-request-closed",
    };
  }
  const facts = runFacts(data.status);
  if (facts?.diedAt || facts?.kind === "infra" || facts?.kind === "killed") {
    // Why it stopped, read from the field the runner records for exactly this.
    // This used to search the evidence prose for a line containing the gate's
    // name, which matched for `scope` and `agent` — whose evidence happens to
    // open with those words — and never for `verify` or `judge`, whose evidence
    // opens with the failing check's label or `veto:`. So two kills showed a
    // scraped line and two silently fell through to `reason`, with nothing
    // marking the difference.
    const line = data.reason ?? "No gate evidence recorded.";
    return {
      key: `fail:${data.status}`,
      eyebrow: "Stopped at",
      title: statusLabel(data.status),
      detail: line,
      tone: "failure",
      icon: facts?.kind === "infra" ? "alert-circle" : "x-circle",
    };
  }
  if (data.status === "no-changes") {
    return {
      key: "nochanges",
      eyebrow: "Outcome",
      title: "No changes",
      detail: data.reason ?? "The agent made no changes — nothing to verify or ship.",
      tone: "neutral",
      icon: "circle",
    };
  }
  return {
    key: "approved",
    eyebrow: "Outcome",
    title: statusLabel(data.status),
    detail: `${duration(data.elapsedMs)} · ${verifyReadout(data).phrase} · judge approved`,
    tone: "done",
    icon: "check-circle-2",
  };
}

type ReadoutTone = "ok" | "bad" | "warn" | "working" | "neutral";
/** One telemetry pill in the gate band's base — a fact about *this* run, toned
 *  so verify-green / stopped-red land at a glance. `ok`/`bad`/`warn`/`working`
 *  carry a redundant icon (✓/✗/⚠/spinner) over colour; `neutral` facts stay
 *  quiet text. */
interface GateReadout {
  label: string;
  value: string;
  tone: ReadoutTone;
}

/** The gate band's readout strip, derived from the run — never a fixed grid, so
 *  it shows exactly what a state has (an in-flight run's stage/attempt, a
 *  failure's stopped-at + duration, a shipped run's verify/judge/co-sign). Reads
 *  the gates from `pipelineState` and the fate from the contract, so it never
 *  restates a status the contract owns. */
function gateReadouts(run: FleetRun): GateReadout[] {
  if (run.kind === "inflight") {
    return [
      { label: "Stage", value: statusLabel(run.data.stage), tone: "working" },
      { label: "Attempt", value: String(run.data.attempt), tone: "neutral" },
      { label: "Elapsed", value: relativeTime(run.data.startedAt), tone: "neutral" },
    ];
  }
  const data = run.data;
  const facts = runFacts(data.status);
  if (facts?.diedAt || facts?.kind === "infra" || facts?.kind === "killed") {
    const out: GateReadout[] = [{ label: "Stopped at", value: statusLabel(data.status), tone: "bad" }];
    if (data.vetoes) out.push({ label: "Vetoes", value: String(data.vetoes), tone: "bad" });
    out.push({ label: "Duration", value: duration(data.elapsedMs), tone: "neutral" });
    out.push({ label: "Mode", value: data.mode, tone: "neutral" });
    return out;
  }
  if (data.status === "no-changes") {
    return [
      { label: "Diff", value: "Empty", tone: "neutral" },
      { label: "Duration", value: duration(data.elapsedMs), tone: "neutral" },
      { label: "Mode", value: data.mode, tone: "neutral" },
    ];
  }
  // A shipped run: what verification actually proved (read from the recorded
  // state — an approved run is not evidence that anything ran), judge approved,
  // plus the decision facts it carries.
  const verify = verifyReadout(data);
  const out: GateReadout[] = [
    { label: "Verify", value: verify.value, tone: verify.tone },
    { label: "Judge", value: "Approved", tone: "ok" },
    { label: "Duration", value: duration(data.elapsedMs), tone: "neutral" },
  ];
  if (data.sha) out.push({ label: "Commit", value: data.sha, tone: "neutral" });
  const cosign = cosignFor(run);
  if (cosign?.state === "merged" && cosign.mergedBy) out.push({ label: "Co-signed", value: cosign.mergedBy, tone: "neutral" });
  else if (cosign?.state === "closed") out.push({ label: "PR", value: "Closed", tone: "neutral" });
  else if (data.prUrl) out.push({ label: "PR", value: `#${prNumber(data.prUrl)}`, tone: "neutral" });
  return out;
}

/**
 * Direction B — the Instrument. The horizontal pipeline is the hero: connectors
 * *fill* left-to-right as gates pass, and a spotlight card foregrounds the one
 * gate in play. Rendered from state on every poll like the rest of the shell,
 * but diffed against `prevRunView`: a stage that advanced since the last render
 * of the *same* run animates (connector fill, check stamp, spotlight slide),
 * while a freshly selected run staggers its whole composition in, and an
 * unchanged re-render is silent. All motion is reduced-motion aware.
 */
function renderInstrument(run: FleetRun): void {
  const states = [0, 1, 2, 3, 4].map((index) => pipelineState(run, index));
  const spot = spotlightFor(run);
  const sameRun = prevRunView?.key === selectedKey;
  const prevStates = sameRun ? prevRunView!.states : [];
  const reduce = prefersReducedMotion();
  const labels = trackLabels(run);

  // ── The pipeline track: nodes, filling connectors, labels ──
  const track = $("#pipeline");
  track.replaceChildren();
  const toStamp: number[] = [];
  states.forEach((state, index) => {
    if (index > 0) {
      const connector = document.createElement("div");
      connector.className = "inst-conn";
      const fill = document.createElement("div");
      fill.className = "inst-conn-fill";
      const filled = states[index - 1] === "passed";
      fill.style.transform = filled ? "scaleX(1)" : "scaleX(0)";
      connector.append(fill);
      track.append(connector);
      if (!reduce && sameRun && filled && prevStates[index - 1] !== "passed") {
        fill.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 440, easing: EASE_INOUT, fill: "both" });
      }
    }
    const wrap = document.createElement("div");
    wrap.className = "inst-node-wrap";
    wrap.dataset.idx = String(index);
    const node = document.createElement("div");
    node.className = `inst-node ${state}`;
    const icon = state === "passed" ? "check" : state === "failed" ? "x-circle" : state === "active" ? "loader-circle" : "circle";
    node.innerHTML = `<i data-lucide="${icon}"></i>`;
    const label = document.createElement("div");
    label.className = `inst-label ${state === "pending" || state === "skipped" ? "" : "on"}`;
    label.textContent = labels[index];
    wrap.append(node, label);
    track.append(wrap);
    if (!reduce && sameRun && state === "passed" && prevStates[index] !== "passed") toStamp.push(index);
  });
  refreshIcons(track);
  const cleared = states.filter((state) => state === "passed").length;
  $("#pipeline-sub").textContent = `${cleared} / ${states.length} gates cleared`;
  if (!reduce && !sameRun) {
    track.querySelectorAll<HTMLElement>(".inst-node-wrap").forEach((wrap, index) =>
      wrap.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: 45 * index, easing: EASE_OUT, fill: "both" }));
  }
  for (const index of toStamp) {
    const svg = track.querySelector(`.inst-node-wrap[data-idx="${index}"] .inst-node svg`);
    svg?.animate([{ transform: "scale(0.4)", opacity: "0.4" }, { transform: "scale(1)", opacity: "1" }], { duration: 300, easing: EASE_SETTLE, fill: "both" });
  }

  // ── The gate band: a full-width banner — tone badge + eyebrow/title/detail,
  //    over a flex strip of status-icon telemetry pills read from the run. ──
  const spotEl = $("#gate-spotlight");
  spotEl.className = `gate-spot ${spot.tone}`;
  spotEl.innerHTML = `<div class="gate-spot-body"><span class="gate-spot-badge"><i data-lucide="${spot.icon}"></i></span><span class="gate-spot-main"><span class="gate-spot-eyebrow"></span><h3 class="gate-spot-title"></h3><p class="gate-spot-detail"></p></span></div><div class="gate-spot-pills"></div>`;
  spotEl.querySelector(".gate-spot-eyebrow")!.textContent = spot.eyebrow;
  spotEl.querySelector(".gate-spot-title")!.textContent = spot.title;
  spotEl.querySelector(".gate-spot-detail")!.textContent = spot.detail;
  const pills = spotEl.querySelector(".gate-spot-pills")!;
  for (const readout of gateReadouts(run)) {
    const pill = document.createElement("span");
    pill.className = `gate-pill ${readout.tone}`;
    const pillIcon =
      readout.tone === "ok" ? "check"
      : readout.tone === "bad" ? "x"
      : readout.tone === "warn" ? "alert-circle"
      : readout.tone === "working" ? "loader-circle"
      : null;
    if (pillIcon) {
      const iconWrap = document.createElement("span");
      iconWrap.className = "gate-pill-ic";
      iconWrap.innerHTML = `<i data-lucide="${pillIcon}"></i>`;
      pill.append(iconWrap);
    }
    const key = document.createElement("span");
    key.className = "gate-pill-k";
    key.textContent = readout.label;
    const value = document.createElement("span");
    value.className = "gate-pill-v";
    value.textContent = readout.value;
    pill.append(key, value);
    pills.append(pill);
  }
  refreshIcons(spotEl);
  if (!reduce && (!sameRun || prevRunView!.spot !== spot.key)) {
    spotEl.animate([{ opacity: 0, transform: "translateX(10px)" }, { opacity: 1, transform: "none" }], { duration: 280, easing: EASE_OUT, fill: "both" });
  }

  // ── The evidence transcript: secondary context under the spotlight ──
  const evidence = runEvidence(run);
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
      if (!reduce && !sameRun) row.animate([{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }], { duration: 240, delay: 60 + 30 * index, easing: EASE_OUT, fill: "both" });
    });
  }

  prevRunView = { key: selectedKey, states, spot: spot.key };
}

function renderSelectedRun(): void {
  const run = selectedRun();
  const previewOpen = Boolean(run && artifactPreview?.runKey === run.key);
  $("#run-empty").toggleAttribute("hidden", Boolean(run));
  $("#run-detail").toggleAttribute("hidden", !run || previewOpen);
  $("#artifact-preview").toggleAttribute("hidden", !previewOpen);

  if (!run) {
    artifactPreview = null;
    prevRunView = null;
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

  renderInstrument(run);
  renderMetadata(run);
}

/** Run-details rows for the PR's live merge state — the decision record. */
function cosignRows(run: FleetRun): Array<[string, string]> {
  const cosign = cosignFor(run);
  const chip = cosignChip(run);
  if (!cosign || !chip) return [];
  const rows: Array<[string, string]> = [["Pull request", chip.detail]];
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
  renderDefinitionRows(list, rows);
  renderCosignDecision(run);
}

function renderDefinitionRows(list: HTMLElement, rows: Array<[string, string]>): void {
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

function prNumber(prUrl: string | undefined): string {
  return prUrl?.match(/\/pull\/(\d+)/)?.[1] ?? "?";
}

/** Open the selected run's PR in the browser — HTTPS only, opener severed.
 *  Every open-the-PR affordance (header button, Review tab, decision block)
 *  goes through here. */
function openSelectedPr(): void {
  const run = selectedRun();
  if (run?.kind !== "completed" || !run.data.prUrl) return;
  try {
    const url = new URL(run.data.prUrl);
    if (url.protocol !== "https:") throw new Error("Pull request URL is not HTTPS");
    window.open(url, "_blank", "noopener");
  } catch (error) {
    toast(String(error), true);
  }
}

/** Refusal `code` selects icon and tone only — the detail text is never touched. */
function refusalPresentation(code: string): { icon: string; tone: "failure" | "neutral" } {
  if (code === "already-merged") return { icon: "git-merge", tone: "neutral" };
  if (code === "already-closed") return { icon: "git-pull-request-closed", tone: "neutral" };
  return { icon: "x-circle", tone: "failure" };
}

/** Operator copy for a cloud run's evidence-sync state, shared by the Review tab
 *  and the co-sign rail so both name the same state the same way. */
function syncNotice(sync: SyncState): { icon: string; title: string; detail: string } {
  if (sync.kind === "syncing") {
    return {
      icon: "loader-circle",
      title: "Syncing evidence from GitHub",
      detail: "Fetching this cloud run's artifacts from GitHub Actions — the diff appears here as soon as the download lands.",
    };
  }
  if (sync.kind === "retryable") {
    return { icon: "refresh-cw", title: "Evidence sync interrupted", detail: sync.detail };
  }
  return { icon: "alert-circle", title: "Evidence unavailable", detail: sync.reason };
}

/** The sync state as a co-sign-rail block — mirrors the refusal block's shape. */
function syncBlock(sync: SyncState): HTMLElement {
  const { icon, title, detail } = syncNotice(sync);
  const block = document.createElement("div");
  block.className = `cosign-sync ${sync.kind}`;
  block.innerHTML = `<i data-lucide="${icon}"></i><div><strong></strong><span></span></div>`;
  block.querySelector("strong")!.textContent = title;
  block.querySelector("span")!.textContent = detail;
  return block;
}

/** The GitHub PR fallback — the explicit escape hatch when evidence is gone,
 *  never the default. */
function reviewOnGithubButton(): HTMLButtonElement {
  const github = document.createElement("button");
  github.className = "secondary compact cosign-review-github";
  github.innerHTML = `<i data-lucide="git-pull-request"></i><span>Review on GitHub</span>`;
  github.addEventListener("click", openSelectedPr);
  return github;
}

/** Re-check a stalled cloud sync — re-opening the run re-triggers the runner's
 *  on-demand download once its retry cooldown passes. */
function retrySyncButton(): HTMLButtonElement {
  const retry = document.createElement("button");
  retry.className = "secondary compact cosign-retry";
  retry.disabled = busy;
  retry.innerHTML = `<i data-lucide="refresh-cw"></i><span>Retry sync</span>`;
  retry.addEventListener("click", () => void retrySync());
  return retry;
}

async function retrySync(): Promise<void> {
  await loadArtifactsForSelected();
  renderArtifacts();
  renderSelectedRun();
  if (workspaceView === "review") await ensureReviewLoaded();
  renderReview();
}

/** The affordances a sync state carries — decided once, appended by both the
 *  Review tab and the co-sign rail so the two surfaces never diverge: a retry
 *  for a transient failure, the GitHub PR fallback when the evidence is gone. */
function syncActions(sync: SyncState, prUrl: string | undefined): HTMLButtonElement[] {
  if (sync.kind === "retryable") return [retrySyncButton()];
  if (sync.kind === "unavailable" && prUrl) return [reviewOnGithubButton()];
  return [];
}

/**
 * The decision block in the run-details rail: the merge and close buttons for
 * runs the gate could accept, the blocking reason in their place for every
 * other run, and a witnessed refusal verbatim where the buttons were. Always
 * evidence-adjacent — this is the only surface that renders it. A refusal that
 * leaves the PR open (conflicts, not-mergeable) keeps the buttons below it, so
 * a retry after the operator fixes the cause never needs a reconnect — the
 * runner's gate stays the real gate. A closed run gains "Run again", which
 * only prefills the launch form: launching stays an explicit human action.
 */
type DecisionTone = "review" | "done" | "failure" | "neutral" | "live";
interface DecisionHead {
  tone: DecisionTone;
  icon: string;
  eyebrow: string;
  title: string;
  detail: string;
}

/** The co-sign beat, stated once and tinted to match: the rail's decision block
 *  is the actionable half of the run's fate. Where the Run view's spotlight names
 *  the *status* ("Awaiting your co-sign"), this names the *decision* ("Ready to
 *  co-sign — squash-merge, or close with a reason") — a header over the buttons,
 *  read from the same fate table so it never restates a status the contract owns. */
function decisionHead(run: FleetRun): DecisionHead {
  if (run.kind === "inflight") {
    return { tone: "live", icon: "loader-circle", eyebrow: "Co-sign gate", title: "Not open yet", detail: "This run is still working on the runner — the co-sign gate opens once it ships a pull request." };
  }
  const cosign = cosignFor(run);
  if (cosign?.state === "merged") {
    return { tone: "done", icon: "git-merge", eyebrow: "Outcome", title: "Merged", detail: cosign.mergedBy ? `Co-signed by ${cosign.mergedBy} — squash-merged into the base branch.` : "Squash-merged into the base branch." };
  }
  if (cosign?.state === "closed") {
    return { tone: "neutral", icon: "git-pull-request-closed", eyebrow: "Outcome", title: "Closed", detail: "Closed without merging — the reason was posted to the pull request." };
  }
  if (awaitingReview(gateInput(run))) {
    // The detail sentence reads the recorded verification state rather than
    // asserting "every gate green" for anything the gate would accept (#59).
    const affordance = cosignAffordance(run.data, { prNumber: prNumber(run.data.prUrl), retry: false });
    return { tone: "review", icon: "git-pull-request", eyebrow: "Your move", title: "Ready to co-sign", detail: affordance.detail };
  }
  const facts = runFacts(run.data.status);
  if (facts?.diedAt || facts?.kind === "infra" || facts?.kind === "killed") {
    return { tone: "failure", icon: "x-circle", eyebrow: "Blocked", title: "Nothing to co-sign", detail: "This run stopped at a gate — no pull request was opened. Fix the cause and run it again." };
  }
  if (run.data.status === "no-changes") {
    return { tone: "neutral", icon: "circle", eyebrow: "Outcome", title: "No changes", detail: run.data.reason ?? "The agent made no changes — nothing to review or ship." };
  }
  // "Every gate passed." was a literal here too — true only when it was (#59).
  return { tone: "done", icon: "check-circle-2", eyebrow: "Outcome", title: "Approved", detail: outcomeDetail(run.data) };
}

function renderCosignDecision(run: FleetRun | undefined): void {
  const container = $("#cosign-decision");
  container.replaceChildren();
  container.hidden = !run;
  if (!run) return;

  // The tonal spotlight card: the header names the decision, the body carries the
  // mechanics — buttons, a witnessed refusal, a cloud run's evidence-sync, or the
  // blocking reason. Every append below targets `body`, so the block reads as one
  // card tinted to the run's fate.
  const head = decisionHead(run);
  const card = document.createElement("div");
  card.className = `decision-spot ${head.tone}`;
  card.innerHTML = `<div class="decision-spot-head"><i data-lucide="${head.icon}"></i><span class="decision-spot-eyebrow"></span></div><div class="decision-spot-title"></div><p class="decision-spot-detail"></p><div class="decision-spot-actions"></div>`;
  card.querySelector(".decision-spot-eyebrow")!.textContent = head.eyebrow;
  card.querySelector(".decision-spot-title")!.textContent = head.title;
  card.querySelector(".decision-spot-detail")!.textContent = head.detail;
  const body = card.querySelector<HTMLElement>(".decision-spot-actions")!;
  container.append(card);

  const refusal = cosignRefusals[run.key];
  if (refusal) {
    const first = refusal.refusals[0]
      ?? { code: refusal.action === "close" ? "close-failed" : "merge-failed", detail: "no detail returned" };
    const { icon, tone } = refusalPresentation(first.code);
    const block = document.createElement("div");
    block.className = `cosign-refusal ${tone}`;
    block.innerHTML = `<i data-lucide="${icon}"></i><div><strong></strong></div>`;
    block.querySelector("strong")!.textContent =
      `${refusal.action === "close" ? "Close" : "Merge"} refused — ${first.code}`;
    for (const { detail } of refusal.refusals) {
      const line = document.createElement("span");
      line.textContent = detail;
      block.querySelector("div")!.append(line);
    }
    body.append(block);
  }

  const blocker = status.state !== "connected" && !previewMode
    ? "Runner disconnected — reconnect to co-sign."
    : mergeBlocker(gateInput(run));

  // Hard invariant: no showable diff, no co-sign button (#36) — the app never
  // offers a merge whose diff it cannot show. A cloud run's diff arrives via the
  // on-demand sync, so the button waits on the diff itself, not merely on a
  // "synced" signal: while it's fetching, gone, or the archive landed without a
  // diff, the sync state stands in the button's place, `unavailable` keeping the
  // GitHub PR as the explicit fallback. A local run's diff is captured beside
  // it, so it is never gated here.
  if (!blocker && run.kind === "completed" && run.data.mode === "cloud") {
    const diffReady = artifactsLoadedFor === run.key && artifacts.some((a) => a.name === "diff.patch");
    if (!diffReady) {
      const sync: SyncState = artifactSync
        ?? (artifactsLoadedFor === run.key
          ? { kind: "unavailable", reason: "the synced cloud artifact held no reviewable diff" }
          : { kind: "syncing" });
      body.append(syncBlock(sync), ...syncActions(sync, run.data.prUrl));
      refreshIcons(container);
      return;
    }
  }

  if (blocker) {
    const reason = document.createElement("div");
    reason.className = "cosign-blocker";
    reason.textContent = blocker;
    body.append(reason);
    if (run.kind === "completed" && cosignFor(run)?.state === "closed") {
      const again = document.createElement("button");
      again.className = "secondary compact cosign-run-again";
      again.disabled = busy;
      again.innerHTML = `<i data-lucide="rotate-ccw"></i><span>Run again</span>`;
      again.addEventListener("click", () => prefillLaunchForm(run));
      body.append(again);
    }
  } else {
    const number = prNumber(run.kind === "completed" ? run.data.prUrl : undefined);
    // The button carries the warning itself, so a co-signer who reads only the
    // thing they are about to press still learns the run was never proven (#59).
    // It is never withheld: an unmet mandate is non-blocking by #61, and the
    // gate that can refuse is `mergeBlocker`, which stays verify-blind.
    const affordance = cosignAffordance(run.kind === "completed" ? run.data : {}, {
      prNumber: number,
      retry: refusal?.action === "merge",
    });
    const merge = document.createElement("button");
    merge.className = `primary compact cosign-merge ${affordance.stance}`;
    merge.disabled = busy;
    merge.innerHTML = `<i data-lucide="${affordance.mergeIcon}"></i><span></span>`;
    merge.querySelector("span")!.textContent = busy ? "Working…" : affordance.mergeLabel;
    merge.addEventListener("click", () => openMergeConfirm(run.key));
    const close = document.createElement("button");
    close.className = "secondary compact cosign-close";
    close.disabled = busy;
    close.innerHTML = `<i data-lucide="git-pull-request-closed"></i><span></span>`;
    close.querySelector("span")!.textContent = busy
      ? "Working…"
      : `${refusal?.action === "close" ? "Retry close" : "Close"} PR #${number} with a reason`;
    close.addEventListener("click", () => openCloseConfirm(run.key));
    body.append(merge, close);
  }
  refreshIcons(container);
}

/**
 * "Run again" on a closed run: prefill the launch form (task, repo, PR toggle)
 * and nothing else — the run starts only when the operator presses Run. Honest
 * when the catalog has moved on: a task or repo that no longer exists is named
 * instead of silently leaving the previous selection in place.
 */
function prefillLaunchForm(run: FleetRun & { kind: "completed" }): void {
  taskSelect.value = run.data.task;
  repoSelect.value = run.data.repo;
  prToggle.checked = Boolean(run.data.prUrl);
  const missing = taskSelect.value !== run.data.task
    ? `task ${run.data.task}`
    : repoSelect.value !== run.data.repo
      ? `repository ${run.data.repo}`
      : null;
  renderCatalog();
  if (missing) toast(`Cannot prefill — ${missing} is no longer in the catalog.`, true);
  else toast(`Launch form prefilled: ${run.data.task} on ${run.data.repo}. Run stays your call.`);
}

/** The run key the open confirm dialog is about. */
let mergeCandidate = "";

/** Restates the stakes from data the app already has, then hands the real
 *  decision to the runner's gate — no typed challenge, just informed consent. */
function openMergeConfirm(key: string): void {
  const run = runs.find((item) => item.key === key);
  if (!run || run.kind !== "completed" || !run.data.prUrl) return;
  mergeCandidate = key;
  // Both halves read the recorded state. This sentence used to say "verify
  // green" for every run, including one whose mandated gate never ran — the
  // false green this whole map exists to close, in the one place that asks for
  // a signature.
  $("#merge-stakes").textContent =
    `Squash-merge PR #${prNumber(run.data.prUrl)} into ${run.data.repo} — ${mergeStakesClaim(run.data)}. ` +
    "The branch is deleted after the merge.";
  renderDefinitionRows($("#merge-facts"), [
    ["Task", run.data.task],
    ["Repository", run.data.repo],
    ["Pull request", `#${prNumber(run.data.prUrl)} — open`],
    ["Verify", verifyReadout(run.data).value],
    ["Judge", "Approved"],
  ]);
  // The submit button is the one that actually signs, so it wears the warning
  // too — leaving it plain would protect the signature itself with prose alone,
  // which is the state #59 item 1 rejected.
  const affordance = cosignAffordance(run.data, { prNumber: prNumber(run.data.prUrl), retry: false });
  const confirm = $("#confirm-merge");
  confirm.className = `primary cosign-merge ${affordance.stance}`;
  // Rebuilt rather than patched: `refreshIcons` swaps each `<i>` for an `<svg>`,
  // so the placeholder is gone by the second open.
  confirm.innerHTML = `<i data-lucide="${affordance.mergeIcon}"></i><span></span>`;
  confirm.querySelector("span")!.textContent = affordance.confirmLabel;
  refreshIcons(mergeDialog);
  mergeDialog.showModal();
}

/** The run key the open close dialog is about. */
let closeCandidate = "";

/** The negative path's confirm: the required reason is typed here, cap visible,
 *  and the dialog refuses to dispatch without one. */
function openCloseConfirm(key: string): void {
  const run = runs.find((item) => item.key === key);
  if (!run || run.kind !== "completed" || !run.data.prUrl) return;
  closeCandidate = key;
  $("#close-stakes").textContent =
    `Close PR #${prNumber(run.data.prUrl)} on ${run.data.repo} without merging. ` +
    "Your reason is posted verbatim as the PR comment — the branch and the run's artifacts stay put.";
  closeReasonInput.value = "";
  renderCloseReasonCount();
  closeDialog.showModal();
}

function renderCloseReasonCount(): void {
  $("#close-reason-count").textContent = `${closeReasonInput.value.length} / ${MAX_REASON_LENGTH}`;
}

/** Preview cosigns succeed; `?preview&refuse` exercises the refusal state —
 *  witnessed refusals are a feature, so the dev preview must show them. */
function previewCosignResult(run: FleetRun & { kind: "completed" }, action: "merge" | "close"): Receipt {
  const refuse = new URLSearchParams(window.location.search).has("refuse");
  const base = { action, runId: run.data.runId, task: run.data.task, repo: run.data.repo, prUrl: run.data.prUrl };
  const line = JSON.stringify(
    refuse
      ? { ...base, ok: false, refusals: [action === "merge" ? { code: "not-mergeable", detail: "blocked by required checks or reviews" } : { code: "close-failed", detail: "gh pr close failed: GraphQL: was submitted too quickly" }] }
      : action === "merge"
        ? { ...base, ok: true, state: "merged", mergedSha: "9fe31c7", mergedBy: "operator", mergedAt: new Date().toISOString(), refusals: [] }
        : { ...base, ok: true, state: "closed", refusals: [] },
  );
  return {
    command: `ssh fleet@runner fleet cosign ${run.data.runId} --${action}`,
    exitStatus: refuse ? 1 : 0,
    stdoutTail: `> spotify-stack@0.1.0 fleet /srv/spotify-stack\n\n${line}`,
    stderrTail: "",
    timestamp: Date.now(),
  };
}

/** Both cosign verbs share one path: fixed command over SSH, structured result
 *  parsed from the last JSON line, state refreshed from the result immediately
 *  and reconciled by the next co-sign poll. */
async function executeCosign(key: string, action: "merge" | "close", reason?: string): Promise<void> {
  const run = runs.find((item) => item.key === key);
  const profile = activeProfile();
  const verb = action === "merge" ? "Merge" : "Close";
  if (!run || run.kind !== "completed" || !run.data.runId || !run.data.prUrl) return;
  if (!previewMode && (status.state !== "connected" || !profile)) return;
  setBusy(true);
  try {
    const result: Receipt = previewMode
      ? previewCosignResult(run, action)
      : await invoke<RemoteCommandResult>("execute_fleet_action", {
          profile,
          action: action === "merge"
            ? { kind: "cosignMerge", runId: run.data.runId }
            : { kind: "cosignClose", runId: run.data.runId, reason },
        });
    result.cosign = parseCosignStdout(result.stdoutTail) ?? undefined;
    results.unshift(result);
    if (result.cosign?.ok && result.cosign.state === "merged") {
      cosigns[run.data.prUrl] = {
        state: "merged",
        mergedBy: result.cosign.mergedBy,
        mergedAt: result.cosign.mergedAt,
      };
      delete cosignRefusals[key];
      toast(`PR #${prNumber(run.data.prUrl)} squash-merged`);
    } else if (result.cosign?.ok && result.cosign.state === "closed") {
      cosigns[run.data.prUrl] = { state: "closed" };
      delete cosignRefusals[key];
      toast(`PR #${prNumber(run.data.prUrl)} closed — reason posted as the PR comment`);
    } else if (result.cosign) {
      cosignRefusals[key] = result.cosign;
      toast(`${verb} refused: ${result.cosign.refusals[0]?.code ?? "no reason returned"}`, true);
    } else {
      toast(`${verb} command exited ${result.exitStatus} without a structured result`, true);
    }
  } catch (error) {
    toast(String(error), true);
  } finally {
    setBusy(false);
    renderAll();
  }
}

function renderArtifacts(): void {
  $("#artifact-count").textContent = String(artifacts.length);
  const list = $("#artifact-list");
  list.replaceChildren();
  if (artifacts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rail-empty";
    empty.textContent = selectedRun()?.kind === "inflight"
      ? "Available when the run completes"
      : artifactsSuperseded
        ? "Overwritten by a later run"
        : "No artifacts";
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

/** The cosign receipt's body — for a merge: squash sha, merged-by, merged-at,
 *  branch deleted; for a close: the closed state and where the reason went;
 *  for a refusal, every refusal line verbatim. */
function cosignReceiptBody(result: CosignResult): HTMLElement {
  const body = document.createElement("div");
  body.className = "receipt-cosign";
  if (result.ok) {
    const rows: Array<[string, string]> = result.state === "merged"
      ? [
          ["Squash sha", result.mergedSha ?? "unknown"],
          ["Merged by", result.mergedBy ?? "unknown"],
          ["Merged at", result.mergedAt ? new Date(result.mergedAt).toLocaleString() : "unknown"],
          ["Branch", "deleted"],
        ]
      : [
          ["Pull request", "closed without merging"],
          ["Reason", "posted verbatim as the PR comment"],
        ];
    for (const [term, value] of rows) {
      const row = document.createElement("div");
      row.innerHTML = `<span></span><b></b>`;
      row.querySelector("span")!.textContent = term;
      row.querySelector("b")!.textContent = value;
      body.append(row);
    }
  } else {
    for (const refusal of result.refusals) {
      const row = document.createElement("div");
      row.className = "refusal";
      row.innerHTML = `<span></span><b></b>`;
      row.querySelector("span")!.textContent = refusal.code;
      row.querySelector("b")!.textContent = refusal.detail;
      body.append(row);
    }
  }
  return body;
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
    prevTopReceipt = "";
    return;
  }
  for (const receipt of receipts) {
    const details = document.createElement("details");
    details.className = "receipt-row";
    const success = receipt.exitStatus === 0;
    const icon = receipt.cosign
      ? success
        ? receipt.cosign.state === "closed" ? "git-pull-request-closed" : "git-merge"
        : "x-circle"
      : success ? "check-circle-2" : "x-circle";
    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="receipt-state ${success ? "success" : "failure"}"><i data-lucide="${icon}"></i></span><span class="receipt-command"><strong></strong><small>${new Date(receipt.timestamp).toLocaleTimeString()} · exit ${receipt.exitStatus}</small></span><i data-lucide="chevron-right"></i>`;
    summary.querySelector("strong")!.textContent = receipt.command;
    details.append(summary);
    if (receipt.cosign) {
      details.open = true;
      details.append(cosignReceiptBody(receipt.cosign));
    }
    const output = document.createElement("pre");
    output.textContent = [receipt.stdoutTail, receipt.stderrTail].filter(Boolean).join("\n").trim() || "No output";
    details.append(output);
    list.append(details);
  }
  // A freshly-arrived receipt slides into the top of the feed; a plain re-render
  // of the same top row (every poll) stays still. Keyed on the top receipt's
  // timestamp+command so only a genuinely new command animates.
  const top = receipts[0];
  const signature = top ? `${top.timestamp}:${top.command}` : "";
  if (!prefersReducedMotion() && signature && prevTopReceipt && signature !== prevTopReceipt) {
    (list.firstElementChild as HTMLElement | null)?.animate(
      [{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }],
      { duration: 320, easing: EASE_OUT, fill: "both" },
    );
  }
  prevTopReceipt = signature;
  refreshIcons(list);
}

function renderView(): void {
  document.querySelectorAll<HTMLElement>(".workspace-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === workspaceView));
  $("#run-view").toggleAttribute("hidden", workspaceView !== "run");
  $("#review-view").toggleAttribute("hidden", workspaceView !== "review");
  $("#ledger-view").toggleAttribute("hidden", workspaceView !== "ledger");
  renderReview();
}

/** Fetch and parse the selected run's diff.patch once per run; every state the
 *  tab can show (loading, parsed, honest refusals) renders from `review`. */
async function ensureReviewLoaded(): Promise<void> {
  const run = selectedRun();
  // Mode-blind (#36): once a cloud run's diff archive has synced it lives in the
  // same per-run artifact set as a local run, fetched and parsed identically.
  if (!run || run.kind !== "completed") return;
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

function diffCounts(additions: number, deletions: number): HTMLElement {
  const counts = document.createElement("span");
  counts.className = "diff-counts";
  counts.innerHTML = `<b class="add"></b><b class="del"></b>`;
  counts.querySelector(".add")!.textContent = `+${additions}`;
  counts.querySelector(".del")!.textContent = `−${deletions}`;
  return counts;
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
  summary.innerHTML = `<i data-lucide="chevron-right"></i><span class="diff-path"></span><span class="diff-tags"></span>`;
  summary.querySelector(".diff-path")!.textContent = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const tagList = summary.querySelector(".diff-tags")!;
  for (const tag of diffFileTags(file)) {
    const chip = document.createElement("i");
    chip.textContent = tag;
    tagList.append(chip);
  }
  summary.append(diffCounts(file.additions, file.deletions));
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
  } else if (artifactSync) {
    // A cloud run whose diff archive is being fetched, is gone, or is waiting to
    // retry (#35/#36) — render the sync state verbatim. Syncing shows a spinner;
    // retryable offers a retry; unavailable names the reason and keeps the
    // GitHub PR as the explicit fallback. A synced cloud run has no sync state
    // and falls through to the same diff rendering a local run uses.
    const { icon, title, detail } = syncNotice(artifactSync);
    const notice = reviewNotice(icon, title, detail);
    notice.append(...syncActions(artifactSync, run.data.prUrl));
    container.append(notice);
  } else if (artifactsLoadedFor !== run.key) {
    container.append(reviewNotice("loader-circle", "Loading diff", "Fetching the run's artifacts from the runner."));
  } else if (!artifacts.find((artifact) => artifact.name === "diff.patch") && artifactsSuperseded) {
    const notice = reviewNotice("history", "Diff overwritten by a later run", "A later run of this task replaced the shared artifact set, so this run's local evidence is gone. Review the change on GitHub.");
    if (run.data.prUrl) {
      const open = document.createElement("button");
      open.className = "secondary compact";
      open.innerHTML = `<i data-lucide="git-pull-request"></i>Open PR`;
      open.addEventListener("click", openSelectedPr);
      notice.append(open);
    }
    container.append(notice);
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
    const heading = document.createElement("strong");
    heading.textContent = `${files.length} ${files.length === 1 ? "file" : "files"} changed`;
    summary.append(heading, diffCounts(additions, deletions));
    container.append(summary);
    for (const file of files) container.append(renderDiffFile(file));
  }
  refreshIcons(container);
}

/** The two contract-failure surfaces: a banner when a whole refresh envelope
 *  was unreadable (endpoint + field path, last-good data still on screen and
 *  timestamped), and a count when individual records had to be skipped. */
function renderWireStatus(): void {
  $("#wire-banner").toggleAttribute("hidden", !wireError);
  if (wireError) {
    const ago = lastUpdated ? relativeTime(lastUpdated.toISOString()) : null;
    const since = ago === null
      ? "no prior data to fall back on"
      : ago === "now"
        ? "showing last-good data from just now"
        : `showing last-good data from ${ago} ago`;
    $("#wire-detail").textContent = `${wireError.message} — ${since}.`;
  }
  const count = $("#unreadable-count");
  count.toggleAttribute("hidden", unreadableRecords === 0);
  count.textContent = `${unreadableRecords} ${unreadableRecords === 1 ? "record" : "records"} unreadable`;
}

function renderAll(): void {
  renderProfiles();
  renderConnection();
  renderWireStatus();
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
  renderCosignDecision(selectedRun());
}

/** Launching a run is the app's highest-intent act — give it weight: a shine
 *  sweeps across the button while it settles under the press (Dispatch carries the
 *  sweep; Run, a lighter settle). Zero-dep WAAPI, reduced-motion silent. */
function commitCeremony(button: HTMLElement): void {
  if (prefersReducedMotion()) return;
  button.querySelector<HTMLElement>(".commit-sweep")?.animate(
    [{ transform: "translateX(-120%)" }, { transform: "translateX(120%)" }],
    { duration: 520, easing: EASE_INOUT },
  );
  button.animate(
    [{ transform: "scale(1)" }, { transform: "scale(0.96)", offset: 0.35 }, { transform: "scale(1.02)", offset: 0.7 }, { transform: "scale(1)" }],
    { duration: 520, easing: EASE_SETTLE },
  );
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

/** The contract's transport: fetch a path over the SSH-forwarded runner and
 *  return its decoded JSON body, untyped. Every envelope is parsed from here on
 *  through the contract (`Endpoints.*` / the ingest layer), never trusted raw. */
const operatorGet: WireGet = (path) => invoke<unknown>("operator_get", { path });

function refreshLedgerFrame(): void {
  if (!status.url) return;
  ledgerFrame.src = refreshedLedgerUrl(status.url, Date.now());
  ledgerFrame.hidden = false;
  $("#ledger-empty").hidden = true;
}

async function refreshFleetData(): Promise<void> {
  if (previewMode) return loadPreviewData();
  const [ledgerRaw, inflightRaw] = await Promise.all([
    operatorGet(Endpoints.ledger.path),
    operatorGet(Endpoints.inflight.path),
  ]);
  let ledger: LedgerIngest;
  let inflight: InflightIngest;
  try {
    ledger = ingestLedger(ledgerRaw);
    inflight = ingestInflight(inflightRaw);
  } catch (error) {
    if (!(error instanceof WireParseError)) throw error;
    // A malformed refresh envelope: keep the last-good runs on screen — still
    // timestamped from their own refresh — and name the seam that broke.
    wireError = error;
    renderAll();
    return;
  }
  wireError = null;
  unreadableRecords = ledger.unreadable + inflight.unreadable;
  cosigns = ledger.cosigns ?? {};
  const completed: FleetRun[] = ledger.entries.map((entry, index) => ({ kind: "completed", key: entry.runId ?? `ledger-${entry.ts}-${entry.task}-${entry.repo}-${index}`, sortAt: entry.ts, data: entry }));
  // Enforce the one-row-per-run invariant at ingestion rather than trusting the
  // producer (ADR-0001): a run whose ledger line has landed is decided, so drop
  // its still-live inflight row instead of drawing it twice. The runner's
  // /api/inflight already dedupes, but the operator owns its own render.
  const liveRuns = dedupeInflight(ledger.entries, inflight.runs);
  const live: FleetRun[] = liveRuns.map((entry) => ({ kind: "inflight", key: entry.runId, sortAt: entry.startedAt, data: entry }));
  const nextRevision = fleetRevision(ledger.entries, liveRuns);
  const ledgerChanged = ledgerRefreshDecision(ledgerRevision, nextRevision);
  ledgerRevision = nextRevision;
  runs = [...live, ...completed].sort(queueOrder);
  // A refusal witnessed against an open PR stands until the co-sign poll moves
  // the PR's live state — from then on the blocking reason says it better.
  for (const key of Object.keys(cosignRefusals)) {
    const refused = runs.find((run) => run.key === key);
    if (!refused || cosignFor(refused)?.state !== "open") delete cosignRefusals[key];
  }
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
  // null = fetch failed: the list is unknown, not known-empty — the Review tab
  // must keep saying "fetching" (and let the poll retry), never "recorded nothing".
  let next: ArtifactMetadata[] | null = [];
  let nextSuperseded = false;
  let nextSync: SyncState | null = null;
  if (run && run.kind === "completed") {
    if (previewMode) {
      nextSync = previewSyncState(run);
      next = nextSync ? [] : previewArtifacts();
    } else if (run.data.runId) {
      try {
        const detail = await Endpoints.run.load(operatorGet, run.data.runId);
        next = detail.artifacts;
        if (detail.state === "completed") {
          nextSuperseded = detail.artifactsSuperseded === true;
          nextSync = detail.sync ?? null;
        }
      } catch {
        next = null;
      }
    }
  }
  if (request === artifactRequest && runKey === selectedKey) {
    artifacts = next ?? [];
    artifactsLoadedFor = next ? runKey : "";
    artifactsSuperseded = nextSuperseded;
    artifactSync = nextSync;
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
  artifactsSuperseded = false;
  artifactSync = null;
  renderQueue();
  renderSelectedRun();
  renderArtifacts();
  renderView();
  await loadArtifactsForSelected();
  renderArtifacts();
  // The decision rail's evidence gate depends on the artifact/sync state we just
  // loaded — re-render it so a synced cloud run gains its co-sign buttons.
  renderSelectedRun();
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

async function waitForCatalog(): Promise<CatalogResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try { return await Endpoints.catalog.load(operatorGet); }
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
  catalog = PREVIEW_CATALOG;
  const entries = previewLedgerEntries(now);
  const live = previewInflight(now);
  cosigns = previewCosigns(now);
  runs = [
    { kind: "inflight", key: live.runId, sortAt: live.startedAt, data: live },
    ...entries.map((entry) => ({ kind: "completed" as const, key: entry.runId!, sortAt: entry.ts, data: entry })),
  ];
  selectedKey = "review-me";
  artifacts = previewArtifacts();
  // The default run's evidence is already "loaded" so opening Review renders its
  // diff immediately; selecting another run re-loads through loadArtifactsForSelected.
  artifactsLoadedFor = selectedKey;
  results = [{ command: "ssh fleet@runner fleet dispatch 004-upstream-failure-mode-tests --repo demo-feed-service", exitStatus: 0, stdoutTail: "dispatched agent-task.yml", stderrTail: "", timestamp: now - 17 * 60_000 }];
  lastUpdated = new Date(now - 18_000);
}

/** Preview-only: the evidence-sync state a cloud run stands in for, or null for
 *  a synced run (diff and co-sign buttons render exactly like a local one). */
function previewSyncState(run: FleetRun): SyncState | null {
  if (run.kind !== "completed") return null;
  return PREVIEW_SYNC_STATES[run.data.runId ?? ""] ?? null;
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
    artifactsSuperseded = false;
    artifactSync = null;
    review = null;
    cosignRefusals = {};
    wireError = null;
    unreadableRecords = 0;
    ledgerRevision = "";
    ledgerFrame.src = "about:blank";
    ledgerFrame.hidden = true;
    $("#ledger-empty").hidden = false;
  } finally { setBusy(false); renderAll(); }
});
$("#dispatch-action").addEventListener("click", () => { commitCeremony($("#dispatch-action")); void runAction("dispatch"); });
$("#local-run").addEventListener("click", () => { commitCeremony($("#local-run")); void runAction("localRun"); });
$("#clear-activity").addEventListener("click", () => { results = []; renderActivity(); });
$("#toggle-rail").addEventListener("click", () => {
  const collapsed = workbench.classList.toggle("rail-collapsed");
  $("#toggle-rail").setAttribute("title", collapsed ? "Show evidence panel" : "Hide evidence panel");
  $("#toggle-rail").innerHTML = `<i data-lucide="${collapsed ? "panel-right-open" : "panel-right-close"}"></i>`;
  refreshIcons($("#toggle-rail"));
});
$("#open-pr").addEventListener("click", openSelectedPr);
$("#close-artifact").addEventListener("click", () => { artifactPreview = null; $("#artifact-preview").hidden = true; $("#run-detail").hidden = !selectedRun(); $("#run-empty").hidden = Boolean(selectedRun()); artifactFrame.src = "about:blank"; });
taskSelect.addEventListener("change", renderCatalog);
repoSelect.addEventListener("change", renderCatalog);
profileSelect.addEventListener("change", renderConnection);
$("#close-dialog").addEventListener("click", () => profileDialog.close());
$("#cancel-profile").addEventListener("click", () => profileDialog.close());
$("#close-merge-dialog").addEventListener("click", () => mergeDialog.close());
$("#cancel-merge").addEventListener("click", () => mergeDialog.close());
$("#merge-form").addEventListener("submit", () => {
  const key = mergeCandidate;
  mergeCandidate = "";
  void executeCosign(key, "merge");
});
$("#dismiss-close-dialog").addEventListener("click", () => closeDialog.close());
$("#cancel-close").addEventListener("click", () => closeDialog.close());
closeReasonInput.addEventListener("input", renderCloseReasonCount);
$("#close-form").addEventListener("submit", (event) => {
  // The dialog refuses to send without a reason — the runner would too, but
  // this failure belongs in the form, not in a receipt after an SSH round-trip.
  const problem = closeReasonProblem(closeReasonInput.value);
  if (problem) {
    event.preventDefault();
    toast(problem, true);
    return;
  }
  const key = closeCandidate;
  closeCandidate = "";
  void executeCosign(key, "close", closeReasonInput.value.trim());
});
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
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
  if (profileDialog.open || mergeDialog.open || closeDialog.open) return;
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
