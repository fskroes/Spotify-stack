#!/usr/bin/env bash
#
# Guard the public scrub.
#
# This repo is public. It deliberately names neither its owner nor any private
# fleet target, and it carries none of the original bike-routing domain. Those
# live only in git-ignored files (fleet/repos.local.yaml, tasks/private/) and in
# fleet/ledger.jsonl, which is tracked but held back by a local `skip-worktree`
# bit — a guard that no clone inherits and nothing else enforces. This script is
# that enforcement.
#
#   scripts/check-scrub.sh          # scan staged content (the pre-commit path)
#   scripts/check-scrub.sh --all    # scan every tracked file (the CI path)
#
# Exits non-zero, listing file:line:match, if a banned term appears.

set -uo pipefail

# Banned terms, matched case-insensitively as regexes. Split into two groups only
# so a failure reads clearly; both are equally fatal.
# `better-?mail` catches both the repo name and the app's `BetterMail` symbols.
IDENTIFIERS='fskroes|bike-route-creator|freshminds|better-?mail|hotmail\.com'
DOMAIN='\bgpx\b|openrouteservice|\bORS\b|strava|topografix|trkpt|\bcycling\b|\bbike\b|geocodeAddress|snapPointsToRoad'
PATTERN="${IDENTIFIERS}|${DOMAIN}"

# This script necessarily contains every banned term, so it can never scan
# itself. Nothing else is exempt.
SELF='scripts/check-scrub.sh'

# macOS ships bash 3.2, so no `mapfile` and no process-substitution-into-array.
if [ "${1:-}" = "--all" ]; then
  list_files() { git ls-files; }
  # What is committed is what matters, so read HEAD, not the worktree. This is
  # why a skip-worktree'd fleet/ledger.jsonl passes here: its HEAD blob is clean.
  reader() { git show "HEAD:$1" 2>/dev/null; }
else
  # Added, copied, modified — not deletions, whose content is gone.
  list_files() { git diff --cached --name-only --diff-filter=ACM; }
  # Read the *staged* blob, not the worktree file.
  reader() { git show ":$1" 2>/dev/null; }
fi

found=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ "$f" = "$SELF" ] && continue
  # -I makes grep treat a binary stream as non-matching, so images never trip this.
  hits=$(reader "$f" | grep -IinE "$PATTERN") || continue
  found=1
  while IFS= read -r hit; do
    echo "  $f:$hit"
  done <<EOF
$hits
EOF
done <<EOF
$(list_files)
EOF

if [ "$found" -eq 1 ]; then
  cat >&2 <<'MSG'

✗ scrub check failed — banned identifiers or domain terms above.

This repo is public and scrubbed. Private fleet targets and the original
bike-routing domain must stay in git-ignored files:

  fleet/repos.local.yaml   (fleet targets)
  tasks/private/           (task definitions)

If fleet/ledger.jsonl is the offender, it is tracked but meant to be held back:

  git update-index --skip-worktree fleet/ledger.jsonl
  git restore --staged fleet/ledger.jsonl

To scan the whole tree:  scripts/check-scrub.sh --all
MSG
  exit 1
fi

echo "✓ scrub check passed"
