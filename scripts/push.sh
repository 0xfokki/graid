#!/bin/bash
# Layer 3: publish the append-only record to GitHub, every six hours.
#
# GitHub is authoritative for code and documentation, because people edit there.
# The server is authoritative only for data/, which is rebuilt from the snapshots
# in backups/ on every run. So the safe move is to adopt the remote state first and
# re-apply the data on top: a local commit is never worth keeping, because the next
# run reproduces it. An earlier version simply pushed, and broke the moment anyone
# committed from a browser.
set -e

APP=${APP_DIR:-/opt/pons/app}
REPO=${REPO_DIR:-/opt/pons/graid}
BACKUPS=${BACKUP_DIR:-/opt/pons/backups}
KEY=${DEPLOY_KEY:-/opt/pons/.ssh/graid_key}

export HOME=${HOME:-/opt/pons}
# IdentitiesOnly matters: without it ssh offers every key it can find, GitHub
# accepts the first one it recognises, and a deploy key belonging to a different
# repository authenticates fine and then reports "repository not found".
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=$HOME/.ssh/known_hosts"

"$(dirname "$0")/backup.sh" > /dev/null

# Run the copy installed outside the repository, never this file in place: the
# reset below would delete the running script.
cd "$REPO"
git fetch -q origin main
git reset --hard -q origin/main

mkdir -p data
cp -f "$BACKUPS"/*.jsonl.gz data/ 2>/dev/null || true

# Keep the published code in step with what is actually running.
# The app keeps its code in src/ and its pages in web/, so the copies have to reach
# into those directories. They used to read $APP directly, matched nothing, and failed
# silently: the published code quietly stopped following the code actually running.
cp -f "$APP"/src/*.mjs "$APP"/src/*.json src/ 2>/dev/null || true
cp -f "$APP"/web/index.html "$APP"/web/base.html web/ 2>/dev/null || true
rm -f src/*.bak src/*.prev web/*.bak web/*.prev 2>/dev/null || true

git add -A
if git diff --cached --quiet; then
  echo "$(date -u +%FT%TZ) nothing changed"
  exit 0
fi

N=$(zcat data/predictions-*.jsonl.gz 2>/dev/null | wc -l || echo 0)
R=$(zcat data/resolutions-*.jsonl.gz 2>/dev/null | wc -l || echo 0)
git -c user.name=graid -c user.email=graid@localhost \
    commit -q -m "data: ${N} predictions, ${R} scored ($(date -u +'%F %H:%M') UTC)"
git push -q origin main
echo "$(date -u +%FT%TZ) pushed: ${N} predictions, ${R} scored"
