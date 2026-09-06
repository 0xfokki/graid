// Recompute the published track record from the committed data.
//
// The point of this repository is that the numbers on the site are checkable.
// This script is that check: it reads the raw prediction and outcome logs, and
// recomputes every headline figure without trusting anything already written down.
// It also enforces the one claim that cannot be recovered later — that each
// prediction was recorded before its outcome was known.
//
//   node scripts/verify.mjs            print the numbers
//   node scripts/verify.mjs --strict   also exit non-zero if a check fails
import { readFileSync, readdirSync, existsSync } from "fs";
import { gunzipSync } from "zlib";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.DATA_DIR ?? join(ROOT, "data");
const STRICT = process.argv.includes("--strict");

const problems = [];
const fail = (msg) => { problems.push(msg); console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  ok    ${msg}`);

function load(prefix) {
  if (!existsSync(DATA)) return [];
  const out = [];
  for (const f of readdirSync(DATA).filter((f) => f.startsWith(prefix)).sort()) {
    const raw = f.endsWith(".gz")
      ? gunzipSync(readFileSync(join(DATA, f))).toString("utf8")
      : readFileSync(join(DATA, f), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn final line is expected */ }
    }
  }
  return out;
}

const preds = load("predictions");
const res = load("resolutions");
if (!preds.length) {
  console.log(`no data found in ${DATA} — nothing to verify`);
  process.exit(0);
}

// De-duplicate: the logs are append-only, and daily snapshots overlap.
const byToken = new Map();
for (const d of preds) if (d.token && d.p_outside != null) byToken.set(d.token.toLowerCase(), d);
const outcome = new Map();
for (const d of res) if (d.token) outcome.set(d.token.toLowerCase(), d);

console.log(`\ndata\n  ${byToken.size} unique predictions, ${outcome.size} resolved\n`);

// ── integrity: the claim that cannot be reconstructed after the fact ───────────
console.log("integrity");
let late = 0, missing = 0;
for (const [token, o] of outcome) {
  const p = byToken.get(token);
  if (!p) { missing++; continue; }
  if (Date.parse(o.t) < Date.parse(p.t)) late++;
}
late ? fail(`${late} outcomes are timestamped before their own prediction`)
     : pass("every outcome is timestamped after the prediction it scores");
missing ? fail(`${missing} outcomes have no matching prediction`)
        : pass("every outcome refers to a prediction that exists");

const noFeatures = [...byToken.values()].filter((d) => !d.f || !d.modelVersion).length;
noFeatures ? fail(`${noFeatures} predictions carry no features or model version`)
           : pass("every prediction records its model version and inputs");

// ── metrics, recomputed from scratch ──────────────────────────────────────────
const pairs = [];
for (const [token, o] of outcome) {
  const p = byToken.get(token);
  if (p) pairs.push({ p: p.p_outside, y: o.event ? 1 : 0 });
}
if (pairs.length < 100) {
  console.log("\ntoo few resolved outcomes to score");
  process.exit(problems.length && STRICT ? 1 : 0);
}

const n = pairs.length;
const base = pairs.reduce((a, x) => a + x.y, 0) / n;
const brier = pairs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / n;
const brierBase = pairs.reduce((a, x) => a + (base - x.y) ** 2, 0) / n;

// AUC via rank sums, with ties averaged.
const sorted = [...pairs].sort((a, b) => a.p - b.p);
const pos = pairs.filter((x) => x.y === 1).length, neg = n - pos;
let i = 0, rsum = 0;
while (i < sorted.length) {
  let j = i;
  while (j < sorted.length && sorted[j].p === sorted[i].p) j++;
  const avg = (i + 1 + j) / 2;
  for (let q = i; q < j; q++) if (sorted[q].y === 1) rsum += avg;
  i = j;
}
const auc = (rsum - (pos * (pos + 1)) / 2) / (pos * neg);

// Top decile, ranked by probability only.
const ranked = [...pairs].sort((a, b) => b.p - a.p);
const k = Math.max(1, Math.round(n * 0.1));
const hit = ranked.slice(0, k).reduce((a, x) => a + x.y, 0) / k;

console.log(`
scored          ${n}
base rate       ${(base * 100).toFixed(1)}%
AUC             ${auc.toFixed(3)}
Brier           ${brier.toFixed(3)}   (${brierBase.toFixed(3)} for always guessing the base rate)
top decile      ${(hit * 100).toFixed(1)}%   lift ${(hit / base).toFixed(2)}x
`);

console.log("sanity");
auc > 0.5 ? pass(`AUC ${auc.toFixed(3)} beats a coin flip`)
          : fail(`AUC ${auc.toFixed(3)} is no better than chance`);
brier < brierBase ? pass("the model beats always predicting the base rate")
                  : fail(`Brier ${brier.toFixed(3)} is worse than the base rate ${brierBase.toFixed(3)}`);

// ── does the README still describe this data? ─────────────────────────────────
// A loose band on purpose: the data grows on every push while the README is a
// dated snapshot. This catches a claim that has drifted away from reality, not
// the ordinary lag of a few hours.
const readme = join(ROOT, "README.md");
if (existsSync(readme)) {
  console.log("\nreadme");
  const text = readFileSync(readme, "utf8");
  const claimed = text.match(/\|\s*Live AUC\s*\|\s*\*\*([\d.]+)\*\*\s*\|/);
  if (!claimed) console.log("  --    no AUC claim found to check");
  else {
    const said = parseFloat(claimed[1]);
    Math.abs(said - auc) <= 0.03
      ? pass(`README claims AUC ${said}, data gives ${auc.toFixed(3)}`)
      : fail(`README claims AUC ${said} but the data gives ${auc.toFixed(3)}`);
  }
}

console.log();
if (problems.length) {
  console.log(`${problems.length} check(s) failed`);
  process.exit(STRICT ? 1 : 0);
}
console.log("all checks passed");
