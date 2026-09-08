#!/usr/bin/env node
// A terminal view of the same agent the site runs.
//
// It reads launches off Robinhood Chain, scores each one, and prints the call it
// would have written down - the same model, the same seven features, the same
// flags. What it adds over a block explorer is the score and the record behind
// it: every line says how often calls at that level actually came true.
//
//   npm run watch                  follow live
//   node src/console.mjs --once    render one frame and exit
//   ROWS=10 npm run watch          how many launches to keep on screen
//   NOCOLOR=1 npm run watch        plain output, for piping to a file
import { readFileSync, readdirSync, existsSync } from "fs";
import { gunzipSync } from "zlib";
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
const PLAIN = !!process.env.NOCOLOR;
// Replay walks the recorded predictions at a steady pace. Launches arrive in
// bursts with minutes of nothing in between, which is honest but makes for a dead
// screen; the tickers, scores and features are all real, read out of data/ -
// only their timing is ours.
const DEMO = process.argv.includes("--demo") || !!process.env.DEMO;
const EVERY = Number(process.env.EVERY ?? 900);

// ── colour ───────────────────────────────────────────────────────────────────
const rgb = (r, g, b) => (PLAIN ? "" : `\x1b[38;2;${r};${g};${b}m`);
const bg = (r, g, b) => (PLAIN ? "" : `\x1b[48;2;${r};${g};${b}m`);
// The greys are lifted well above the site's: a page is read on a bright screen
// at close range, a terminal often is not, and the darkest two tiers were
// disappearing into the background entirely.
const C = {
  acid: rgb(168, 255, 98), amber: rgb(245, 200, 90), orange: rgb(255, 120, 82),
  paper: rgb(242, 242, 234), muted: rgb(186, 188, 178), dim: rgb(148, 150, 140),
  faint: rgb(112, 114, 106),
  bold: PLAIN ? "" : "\x1b[1m", off: PLAIN ? "" : "\x1b[0m",
};

// A continuous ramp rather than three steps: orange at nothing, amber through
// the middle, acid at the top. The site shows bands because a reader needs a
// verdict; here the extra resolution is free and the eye follows it.
function ramp(p) {
  const stops = [[0, 255, 101, 61], [0.5, 240, 192, 74], [1, 168, 255, 98]];
  const x = Math.max(0, Math.min(1, p));
  for (let i = 1; i < stops.length; i++) {
    const [a, ar, ag, ab] = stops[i - 1], [b, br, bg_, bb] = stops[i];
    if (x <= b) {
      const t = (x - a) / (b - a);
      return rgb(Math.round(ar + (br - ar) * t),
                 Math.round(ag + (bg_ - ag) * t),
                 Math.round(ab + (bb - ab) * t));
    }
  }
  return C.acid;
}

const BLOCKS = "▁▂▃▄▅▆▇█";
const pct = (x) => (x * 100).toFixed(1) + "%";
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
// Length as the terminal sees it, with the escape sequences taken out.
const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

// A filled run on a visible track, the way a gauge reads. Without the track a
// low score looks like an empty row rather than a small number.
function bar(p, width, col) {
  const filled = Math.max(0, Math.min(1, p)) * width;
  const whole = Math.floor(filled);
  const rest = filled - whole;
  let head = "";
  if (whole < width && rest > 0.08) head = BLOCKS[Math.max(0, Math.round(rest * 7) - 1)];
  const used = whole + (head ? 1 : 0);
  return col + "█".repeat(whole) + head + C.off +
         C.faint + "─".repeat(Math.max(0, width - used)) + C.off;
}

function spark(values, width) {
  if (!values.length) return " ".repeat(width);
  const take = values.slice(-width);
  return take.map((v) => BLOCKS[Math.min(7, Math.max(0, Math.round(v * 7)))]).join("");
}

// Each ticker keeps its own hue, picked from the symbol so it is stable between
// frames. Muted on purpose: the eye should separate the rows, not be shouted at.
const HUES = [
  [168, 255, 98], [126, 217, 87], [240, 192, 74], [255, 158, 66],
  [255, 101, 61], [120, 200, 160], [150, 190, 230], [200, 160, 220],
];
function hue(sym) {
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

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
const history = [];              // every score seen, for the sparkline
let cursor = null;
let record = null;
let checked = 0, started = Date.now(), frame = 0, polling = false, lastPoll = 0;

async function loadRecord() {
  try {
    const b = await (await fetch(API + "/api/scoreboard")).json();
    record = { auc: b.auc, resolved: b.resolved, base: b.eventRate,
               hit: b.topDecile && b.topDecile.hitRate };
  } catch { /* the view still works without it; those lines are simply omitted */ }
}

// ── replay ───────────────────────────────────────────────────────────────────
let tape = [], tapeAt = 0;

function loadTape() {
  const dir = join(HERE, "..", "data");
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.startsWith("predictions-")).sort();
  const all = [];
  for (const f of files.slice(-2)) {
    const text = f.endsWith(".gz")
      ? gunzipSync(readFileSync(join(dir, f))).toString("utf8")
      : readFileSync(join(dir, f), "utf8");
    for (const line of text.split(String.fromCharCode(10))) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.symbol && d.p_outside != null && d.f) all.push(d);
      } catch { /* a torn final line is expected in an append-only log */ }
    }
  }
  // A contiguous stretch rather than a shuffle, so consecutive rows come from the
  // same minutes of the chain and the mix of scores looks the way it really did.
  if (all.length > 600) {
    const start = Math.floor(Math.random() * (all.length - 600));
    tape = all.slice(start, start + 600);
  } else tape = all;
}

function step() {
  if (!tape.length) return;
  const d = tape[tapeAt % tape.length];
  tapeAt++;
  const row = { ...d.f, symbol: d.symbol };
  row.deployerLaunches = d.f.deployerLaunches ?? 1;
  row.symbolClones = d.f.symbolClones ?? 1;
  rows.unshift({
    at: Date.now(), p: d.p_outside, token: d.token,
    symbol: String(d.symbol).slice(0, 14) || "?",
    phase: "on curve",
    devBuyPct: d.f.devBuyPct,
    flags: (flags(row, model.outside) ?? []).slice(0, 3),
  });
  history.push(d.p_outside);
  if (history.length > 400) history.shift();
  checked++;
  if (rows.length > ROWS) rows.length = ROWS;
}

async function poll() {
  polling = true;
  try {
    const head = await READ.getBlockNumber();
    if (cursor === null) cursor = head - 300n;
    if (head <= cursor) return;
    let from = cursor + 1n;
    if (head - from > 12000n) from = head - 12000n;
    const logs = await LOGS.getLogs({
      address: FACTORY, event: evTokenLaunched, fromBlock: from, toBlock: head,
    });
    cursor = head;
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
          at: Date.now(), p: out.p, token: l.args.token,
          symbol: String(row.symbol ?? "").slice(0, 14) || "?",
          phase: PHASE[row.phase] ?? "on curve",
          devBuyPct: row.devBuyPct,
          flags: (flags(row, model.outside) ?? []).slice(0, 3),
        });
        history.push(out.p);
        if (history.length > 400) history.shift();
        checked++;
        if (rows.length > ROWS) rows.length = ROWS;
      } catch { /* a launch we cannot read is skipped rather than half-printed */ }
    }
  } finally { polling = false; lastPoll = Date.now(); }
}

// ── render ───────────────────────────────────────────────────────────────────
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function draw() {
  frame++;
  const W = Math.min(Math.max(84, process.stdout.columns || 100) - 2, 104);
  const out = [];
  const line = (ch) => C.faint + ch.repeat(W) + C.off;

  // Header. The logo never dims - it breathes upward, towards white, so the mark
  // stays at full strength and the movement reads as a highlight passing over it
  // rather than as the thing fading out.
  const t = 0.5 + 0.5 * Math.sin(frame / 10);
  const mix = 0.22 * t;
  const lr = Math.round(168 + (255 - 168) * mix);
  const lg = 255;
  const lb = Math.round(98 + (255 - 98) * mix);
  out.push("");
  for (const l of LOGO) out.push(rgb(lr, lg, lb) + C.bold + "  " + l + C.off);
  out.push(C.muted + "  scores every launch on Robinhood Chain before the outcome exists" + C.off);
  out.push("");

  const dot = polling ? C.amber + SPIN[frame % SPIN.length]
                      : C.acid + (frame % 8 < 4 ? "●" : "○");
  out.push(
    "  " + dot + C.off + " " + C.acid + C.bold + "graid watch" + C.off +
    C.faint + "  ·  " + C.off + C.muted + "pons v2" + C.off +
    C.faint + "  ·  " + C.off + C.muted + "chain 4663" + C.off +
    C.faint + "  ·  " + C.off + bg(168, 255, 98) + rgb(7, 8, 6) + " READ ONLY " + C.off +
    C.faint + "  ·  " + C.off + C.muted + "no signer" + C.off +
    C.faint + "  ·  " + C.off +
    (DEMO ? C.amber + "replay" : C.muted + "live chain") + C.off);
  out.push(
    C.dim + "  " + new Date().toISOString().slice(11, 19) +
    "   scored " + C.off + C.paper + checked + C.off +
    C.dim + "   model " + C.off + C.muted + model.version + C.off +
    C.dim + "   up " + C.off + C.muted + Math.round((Date.now() - started) / 1000) + "s" + C.off +
    (history.length ? C.faint + "   " + C.off + ramp(history[history.length - 1]) +
      spark(history, 28) + C.off : ""));
  out.push(line("─"));

  if (!rows.length) {
    out.push("");
    out.push(C.dim + "  " + SPIN[frame % SPIN.length] + "  waiting for the next launch…" + C.off);
  }

  for (const r of rows) {
    const age = (Date.now() - r.at) / 1000;
    const fresh = age < 12;                       // newly arrived rows announce themselves
    const col = ramp(r.p);
    const clock = new Date(r.at).toISOString().slice(11, 19);
    const mark = fresh
      ? (frame % 6 < 3 ? C.acid + C.bold + "▶" : C.amber + "▶")
      : C.faint + "│";
    // The gauge runs up to the score over the first second, so a new row is read
    // as something happening rather than as another line of text.
    // A single frame has no time to animate, so it draws the gauge at rest.
    const grow = ONCE ? 1 : Math.min(1, Math.max(0, age / 1.1));
    const shown = r.p * (grow < 1 ? grow * grow * (3 - 2 * grow) : 1);
    const [hr, hg, hb] = hue(r.symbol);
    const tick = fresh ? rgb(hr, hg, hb) + C.bold : rgb(Math.round(hr * .62), Math.round(hg * .62), Math.round(hb * .62));

    out.push("");
    out.push(
      "  " + mark + C.off + " " + C.faint + clock + C.off + "  " +
      tick + pad("$" + r.symbol, 16) + C.off +
      C.faint + r.token.slice(0, 6) + "…" + r.token.slice(-4) + C.off +
      "  " + C.faint + pad(r.phase, 10) + C.off +
      bar(shown, 18, col) + " " + col + C.bold + rpad(pct(r.p), 7) + C.off);

    const texts = r.flags.map((f) => String(f.text || "").toLowerCase());
    const bits = [];
    // The flags already mention the creator buy when it matters; printing it
    // separately as well read as the same fact twice with different rounding.
    if (r.devBuyPct != null && !texts.some((t) => t.startsWith("creator in")))
      bits.push("creator in " + r.devBuyPct.toFixed(1) + "%");
    for (const t of texts) bits.push(t);
    out.push("    " + C.faint + "│  " + C.off + C.dim + bits.join(C.faint + " · " + C.dim) + C.off);

    if (record && record.resolved) {
      const note = r.p > 0.7
        ? "calls this high came true " + pct(record.hit ?? 0) + " of the time"
        : "outside money arrives " + pct(record.base) + " of the time overall";
      out.push("    " + C.faint + "└  written before the outcome · " + note + C.off);
    }
  }

  out.push("");
  out.push(line("─"));
  if (record && record.resolved) {
    out.push(
      "  " + C.muted + "record" + C.off +
      C.faint + "   " + C.off + C.paper + record.resolved.toLocaleString("en-US") + C.off +
      C.faint + " scored" + C.off +
      C.faint + "   AUC " + C.off + C.paper + record.auc.toFixed(3) + C.off +
      C.faint + "   base " + C.off + C.paper + pct(record.base) + C.off +
      C.faint + "   recompute it yourself: npm run verify" + C.off);
  }
  out.push(C.faint + "  ctrl+c to stop · nothing is signed, no wallet is touched · graid-ai.com" + C.off);
  out.push("");

  // Pad every line to the same width and repaint in place. Clearing the screen
  // each frame makes the whole thing flicker at this rate.
  const painted = out.map((l) => l + " ".repeat(Math.max(0, W + 2 - vis(l))) + C.off).join("\n");
  process.stdout.write("\x1b[H" + painted + "\x1b[J\n");
}

// ── run ──────────────────────────────────────────────────────────────────────
await loadRecord();
if (DEMO) {
  loadTape();
  for (let i = 0; i < ROWS; i++) step();      // open on a full screen, not an empty one
} else {
  try { await poll(); } catch { /* the first pass can race the RPC; the next retries */ }
}

if (ONCE) {
  process.stdout.write("\x1b[2J");
  draw();
} else {
  process.stdout.write("\x1b[2J\x1b[?25l");                  // clear once, hide the cursor
  const stop = () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  draw();
  setInterval(draw, 250);                                    // smooth enough to animate
  if (DEMO) setInterval(step, EVERY);
  else setInterval(async () => { try { await poll(); } catch {} }, 4000);
  setInterval(loadRecord, 60000);
}
