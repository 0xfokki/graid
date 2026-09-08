#!/usr/bin/env node
// A terminal view of the same agent the site runs.
//
// It reads launches off Robinhood Chain, scores each one, and prints the call it
// would have written down - the same model, the same seven features, the same
// flags. What it adds over a block explorer is the score and the record behind
// it: every line says how often calls at that level actually came true.
//
//   node src/console.mjs           follow live
//   node src/console.mjs --once    render one frame and exit
//   ROWS=8 node src/console.mjs    how many launches to keep on screen
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { LOGS, READ, FACTORY, evTokenLaunched, readToken, PHASE } from "./chain.mjs";
import { predict } from "./model.mjs";
import { flags } from "./flags.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const model = JSON.parse(readFileSync(join(HERE, "model.json"), "utf8"));
const ONCE = process.argv.includes("--once");
const ROWS = Number(process.env.ROWS ?? 6);
const API = process.env.API ?? "https://graid-ai.com";

// ── colour ───────────────────────────────────────────────────────────────────
const C = {
  acid: "\x1b[38;2;168;255;98m",
  amber: "\x1b[38;2;240;192;74m",
  orange: "\x1b[38;2;255;101;61m",
  paper: "\x1b[38;2;232;232;221m",
  muted: "\x1b[38;2;133;135;127m",
  dim: "\x1b[38;2;92;94;88m",
  bold: "\x1b[1m",
  off: "\x1b[0m",
};
// Green above 70, amber down to 30, orange below - the bands the site uses, so a
// number means the same thing in both places.
const band = (p) => (p > 0.7 ? C.acid : p >= 0.3 ? C.amber : C.orange);
const pct = (x) => (x * 100).toFixed(1) + "%";
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

const LOGO = [
  " ██████  ██████   █████  ██ ██████ ",
  "██       ██   ██ ██   ██ ██ ██   ██",
  "██  ███  ██████  ███████ ██ ██   ██",
  "██   ██  ██   ██ ██   ██ ██ ██   ██",
  " ██████  ██   ██ ██   ██ ██ ██████ ",
];

// ── state ────────────────────────────────────────────────────────────────────
const seen = new Set();
const rows = [];
let cursor = null;
let record = null;      // live track record, for the line under each score
let checked = 0, started = Date.now();

async function loadRecord() {
  try {
    const r = await fetch(API + "/api/scoreboard");
    const b = await r.json();
    record = { auc: b.auc, resolved: b.resolved, base: b.eventRate,
               hit: b.topDecile && b.topDecile.hitRate };
  } catch { /* the console still works without it; the line is simply omitted */ }
}

async function poll() {
  const head = await READ.getBlockNumber();
  if (cursor === null) cursor = head - 300n;
  if (head <= cursor) return;
  let from = cursor + 1n;
  if (head - from > 12000n) from = head - 12000n;
  const logs = await LOGS.getLogs({
    address: FACTORY, event: evTokenLaunched, fromBlock: from, toBlock: head,
  });
  cursor = head;
  // Newest first, and only as many as fit: this is a window on the flow, not a
  // ledger. The ledger is the repository.
  for (const l of logs.slice(-ROWS).reverse()) {
    const key = l.transactionHash + ":" + l.logIndex;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const row = await readToken(l.args.token, { tx: l.transactionHash });
      row.deployerLaunches = 1;
      row.symbolClones = 1;
      const out = predict(model.outside, row);
      rows.unshift({
        at: Date.now(),
        symbol: String(row.symbol ?? "").slice(0, 14) || "?",
        token: l.args.token,
        phase: PHASE[row.phase] ?? "on curve",
        p: out.p,
        devBuyPct: row.devBuyPct,
        flags: (flags(row, model.outside) ?? []).slice(0, 3),
      });
      checked++;
      if (rows.length > ROWS) rows.length = ROWS;
    } catch { /* a launch we cannot read is skipped rather than half-printed */ }
  }
}

// ── render ───────────────────────────────────────────────────────────────────
function draw() {
  const w = Math.max(78, process.stdout.columns || 100);
  const t = new Date().toISOString().slice(11, 19);
  const out = [];
  const rule = C.dim + "─".repeat(Math.min(w - 2, 96)) + C.off;

  out.push("");
  for (const l of LOGO) out.push(C.acid + C.bold + l + C.off);
  out.push(C.muted + " scores every launch on Robinhood Chain before the outcome exists" + C.off);
  out.push("");
  out.push(
    C.acid + C.bold + "graid watch" + C.off + C.dim + " · " + C.off +
    C.muted + "pons v2" + C.off + C.dim + " · " + C.off +
    C.muted + "Robinhood Chain (4663)" + C.off + C.dim + " · " + C.off +
    "\x1b[48;2;168;255;98m\x1b[38;2;7;8;6m READ ONLY \x1b[0m" + C.dim + " · " + C.off +
    C.muted + "no signer" + C.off + C.dim + " · " + C.off +
    C.muted + "live chain" + C.off);
  out.push(C.dim + t + "  checked " + checked + " · on screen " + rows.length +
           " · model " + model.version + " · uptime " +
           Math.round((Date.now() - started) / 1000) + "s" + C.off);
  out.push(rule);

  if (!rows.length) {
    out.push("");
    out.push(C.dim + "  waiting for the next launch…" + C.off);
  }

  for (const r of rows) {
    const clock = new Date(r.at).toISOString().slice(11, 19);
    const col = band(r.p);
    out.push("");
    out.push(
      C.dim + clock + "  " + C.off +
      C.paper + C.bold + pad("$" + r.symbol, 16) + C.off +
      C.dim + r.token.slice(0, 8) + "…" + r.token.slice(-4) + "  " + C.off +
      C.muted + pad(r.phase, 11) + C.off +
      col + C.bold + rpad(pct(r.p), 7) + C.off);
    const bits = [];
    const texts = r.flags.map((f) => String(f.text || "").toLowerCase());
    // The flag list already mentions the creator buy when it matters; printing it
    // separately as well read as the same fact twice with different rounding.
    if (r.devBuyPct != null && !texts.some((t) => t.startsWith("creator in")))
      bits.push("creator in " + r.devBuyPct.toFixed(1) + "%");
    for (const t of texts) bits.push(t);
    out.push(C.dim + "  " + bits.join(" · ") + C.off);
    // The line that a block explorer cannot print: how often we are right at
    // this level, taken from the record rather than asserted.
    if (record && record.resolved) {
      const note = r.p > 0.7
        ? "calls this high came true " + pct(record.hit ?? 0) + " of the time"
        : "outside money arrives " + pct(record.base) + " of the time overall";
      out.push(C.dim + "  written before the outcome · " + note + C.off);
    }
  }

  out.push("");
  out.push(rule);
  if (record && record.resolved) {
    out.push(
      C.muted + " record  " + C.off +
      C.paper + record.resolved.toLocaleString("en-US") + C.off + C.dim + " scored · " + C.off +
      C.paper + "AUC " + record.auc.toFixed(3) + C.off + C.dim + " · base " + C.off +
      C.paper + pct(record.base) + C.off +
      C.dim + " · recomputable with npm run verify" + C.off);
  }
  out.push(C.dim + " ctrl+c to stop · nothing is signed, no wallet is touched · graid-ai.com" + C.off);
  out.push("");

  // Repaint from the top rather than scrolling, so the frame stays still.
  process.stdout.write("\x1b[H\x1b[2J" + out.join("\n") + "\n");
}

// ── run ──────────────────────────────────────────────────────────────────────
await loadRecord();
try { await poll(); } catch { /* first pass may race the RPC; the next one retries */ }
draw();

if (!ONCE) {
  process.stdout.write("\x1b[?25l");                       // hide the cursor
  const stop = () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(async () => { try { await poll(); } catch {} draw(); }, 4000);
  setInterval(loadRecord, 60000);
  setInterval(draw, 1000);                                 // keep the clock moving
}
