#!/usr/bin/env bash
#
# One-time GitHub bootstrap for the agent fleet reference implementation.
# Run locally where `gh` is authenticated:
#
#   ./scripts/bootstrap-github.sh
#
# What it does:
#   1. Creates the two demo target repos under your account and pushes them
#      (from clean temp copies, so no nested .git ends up in this repo).
#   2. Creates a GitHub remote for this control repo (if none) and pushes it.
#   3. Sets the ANTHROPIC_API_KEY Actions secret (from env or prompt).
#   4. Prints the remaining manual step (FLEET_GH_TOKEN PAT) and the runbook.
#
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER=${GH_OWNER:-$(gh api user --jq .login)}
VISIBILITY=${VISIBILITY:-private}
CONTROL_REPO_NAME=${CONTROL_REPO_NAME:-spotify-stack}

echo "▶ bootstrapping under github.com/$OWNER (visibility: $VISIBILITY)"

# --- 1. demo target repos ---------------------------------------------------
for repo in demo-ts-service demo-swift-package demo-feed-service; do
  echo "▶ $repo"
  if ! gh repo view "$OWNER/$repo" >/dev/null 2>&1; then
    gh repo create "$OWNER/$repo" "--$VISIBILITY" --description "Agent-fleet demo target repo"
  fi
  tmp=$(mktemp -d)
  rsync -a --exclude node_modules --exclude .build --exclude .git "demo-repos/$repo/" "$tmp/"
  (
    cd "$tmp"
    git init -q -b main
    git add -A
    git -c user.email="fleet@example.invalid" -c user.name="Fleet Bootstrap" commit -qm "baseline"
    git remote add origin "https://github.com/$OWNER/$repo.git"
    git push -q --force -u origin main
  )
  rm -rf "$tmp"
  echo "  pushed https://github.com/$OWNER/$repo"
done

# --- 2. control repo remote --------------------------------------------------
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "▶ creating control repo $OWNER/$CONTROL_REPO_NAME"
  gh repo create "$OWNER/$CONTROL_REPO_NAME" "--$VISIBILITY" --source . --push
else
  echo "▶ control repo remote exists: $(git remote get-url origin)"
  git push -u origin main
fi

# --- 3. secrets ----------------------------------------------------------------
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  gh secret set ANTHROPIC_API_KEY --repo "$OWNER/$CONTROL_REPO_NAME" --body "$ANTHROPIC_API_KEY"
  echo "▶ set ANTHROPIC_API_KEY secret"
else
  echo "⚠ ANTHROPIC_API_KEY not in env — set it manually:"
  echo "    gh secret set ANTHROPIC_API_KEY --repo $OWNER/$CONTROL_REPO_NAME"
fi

# --- 4. remaining manual step -------------------------------------------------
cat <<EOF

▶ ONE MANUAL STEP LEFT — create the FLEET_GH_TOKEN secret:
  1. https://github.com/settings/personal-access-tokens/new
     - Repository access: $OWNER/demo-ts-service, $OWNER/demo-swift-package, $OWNER/demo-feed-service
     - Permissions: Contents (read/write), Pull requests (read/write)
  2. gh secret set FLEET_GH_TOKEN --repo $OWNER/$CONTROL_REPO_NAME

▶ Then run the cloud end-to-end:
  export GH_OWNER=$OWNER
  pnpm fleet dispatch 003-add-agent-badge      # fans out over the whole fleet
  pnpm fleet status 003-add-agent-badge        # runs + PRs as a markdown table
EOF
