import { createServer } from "http";
import { readFileSync, existsSync, appendFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

// Bundled files sit next to the code; resolve them from the module URL so the
// server runs correctly from any working directory.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB = process.env.WEB_DIR ?? join(HERE, "..", "web");
const WINDOWS = process.env.WINDOWS_DIR ?? HERE;
import { LOGS, READ, FACTORY, evTokenLaunched, readToken, curveActivity } from "./chain.mjs";
import { predict } from "./model.mjs";
import { flags } from "./flags.mjs";
import * as board from "./scoreboard.mjs";

const PORT = Number(process.env.PORT ?? 4664);
const DATA = process.env.DATA_DIR ?? ".";
mkdirSync(DATA, { recursive: true });

const model = JSON.parse(readFileSync(join(HERE, "model.json"), "utf8"));
const PRED_LOG = join(DATA, "predictions.jsonl");
const RESOLVE_LOG = join(DATA, "resolutions.jsonl");
const OBS_MS = (model.observationHours ?? 2) * 3600 * 1000;

// The scoreboard tails the files itself: one source of truth instead of writer
// callbacks that have previously failed silently.
{
  const r = board.refresh(PRED_LOG, RESOLVE_LOG);
  console.log(`scoreboard: ${r.predictions} predictions, ${r.resolutions} resolved`);
}
setInterval(() => board.refresh(PRED_LOG, RESOLVE_LOG), 20_000);

// Restore the top-list buffer too, or there is nothing to show after a restart.
function rebuildRecent() {
  if (!existsSync(PRED_LOG)) return;
  const cut = Date.now() - 24 * 3600_000;
  for (const l of readFileSync(PRED_LOG, "utf8").split(String.fromCharCode(10))) {
    if (!l.trim()) continue;
    let d; try { d = JSON.parse(l); } catch { continue; }
    const at = Date.parse(d.t);
    if (at < cut) continue;
    recent.push({ token: d.token, symbol: d.symbol, name: null, p: d.p_outside,
      lift: d.p_outside / (model.outside.base || 1), devBuyPct: d.f && d.f.devBuyPct,
      at, flags: [], version: d.modelVersion });
  }
  recent.sort((a, b) => a.at - b.at);
  console.log(`top-list buffer restored: ${recent.length} launches from the last day`);
}

// ── ticker index from the training set, used for ticker search ─────────────────
const index = new Map();
for (const w of ["w14.json", "w12.json", "w10.json", "w8.json"]) {
    const f = join(WINDOWS, w);
  if (!existsSync(f)) continue;
  for (const r of JSON.parse(readFileSync(f, "utf8"))) if (!r.error) index.set(r.token.toLowerCase(), r);
}

// ── rolling indexes for the last hour ──────────────────────────────────────────
const HOUR = 3600_000;
const seenByDeployer = new Map();   // deployer -> [ts]
const seenBySymbol = new Map();     // symbol   -> [ts]
const prune = (m) => { const cut = Date.now() - HOUR; for (const [k, v] of m) { const f = v.filter((t) => t > cut); f.length ? m.set(k, f) : m.delete(k); } };
setInterval(() => { prune(seenByDeployer); prune(seenBySymbol); }, 60_000);
const note = (m, k, ts = Date.now()) => { if (!k) return; const a = m.get(k) ?? []; a.push(ts); m.set(k, a); };
const countOf = (m, k) => (m.get(k)?.length ?? 0);

const feed = [];
// One-day buffer: the feed keeps 60 entries, while the top list needs 24 hours.
// One hour is too short and fills the top with dead launches during quiet periods.
// Store trimmed rows: about 20k entries at a quarter kilobyte each, roughly 5 MB.
const DAY = 24 * 3600_000;
const recent = [];
const clients = new Set();
const stats = { block: 0, launchesSeen: 0, startedAt: Date.now(), lastLaunchAt: 0, predictions: 0, skipped: 0, perMin: 0, perHour: 0, behind: 0 };
const rateWindow = [];

function push(item) {
  feed.unshift(item);
  if (feed.length > 60) feed.pop();
  const msg = `data: ${JSON.stringify(item)}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch {} }
}

function score(row) {
  const out = predict(model.outside, row);
  const grad = predict(model.graduated, row);
  return { outside: out, graduated: grad };
}

function decorate(row) {
  row.deployerLaunches = Math.max(1, countOf(seenByDeployer, row.deployer?.toLowerCase()));
  row.symbolClones = Math.max(1, countOf(seenBySymbol, String(row.symbol ?? "").toLowerCase()));
  const scores = score(row);
  return { ...row, scores, flags: flags(row, model.outside) };
}

// ── prediction log ─────────────────────────────────────────────────────────────
// Write while the outcome is unknown. Records are immutable and the file is append-only.
function logPrediction(row) {
  const rec = {
    t: new Date().toISOString(),
    modelVersion: model.version,
    eventThreshold: model.eventThreshold,
    observationHours: model.observationHours,
    token: row.token, curve: row.curve, symbol: row.symbol, deployer: row.deployer,
    block: row.block, launchedAt: row.launchedAt,
    p_outside: +row.scores.outside.p.toFixed(5),
    p_graduated: +row.scores.graduated.p.toFixed(5),
    f: {
      devBuyPct: row.devBuyPct, exemptWallets: row.exemptWallets, creatorTaxBps: row.creatorTaxBps,
      feeToThirdParty: row.feeToThirdParty, hasSocials: row.hasSocials, isEthPair: row.isEthPair,
      deployerLaunches: row.deployerLaunches, symbolClones: row.symbolClones,
      threshold: row.threshold,
    },
  };
  try { appendFileSync(PRED_LOG, JSON.stringify(rec) + "\n"); stats.predictions++; } catch (e) { console.error("log fail", e.message); }
  pending.push({ token: row.token, curve: row.curve, block: row.block, at: Date.now(), threshold: row.threshold, deployer: row.deployer, exempt: row.exemptRaw ?? null, tx: row.launchTx ?? null });
}

// ── resolve outcomes: after OBS_MS, measure how much outside money arrived ─────
// Rebuild the queue from files at startup so predictions survive a restart and
// are not left unresolved forever.
const pending = [];
function rebuildPending() {
  if (!existsSync(PRED_LOG)) return;
  const done = new Set();
  if (existsSync(RESOLVE_LOG)) {
    for (const l of readFileSync(RESOLVE_LOG, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try { done.add(JSON.parse(l).token.toLowerCase()); } catch {}
    }
  }
  let n = 0;
  for (const l of readFileSync(PRED_LOG, "utf8").split("\n")) {
    if (!l.trim()) continue;
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (done.has(d.token.toLowerCase())) continue;
    pending.push({ token: d.token, curve: d.curve, block: d.block, at: Date.parse(d.t),
      threshold: d.f && d.f.threshold, deployer: d.deployer, exempt: null, tx: null });
    n++;
  }
  pending.sort((a, b) => a.at - b.at);
  console.log(`resolution queue restored: ${n} awaiting outcomes`);
}
rebuildPending();
rebuildRecent();
async function resolveDue() {
  // Yield to the live feed. The resolver holds the same rate-limited endpoint for
  // dozens of calls per outcome, and while it does, new launches sit unscored. Its
  // own backlog is thousands deep and will not clear either way, so letting the feed
  // go first costs nothing and is what people actually look at.
  if (stats.behind > 0) return;
  const now = Date.now();
  const due = [];
  // Resolve at most 12 per pass to avoid exhausting RPC limits.
  while (pending.length && now - pending[0].at >= OBS_MS && due.length < 12) due.push(pending.shift());
  for (const p of due) {
    try {
      const act = await curveActivity(p.curve, p.block, p.deployer, p.exempt, p.tx, OBS_MS);
      const thr = Number(p.threshold) || 1;
      const sharePct = (Number(act.outsideQuoteIn) / thr) * 100;
      const rec = {
        t: new Date().toISOString(), token: p.token, predictedAt: new Date(p.at).toISOString(),
        outsideSharePct: +sharePct.toFixed(4), outsideBuyers: act.outsideBuyers, outsideBuys: act.outsideBuys,
        event: sharePct >= (model.eventThreshold ?? 10), complete: act.complete,
      };
      appendFileSync(RESOLVE_LOG, JSON.stringify(rec) + "\n");
    } catch (e) { /* Do not retry: a later observation would no longer match the original window. */ }
    await new Promise((r) => setTimeout(r, 600));
  }
}
setInterval(resolveDue, 60_000);

// ── live feed ──────────────────────────────────────────────────────────────────
let cursor = null;
let busy = false;
// Never rewind past this: beyond it, accept the gap rather than spending a whole
// cycle on history and falling further behind live.
const MAX_LOOKBACK = 12000n;   // roughly twenty minutes of blocks
const BATCH = 10;              // launches scored per pass
const handled = new Set();     // tx:logIndex, so a re-read is never scored twice
async function poll() {
  if (busy) return;
  busy = true;
  try {
    const head = await READ.getBlockNumber();
    stats.block = Number(head);
    if (cursor === null) cursor = head - 60n;
    if (head <= cursor) return;
    // Read from where we stopped, not from a fixed window. This clamped to the
    // last 600 blocks — one minute — so any cycle running longer than a minute
    // dropped every launch in between, silently. Bursts and a busy resolver make
    // cycles longer than a minute routine.
    let from = cursor + 1n;
    if (head - from > MAX_LOOKBACK) from = head - MAX_LOOKBACK;
    const logs = await LOGS.getLogs({ address: FACTORY, event: evTokenLaunched, fromBlock: from, toBlock: head });
    // Score a bounded slice and leave the rest to the next pass: a burst of twenty
    // launches, each needing several chain reads, would otherwise hold this loop
    // long enough for the window to slide out of reach again.
    const fresh = logs.filter((l) => !handled.has(l.transactionHash + ":" + l.logIndex));
    const batch = fresh.slice(0, BATCH);
    cursor = batch.length < fresh.length ? batch[batch.length - 1].blockNumber - 1n : head;
    stats.launchesSeen += batch.length;
    stats.behind = fresh.length - batch.length;
    for (const l of batch) {
      handled.add(l.transactionHash + ":" + l.logIndex);
      rateWindow.push(Date.now());
      note(seenByDeployer, l.args.deployer.toLowerCase());
    }
    if (handled.size > 4000) for (const k of [...handled].slice(0, 2000)) handled.delete(k);
    // Score concurrently. Each launch needs several chain reads, and doing them one
    // after another put nine minutes between a launch and its row appearing. The
    // width is small on purpose: the endpoint is rate limited, and a wider fan-out
    // starts failing reads rather than finishing them sooner.
    await Promise.all(batch.map(async (l) => {
      try {
        const row = await readToken(l.args.token, { tx: l.transactionHash });
        row.block = Number(l.blockNumber);
        row.launchTx = l.transactionHash;
        note(seenBySymbol, String(row.symbol ?? "").toLowerCase());
        const item = decorate(row);
        item.at = Date.now();
        logPrediction(item);
        push(item);
        recent.push({ token: item.token, symbol: item.symbol, name: item.name,
          p: item.scores.outside.p, lift: item.scores.outside.lift,
          devBuyPct: item.devBuyPct, at: item.at,
          flags: (item.flags ?? []).slice(0, 3).map((f) => ({ text: f.text, dir: f.dir })) });
        const cut = Date.now() - DAY;
        while (recent.length && recent[0].at < cut) recent.shift();
        stats.lastLaunchAt = Date.now();
      } catch { stats.skipped++; }
    }));
  } catch {} finally {
    // Keep a quarter hour, not a minute: launches arrive twenty at a time inside
    // one minute and then nothing for ten, so a one-minute window reads zero most
    // of the time and a working agent looks stalled.
    const cut = Date.now() - 900_000;
    while (rateWindow.length && rateWindow[0] < cut) rateWindow.shift();
    const minuteCut = Date.now() - 60_000;
    stats.perMin = rateWindow.reduce((n, t) => n + (t >= minuteCut ? 1 : 0), 0);
    const span = Math.min(900_000, Date.now() - stats.startedAt);
    stats.perHour = span > 0 ? Math.round((rateWindow.length * 3600_000) / span) : 0;
    busy = false;
  }
}
setInterval(poll, 2500);
poll();

// ── warm the deployer index at startup ─────────────────────────────────────────
(async () => {
  try {
    const head = await READ.getBlockNumber();
    const back = 36000n; // About one hour.
    for (let b = head - back; b < head; b += 3000n) {
      const hi = b + 2999n > head ? head : b + 2999n;
      const logs = await LOGS.getLogs({ address: FACTORY, event: evTokenLaunched, fromBlock: b, toBlock: hi }).catch(() => []);
      const age = Number(head - hi) * 101; // Milliseconds ago.
      for (const l of logs) note(seenByDeployer, l.args.deployer.toLowerCase(), Date.now() - age);
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`deployer index warmed: ${seenByDeployer.size} addresses from the last hour`);
  } catch (e) { console.log("index warmup failed:", e.message); }
})();

// ── search ─────────────────────────────────────────────────────────────────────
async function lookup(q) {
  const s = q.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    // Curve history takes about ten seconds, so do not wait for it here. Return the
    // card immediately; the page fetches /api/activity and adds the flags later.
    const row = await readToken(s);
    return { kind: "one", row: decorate(row) };
  }
  const needle = s.toLowerCase().replace(/^\$/, "");
  const pool = [...feed, ...index.values()];
  const seen = new Set(); const hits = [];
  for (const r of pool) {
    const k = r.token.toLowerCase();
    if (seen.has(k)) continue;
    if (String(r.symbol ?? "").toLowerCase().includes(needle) || String(r.name ?? "").toLowerCase().includes(needle)) {
      seen.add(k);
      hits.push({ token: r.token, symbol: r.symbol, name: r.name, phase: r.phase, progressPct: r.progressPct ?? 0 });
    }
    if (hits.length >= 25) break;
  }
  return { kind: "many", hits, note: "ticker search covers the collected set only — there is no full index yet" };
}

// ── http ───────────────────────────────────────────────────────────────────────
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
const lines = (f) => { try { return readFileSync(f, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(readFileSync(join(WEB, "index.html")));
  }

  if (url.pathname === "/api/status") {
    const logged = lines(PRED_LOG);
    const resolved = lines(RESOLVE_LOG);
    return json(res, 200, {
      block: stats.block, perMin: stats.perMin, perHour: stats.perHour, behind: stats.behind, modelVersion: model.version,
      analyzed: logged, trainingN: model.outside.n,
      base: model.outside.base, eventThreshold: model.eventThreshold,
      holdout: model.holdout,
      uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
      logged, resolved, pending: pending.length,
      skipped: stats.skipped,
      quietSec: stats.lastLaunchAt ? Math.round((Date.now() - stats.lastLaunchAt) / 1000) : null,
    });
  }

  if (url.pathname === "/api/model") {
    return json(res, 200, { outside: model.outside,
      graduated: { base: model.graduated.base, events: model.graduated.events },
      holdout: model.holdout, version: model.version });
  }

  // Event feed powers the current-launch section and animates the hero pipeline.
  if (url.pathname === "/api/feed") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ hello: true, feed })}

`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/api/cloud") {
    // Compact arrays [time, probability, outcome] instead of objects reduce roughly
    // four thousand points from 400 KB to 120 KB. Outcome: 1 hit, 0 miss, -1 pending.
    const cut = Date.now() - DAY;
    const pts = [];
    for (const r of recent) {
      if (r.at < cut) continue;
      const o = board.outcomeOf(r.token);
      pts.push([Math.round((r.at - cut) / 1000), Math.round(r.p * 1000),
        o ? (o.event ? 1 : 0) : -1, r.symbol ?? "", r.token]);
    }
    return json(res, 200, { span: DAY / 1000, n: pts.length, pts });
  }

  if (url.pathname === "/api/graduated") {
    // A separate hourly job updates this file; scanning migration logs on every
    // request would be too expensive.
    try { return json(res, 200, JSON.parse(readFileSync(join(DATA, "graduated.json"), "utf8"))); }
    catch { return json(res, 200, { list: [], stats: null }); }
  }

  if (url.pathname === "/api/verdicts") {
    const list = board.recentVerdicts(10);
    const hits = list.filter((v) => v.event).length;
    return json(res, 200, { list, hits, n: list.length, overall: board.topDecile(0.1) });
  }

  if (url.pathname === "/api/scoreboard") {
    const c = board.compute(model.outside.base);
    c.topDecile = board.topDecile(0.1);
    return json(res, 200, c);
  }

  if (url.pathname === "/api/activity") {
    const t = url.searchParams.get("token") ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return json(res, 400, { error: "bad token" });
    try {
      const row = await readToken(t);
      const act = await curveActivity(row.curve, null, row.deployer, null, null, OBS_MS, 8);
      const extra = { ...row, outsideBuyerCount: act.outsideBuyers, devDumped: act.devSells > 0 && (row.devBuyPct ?? 0) > 1 };
      extra.deployerLaunches = Math.max(1, countOf(seenByDeployer, row.deployer?.toLowerCase()));
      extra.symbolClones = Math.max(1, countOf(seenBySymbol, String(row.symbol ?? "").toLowerCase()));
      return json(res, 200, { flags: flags(extra, model.outside), outsideBuyers: act.outsideBuyers, devDumped: extra.devDumped, complete: act.complete });
    } catch (e) { return json(res, 200, { error: e.shortMessage ?? e.message }); }
  }

  if (url.pathname === "/api/predict") {
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) return json(res, 400, { error: "empty query" });
    try { return json(res, 200, await lookup(q)); }
    catch (e) { return json(res, 200, { kind: "error", error: e.shortMessage ?? e.message }); }
  }

  res.writeHead(404).end("nope");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`\n  pons-survival · model ${model.version}`);
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log(`  event: outside money >= ${model.eventThreshold}% of threshold within ${model.observationHours}h`);
  console.log(`  base ${(model.outside.base * 100).toFixed(1)}% on ${model.outside.n} launches · holdout AUC ${model.holdout.aucMean}`);
  console.log(`  prediction log: ${PRED_LOG}\n`);
});
