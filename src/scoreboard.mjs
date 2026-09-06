// Public track record: how often our own predictions came true.
//
// Reads two append-only files and keeps an in-memory index. Reads incrementally by
// remembering offsets and consuming only new bytes. The index used to be updated by
// writer callbacks; when one patch silently failed, the board froze at startup values.
// A single file-based source of truth is more reliable.
import { statSync, existsSync, openSync, readSync, closeSync } from "fs";

const preds = new Map();   // token -> { p, t, v }
const outs = new Map();    // token -> { event, share }
const offsets = { pred: 0, res: 0 };
let tail = { pred: "", res: "" };

function readNew(file, key) {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  if (size <= offsets[key]) {
    // A smaller file means it was replaced; read it again from the beginning.
    if (size < offsets[key]) { offsets[key] = 0; tail[key] = ""; }
    else return [];
  }
  const fd = openSync(file, "r");
  const len = size - offsets[key];
  const buf = Buffer.allocUnsafe(len);
  readSync(fd, buf, 0, len, offsets[key]);
  closeSync(fd);
  offsets[key] = size;
  const text = tail[key] + buf.toString("utf8");
  const parts = text.split("\n");
  tail[key] = parts.pop() ?? "";      // The final line may be incomplete.
  return parts;
}

/** Read new content from both files. Called at startup and on a timer. */
export function refresh(predFile, resFile) {
  for (const line of readNew(predFile, "pred")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      preds.set(d.token.toLowerCase(), { p: d.p_outside, t: d.t, v: d.modelVersion, sym: d.symbol });
    } catch {}
  }
  for (const line of readNew(resFile, "res")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      outs.set(d.token.toLowerCase(), { event: d.event, share: d.outsideSharePct, at: d.t });
    } catch {}
  }
  return { predictions: preds.size, resolutions: outs.size };
}

const BINS = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1.01];

export function compute(base) {
  const pairs = [];
  for (const [token, o] of outs) {
    const p = preds.get(token);
    if (p) pairs.push({ p: p.p, y: o.event ? 1 : 0, v: p.v });
  }
  const n = pairs.length;
  const out = {
    made: preds.size, resolved: n, awaiting: preds.size - outs.size,
    brier: null, brierBase: null, auc: null, eventRate: null,
    calibration: [], byVersion: [],
  };
  if (!n) return out;

  out.brier = pairs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / n;
  out.brierBase = pairs.reduce((a, x) => a + (base - x.y) ** 2, 0) / n;
  out.eventRate = pairs.reduce((a, x) => a + x.y, 0) / n;

  for (let i = 0; i < BINS.length - 1; i++) {
    const lo = BINS[i], hi = BINS[i + 1];
    const inBin = pairs.filter((x) => x.p >= lo && x.p < hi);
    if (inBin.length < 15) continue;             // Small bins are noise; do not show them.
    out.calibration.push({
      lo, hi, n: inBin.length,
      said: inBin.reduce((a, x) => a + x.p, 0) / inBin.length,
      actual: inBin.reduce((a, x) => a + x.y, 0) / inBin.length,
    });
  }

  // Compute AUC from rank sums without a quadratic scan.
  const pos = pairs.filter((x) => x.y === 1).length;
  const neg = n - pos;
  if (pos && neg) {
    const all = [...pairs].sort((a, b) => a.p - b.p);
    let i = 0, rsum = 0;
    while (i < all.length) {
      let j = i;
      while (j < all.length && all[j].p === all[i].p) j++;
      const avg = (i + 1 + j) / 2;
      for (let q = i; q < j; q++) if (all[q].y === 1) rsum += avg;
      i = j;
    }
    out.auc = (rsum - (pos * (pos + 1)) / 2) / (pos * neg);
  }

  // Breakdown by version: a history of model changes.
  const vs = new Map();
  for (const x of pairs) {
    const g = vs.get(x.v) ?? { v: x.v, n: 0, se: 0, y: 0, seBase: 0 };
    g.n++; g.se += (x.p - x.y) ** 2; g.seBase += (base - x.y) ** 2; g.y += x.y;
    vs.set(x.v, g);
  }
  out.byVersion = [...vs.values()]
    .map((g) => ({ v: g.v, n: g.n, brier: g.se / g.n, brierBase: g.seBase / g.n, eventRate: g.y / g.n }))
    .sort((a, b) => b.n - a.n);

  return out;
}

/**
 * Outcome rate for predictions with probability at least minP.
 * This is the figure shown beside a top list: "X% of these came true."
 */
export function bandStats(minP) {
  let n = 0, hit = 0, all = 0, allHit = 0;
  for (const [token, o] of outs) {
    const pr = preds.get(token);
    if (!pr) continue;
    all++; if (o.event) allHit++;
    if (pr.p >= minP) { n++; if (o.event) hit++; }
  }
  return { minP, n, hitRate: n ? hit / n : null, base: all ? allHit / all : null, total: all };
}

/**
 * Outcome rate for the top tenth of the ranking. Unlike bandStats, this is a
 * stable model property rather than a reflection of the latest hour. This is
 * the figure shown in the header.
 *
 * Sort ONLY by probability. Sorting by a tuple lets positive outcomes rise among
 * tied probabilities and inflates the result.
 */
export function topDecile(frac = 0.1) {
  const pairs = [];
  for (const [token, o] of outs) {
    const pr = preds.get(token);
    if (pr) pairs.push({ p: pr.p, y: o.event ? 1 : 0 });
  }
  if (pairs.length < 100) return null;
  pairs.sort((a, b) => b.p - a.p);
  const k = Math.max(1, Math.round(pairs.length * frac));
  const top = pairs.slice(0, k);
  const hit = top.reduce((a, x) => a + x.y, 0) / k;
  const base = pairs.reduce((a, x) => a + x.y, 0) / pairs.length;
  return { frac, n: k, hitRate: hit, base, lift: hit / base, cutoff: top[top.length - 1].p };
}

/** Return the token outcome if it has already been recorded. */
export function outcomeOf(token) {
  return outs.get(String(token).toLowerCase()) ?? null;
}

/**
 * Most recently resolved predictions by time, with NO filtering. A "best" ranking
 * becomes an arbitrary sample among tied probabilities at the least calibrated end
 * of the scale. A consecutive feed is more transparent and avoids cherry-picking.
 * Map preserves insertion order and outcomes are appended chronologically, so the
 * tail contains the latest entries.
 */
export function recentVerdicts(n = 10) {
  const all = [];
  for (const [token, o] of outs) {
    const pr = preds.get(token);
    if (pr) all.push({ token, symbol: pr.sym, p: pr.p, event: o.event, share: o.share, at: o.at });
  }
  return all.slice(-n).reverse();
}
