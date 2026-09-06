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
REPO=${REPO_DIR:-/opt/pons/repo}
BACKUPS=${BACKUP_DIR:-/opt/pons/backups}
KEY=${DEPLOY_KEY:-/opt/pons/.ssh/graid_key}

export HOME=${HOME:-/opt/pons}
export GIT_SSH_COMMAND="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=$HOME/.ssh/known_hosts"

"$(dirname "$0")/backup.sh" > /dev/null

cd "$REPO"
git fetch -q origin main
git reset --hard -q origin/main

mkdir -p data
cp -f "$BACKUPS"/*.jsonl.gz data/ 2>/dev/null || true

# Keep the published code in step with what is actually running.
cp -f "$APP"/*.mjs src/ 2>/dev/null || true
cp -f "$APP"/model.json src/ 2>/dev/null || true
cp -f "$APP"/index.html "$APP"/base.html web/ 2>/dev/null || true
rm -f src/w*.json src/*.bak web/*.bak 2>/dev/null || true

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
