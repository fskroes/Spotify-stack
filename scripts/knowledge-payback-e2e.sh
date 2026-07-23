#!/usr/bin/env bash
#
# knowledge-payback-e2e.sh — turnkey harness for the discriminating
# knowledge-payback experiment (issue #91).
#
# It runs one fleet task N times PRIMED (compiled knowledge injected) and N
# times COLD (artifact toggled aside so the run gets no knowledge), captures
# per-run evidence, and emits a SUMMARY.tsv comparing outcome + cost across the
# two arms. The question it exists to answer: does priming flip a task the cold
# arm gets wrong — and at what cost?
#
# It does NOT decide the result. It lines up the runs and records them
# trustworthily; a human reads SUMMARY.tsv. Each run is a real local fleet
# dispatch that SPENDS on the Claude subscription, so it is gated behind an
# explicit confirmation unless --yes is passed. Use --dry-run first to validate
# the plumbing with zero spend.
#
# The target and task are supplied by the caller — this harness is
# target-agnostic infrastructure and hardcodes no fleet target. The concrete
# candidate design for the #91 run lives with the private task definition.
#
# Usage:
#   scripts/knowledge-payback-e2e.sh --task <id> --target <name> [options]
#     --task <id>       task id or path        (required)
#     --target <name>   fleet repo name        (required)
#     --runs <N>        runs per arm           (default: 3)
#     --out <dir>       evidence output dir    (default: fleet/evidence/knowledge-payback/<ts>)
#     --dry-run         stub the fleet call; no spend, exercises all plumbing
#     --yes             skip the spend confirmation (real runs)
#     --allow-api-key   proceed even if ANTHROPIC_API_KEY is set (API billing!)
#
# Design notes:
#   * Toggle = artifact presence. `injectKnowledge` renders the existing prose
#     into <workspace>/.fleet-knowledge.md when the artifact exists, and logs
#     "· injected knowledge → …"; with no artifact it logs
#     "· no compiled knowledge for this target — running cold". The COLD arm
#     moves the artifact aside so that branch fires. Neither path spends to
#     compile (we never pass --recompile-knowledge).
#   * We NEVER pass --pr (dry-run dispatch, no PR) and NEVER
#     --recompile-knowledge (that is the only opt-in knowledge spend).
#   * We do NOT source .env — a stray ANTHROPIC_API_KEY there would flip the
#     claude CLI from the subscription to metered API billing.
#   * The artifact is restored via an EXIT trap and then byte-verified against a
#     pre-run sha256, and `git status` on the artifact path is asserted clean.
#
set -euo pipefail

# ---- defaults ---------------------------------------------------------------
TASK=""
TARGET=""
RUNS=3
DRY_RUN=0
ASSUME_YES=0
ALLOW_API_KEY=0
OUT=""

# ---- arg parsing ------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --task) TASK="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --allow-api-key) ALLOW_API_KEY=1; shift ;;
    -h|--help) sed -n '2,44p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TASK" ] || [ -z "$TARGET" ]; then
  echo "FATAL: --task <id> and --target <name> are both required." >&2
  echo "       (run with --help for usage)" >&2
  exit 2
fi

case "$RUNS" in
  ''|*[!0-9]*) echo "FATAL: --runs must be a positive integer, got '$RUNS'." >&2; exit 2 ;;
esac
[ "$RUNS" -ge 1 ] || { echo "FATAL: --runs must be >= 1, got '$RUNS'." >&2; exit 2; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

TS="$(date +%Y-%m-%dT%H-%M-%S)"
[ -n "$OUT" ] || OUT="fleet/evidence/knowledge-payback/$TS"
mkdir -p "$OUT"
SUMMARY="$OUT/SUMMARY.tsv"

# In dry-run, run-dir + evidence-dir detection reads a sandbox the stub writes
# to, so we never litter the real artifacts/ tree with fake runs.
if [ "$DRY_RUN" -eq 1 ]; then
  RUNS_DIR="$OUT/.dryrun/artifacts/runs"
  EVID_DIR="$OUT/.dryrun/fleet/evidence"
  mkdir -p "$RUNS_DIR" "$EVID_DIR"
else
  RUNS_DIR="artifacts/runs"
  EVID_DIR="fleet/evidence"
fi

# ---- resolve the knowledge artifact (toggle target) -------------------------
# Private targets store prose under knowledge/private/<t>.md, public under
# knowledge/<t>.md (see knowledgeArtifactPath). Detect by which exists.
ARTIFACT=""
if [ -f "knowledge/private/$TARGET.md" ]; then
  ARTIFACT="knowledge/private/$TARGET.md"
elif [ -f "knowledge/$TARGET.md" ]; then
  ARTIFACT="knowledge/$TARGET.md"
else
  echo "FATAL: no knowledge artifact for '$TARGET' (looked in knowledge/private/$TARGET.md and knowledge/$TARGET.md)." >&2
  echo "The experiment needs a real artifact to toggle; the primed arm has nothing to inject without it." >&2
  exit 1
fi
ASIDE="$ARTIFACT.payback-aside"
ARTIFACT_SHA="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"

echo "knowledge-payback-e2e"
echo "  task     : $TASK"
echo "  target   : $TARGET"
echo "  artifact : $ARTIFACT  (sha256 ${ARTIFACT_SHA:0:12}…)"
echo "  runs/arm : $RUNS"
echo "  out      : $OUT"
echo "  mode     : $([ "$DRY_RUN" -eq 1 ] && echo 'DRY-RUN (no spend)' || echo 'LIVE (spends on subscription)')"
echo ""

# ---- restore trap: never leave the artifact aside ---------------------------
restore_artifact() {
  if [ -f "$ASIDE" ]; then
    mv -f "$ASIDE" "$ARTIFACT"
  fi
}
# EXIT always restores; INT/TERM must ALSO exit — a bare signal handler that
# returns would resume the loop and launch the next run after a Ctrl-C.
trap restore_artifact EXIT
trap 'restore_artifact; exit 130' INT TERM

# ---- safety preflight -------------------------------------------------------
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "$ALLOW_API_KEY" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "REFUSING: ANTHROPIC_API_KEY is set — live runs would bill metered API credits, not the subscription." >&2
  echo "Unset it (the claude CLI uses your subscription login) or pass --allow-api-key to override." >&2
  exit 1
fi

if [ "$DRY_RUN" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
  total=$((RUNS * 2))
  echo "About to launch $total LIVE local fleet runs ($RUNS primed + $RUNS cold). This spends on your subscription."
  printf "Proceed? [y/N] "
  # `if ! read` keeps set -e from exiting on EOF/closed stdin — treat as decline.
  reply=""
  if ! read -r reply; then reply=""; fi
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "aborted."; exit 0 ;;
  esac
fi

# ---- SUMMARY header ---------------------------------------------------------
printf 'arm\trep\trunId\tstatus\tverify\tunmetGates\tvetoes\tverdict\tagentUsd\tjudgeUsd\ttotalUsd\twallSec\n' > "$SUMMARY"

# Stub used only in --dry-run: emit the arm marker the real runner would (based
# on the artifact actually being present or aside), then fabricate a minimal
# result.json so every downstream step runs for real.
stub_fleet_run() {
  local log="$1"
  if [ -f "$ARTIFACT" ]; then
    echo "· injected knowledge → .fleet-knowledge.md" >> "$log"
  else
    echo "· no compiled knowledge for this target — running cold" >> "$log"
  fi
  local rid; rid="dryrun-$(date +%s)-$RANDOM"
  local d="$RUNS_DIR/$rid"; mkdir -p "$d"
  # Fabricated numbers only — plumbing validation, not a prediction.
  local pinned="false"; [ -f "$ARTIFACT" ] && pinned="true"
  cat > "$d/result.json" <<JSON
{ "task": "$TASK", "repo": "$TARGET", "runId": "$rid",
  "status": "approved", "verify": { "state": "passed" },
  "unmetGates": [], "vetoes": [], "verdict": { "verdict": "approve" },
  "modelUsage": { "agent": { "reportedCost": { "usd": 0.42 } },
                  "judge": { "reportedCost": { "usd": 0.12 } } } }
JSON
  mkdir -p "$EVID_DIR/$rid"
  echo "{\"runId\":\"$rid\",\"note\":\"dry-run stub\"}" > "$EVID_DIR/$rid/model-usage.json"
  echo "run complete: $rid" >> "$log"
}

# Run one arm/rep. $1=arm (primed|cold) $2=rep
run_one() {
  local arm="$1" rep="$2"
  local dest="$OUT/$arm/$rep"; mkdir -p "$dest"
  local log="$dest/run.log"; : > "$log"

  # Toggle the artifact for this arm.
  if [ "$arm" = "cold" ]; then
    [ -f "$ARTIFACT" ] && mv -f "$ARTIFACT" "$ASIDE"
  else
    restore_artifact
  fi

  local before after new_runs
  before="$(ls -1 "$RUNS_DIR" 2>/dev/null | sort || true)"

  echo ">> $arm rep $rep …"
  local t0 t1; t0="$(date +%s)"
  if [ "$DRY_RUN" -eq 1 ]; then
    stub_fleet_run "$log"
  else
    # LIVE: dry-run dispatch (no --pr), no knowledge recompile, subscription auth.
    pnpm fleet run "$TASK" --repo "$TARGET" --local >> "$log" 2>&1 || true
  fi
  t1="$(date +%s)"
  local wall=$((t1 - t0))

  # Restore artifact immediately after the run so the tree spends minimal time toggled.
  restore_artifact

  # --- assert the arm actually took effect (the toggle is the experiment) ---
  # Detect each marker independently; both present is a conflict, not a tiebreak.
  local primed_hit=0 cold_hit=0
  if grep -q "injected knowledge" "$log"; then primed_hit=1; fi
  if grep -q "no compiled knowledge" "$log"; then cold_hit=1; fi
  local marker="unknown"
  if [ "$primed_hit" -eq 1 ] && [ "$cold_hit" -eq 1 ]; then
    echo "FATAL: both knowledge markers present in $log for $arm rep $rep — cannot attribute arm." >&2
    exit 1
  elif [ "$primed_hit" -eq 1 ]; then marker="primed"
  elif [ "$cold_hit" -eq 1 ]; then marker="cold"
  fi
  local want; [ "$arm" = "cold" ] && want="cold" || want="primed"
  if [ "$marker" != "$want" ]; then
    echo "FATAL: arm mismatch on $arm rep $rep — log marker says '$marker', expected '$want'." >&2
    echo "The knowledge toggle did not take effect; refusing to record a mislabeled run." >&2
    echo "See $log" >&2
    exit 1
  fi

  # --- locate the new run dir (set-diff on artifacts/runs) ---
  # Run IDs are UUIDs, not time-sortable, so pick the newest of any new dirs by
  # mtime (BSD `stat -f %m`, macOS) rather than trusting lexicographic order.
  after="$(ls -1 "$RUNS_DIR" 2>/dev/null | sort || true)"
  new_runs="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") || true)"
  local n_new; n_new="$(printf '%s\n' "$new_runs" | grep -cv '^$' || true)"
  local runId=""
  if [ "${n_new:-0}" -ge 1 ]; then
    runId="$(printf '%s\n' "$new_runs" | grep -v '^$' \
      | while IFS= read -r d; do
          [ -d "$RUNS_DIR/$d" ] && printf '%s\t%s\n' "$(stat -f %m "$RUNS_DIR/$d" 2>/dev/null || echo 0)" "$d"
        done | sort -n | tail -1 | cut -f2)"
  fi
  if [ "${n_new:-0}" -gt 1 ]; then
    echo "WARN: $n_new new run dirs appeared under $RUNS_DIR for $arm rep $rep; attributing to the newest by mtime ($runId)." >&2
  fi
  if [ -z "$runId" ]; then
    echo "WARN: could not identify a new run dir under $RUNS_DIR for $arm rep $rep — recording marker only." >&2
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$arm" "$rep" "(none)" "no-run-dir" "" "" "" "" "" "" "" "$wall" >> "$SUMMARY"
    return
  fi

  # --- copy evidence ---
  cp -f "$RUNS_DIR/$runId/result.json" "$dest/result.json" 2>/dev/null || true
  if [ -f "$EVID_DIR/$runId/model-usage.json" ]; then
    cp -f "$EVID_DIR/$runId/model-usage.json" "$dest/model-usage.json"
  fi

  # --- extract the SUMMARY row from result.json ---
  python3 - "$RUNS_DIR/$runId/result.json" "$arm" "$rep" "$wall" >> "$SUMMARY" <<'PY'
import json, sys
path, arm, rep, wall = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    d = json.load(open(path))
except Exception:
    print(f"{arm}\t{rep}\t(parse-error)\t\t\t\t\t\t\t\t\t{wall}")
    sys.exit(0)
mu = d.get("modelUsage") or {}
def usd(rail):
    r = (mu.get(rail) or {}).get("reportedCost") or {}
    return r.get("usd")
agent = usd("agent"); judge = usd("judge")
total = None
if agent is not None or judge is not None:
    total = (agent or 0) + (judge or 0)
def n(x): return "" if x is None else (f"{x:.4f}" if isinstance(x, float) else str(x))
row = [
    arm, rep,
    d.get("runId", ""),
    d.get("status", ""),
    (d.get("verify") or {}).get("state", ""),
    str(len(d.get("unmetGates") or [])),
    str(len(d.get("vetoes") or [])),
    (d.get("verdict") or {}).get("verdict", ""),
    n(agent), n(judge), n(total), wall,
]
print("\t".join(row))
PY
  echo "   $arm rep $rep → $runId"
}

# ---- run the matrix (interleave primed/cold to balance any drift) -----------
r=1
while [ "$r" -le "$RUNS" ]; do
  run_one primed "$r"
  run_one cold "$r"
  r=$((r + 1))
done

# ---- restore + verify state -------------------------------------------------
restore_artifact
NOW_SHA="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
if [ "$NOW_SHA" != "$ARTIFACT_SHA" ]; then
  echo "ERROR: artifact byte-mismatch after restore! expected ${ARTIFACT_SHA:0:12}… got ${NOW_SHA:0:12}…" >&2
  exit 1
fi
if [ -n "$(git status --porcelain -- "$ARTIFACT")" ]; then
  echo "ERROR: git reports the artifact changed after restore:" >&2
  git status --porcelain -- "$ARTIFACT" >&2
  exit 1
fi
echo ""
echo "state restored: OK (artifact byte-identical, git clean)"

# ---- aggregate --------------------------------------------------------------
echo ""
echo "SUMMARY  ($SUMMARY):"
column -t -s "$(printf '\t')" "$SUMMARY" || cat "$SUMMARY"
echo ""
python3 - "$SUMMARY" <<'PY'
import csv, sys
rows = list(csv.DictReader(open(sys.argv[1]), delimiter="\t"))
def agg(arm):
    rs = [r for r in rows if r["arm"] == arm]
    if not rs: return
    def fnums(k):
        out=[]
        for r in rs:
            try: out.append(float(r[k]))
            except: pass
        return out
    passes = sum(1 for r in rs if r["verify"] == "passed")
    approves = sum(1 for r in rs if r["verdict"] == "approve")
    tot = fnums("totalUsd")
    # #91 needs the cost dimension; if billing wasn't observed the extractor
    # blanks totalUsd. Say so loudly rather than reporting a silent nan mean.
    if tot:
        cost = f"mean total ${sum(tot)/len(tot):.4f} ({len(tot)}/{len(rs)} runs costed)"
        if len(tot) < len(rs):
            cost += "  ⚠ cost missing on some runs (billing not observed)"
    else:
        cost = "COST UNAVAILABLE — no run reported cost (billing not observed); the cost dimension of #91 is blank"
    print(f"  {arm:6s}: {len(rs)} runs · verify passed {passes}/{len(rs)} · approve {approves}/{len(rs)} · {cost}")
print("aggregate:")
agg("primed"); agg("cold")
print("\nInterpretation: a discriminating result is any consistent gap between the")
print("arms — cold failing/vetoing more, OR cold costing more (trap detours) at")
print("equal outcome, OR primed costing more with no benefit (bet weakened).")
PY
