#!/bin/bash
# Layer 1: a daily snapshot of the prediction log, taken on the server itself.
# Protects against an application bug or a bad edit, but NOT against losing the
# disk — layer 2 (the push to GitHub) covers that.
set -e
DATA=${DATA_DIR:-/opt/pons/data}
DEST=${BACKUP_DIR:-/opt/pons/backups}
DAY=$(date -u +%Y-%m-%d)
mkdir -p "$DEST"

for f in predictions resolutions; do
  SRC="$DATA/$f.jsonl"
  [ -f "$SRC" ] || continue
  # gzip -c rather than mv: the file is live and the application is appending to it right now.
  gzip -c "$SRC" > "$DEST/$f-$DAY.jsonl.gz"
done

# Keep 21 days, then prune: the disk is only 10 GB.
find "$DEST" -name '*.jsonl.gz' -mtime +21 -delete

# Checksums, so a corrupted copy is visible later rather than silently restored.
( cd "$DEST" && sha256sum *.jsonl.gz > SHA256SUMS 2>/dev/null || true )

echo "$(date -u +%FT%TZ) backup ok: $(ls -1 $DEST/*.jsonl.gz 2>/dev/null | wc -l) files, $(du -sh $DEST | cut -f1)"
