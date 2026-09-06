# Running the agent

## Shape of the system

One long-lived Node process does all of it:

1. subscribes to `TokenLaunched` from the pons v2 factory on Robinhood Chain
2. reads the launch context on chain, scores it, and appends the prediction
3. queues the token for resolution once its observation window has closed
4. re-reads the curve after the window closes and appends the outcome
5. recomputes the public metrics from those two files

Predictions and outcomes live in separate append-only JSONL files. Nothing is ever
rewritten in place, which is what makes the record checkable afterwards.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4664` | HTTP port |
| `DATA_DIR` | `.` | where the JSONL logs are written |
| `WEB_DIR` | `../web` | where `index.html` is served from |
| `WINDOWS_DIR` | next to the code | optional sampled training windows |

No API key is needed; both RPC endpoints are public. The agent never signs a
transaction and holds no wallet.

## Reading the record back

The scoreboard reads both logs **incrementally**, remembering a byte offset and
consuming only the new bytes. An earlier version updated the index from the writer
instead. When one patch silently failed to apply, the published numbers froze at
their startup values while the files kept growing. A single file-based source of
truth removed that entire class of failure, and a test now covers it.

## Restarts

The resolution queue and the rolling 24-hour buffer are both rebuilt from the files
at startup. Without that, a restart would strand every pending prediction and none of
them would ever be scored.

## Backups

Three layers, because each covers what the one before it cannot:

1. `scripts/backup.sh` — a daily gzipped snapshot on the server, with checksums.
   Covers an application bug or a bad edit. Does not cover losing the disk.
2. rotation — 21 days retained, then pruned.
3. `scripts/push.sh` — commits the snapshots to GitHub every six hours. Covers losing
   the machine, and doubles as the public timestamp on the record.

`push.sh` adopts the remote state before re-applying the data. It used to push
directly, and broke the first time anyone committed from a browser.

## Serving it

Behind nginx with TLS. The one setting that matters:

```nginx
location /api/feed {
    proxy_buffering off;      # the live feed is SSE and must not be buffered
    proxy_read_timeout 24h;
}
```

For the same reason the DNS records are **not** proxied through a CDN. A buffering
proxy in front of this endpoint leaves the page loading normally while the feed
silently stops updating, which is a hard failure to diagnose because nothing errors.
