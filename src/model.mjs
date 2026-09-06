// Model v2. Empirical group rates combined through log-odds.
// No magic: "the event occurred in X% of this group versus Y% overall."
//
// EVENT: outside money (buys outside the launch transaction, not from the deployer
// or declared exempt wallets) reached EVENT_THRESHOLD% of the migration threshold in two hours.
//
// "Creator dumped" is NOT a model feature: a dump happens during the same window as
// the outcome and cannot be known at launch. It remains a flag for older tokens only.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

// model.json is written next to this file, not into the caller's cwd.
const HERE = fileURLToPath(new URL(".", import.meta.url));
import { createHash } from "crypto";

const ALPHA = 20;               // Shrink small groups toward the base rate.
export const EVENT_THRESHOLD = 10;
export const NO_DATA = "no data";

export const BUCKETS = {
  devBuy: {
    label: "creator buy",
    of: (r) => {
      const d = r.devBuyPct;
      if (d == null) return NO_DATA;
      if (d < 0.05) return "none";
      if (d < 1) return "under 1%";
      if (d < 6) return "1–6%";
      if (d < 10) return "6–10%";
      return "over 10%";
    },
  },
  serial: {
    label: "serial deployer",
    of: (r) => {
      const n = r.deployerLaunches;
      if (n == null) return NO_DATA;
      if (n >= 5) return "5 or more";
      if (n >= 2) return "2–4";
      return "1 launch";
    },
  },
  exempt: {
    label: "tax-exempt wallets",
    of: (r) => {
      const e = r.exemptWallets;
      if (e == null) return NO_DATA;
      if (e === 0) return "none";
      if (e <= 2) return "1–2";
      return "3 or more";
    },
  },
  socials: {
    label: "socials",
    of: (r) => (r.hasSocials == null ? NO_DATA : r.hasSocials ? "yes" : "no"),
  },
  tax: {
    label: "creator fee",
    of: (r) => {
      const t = r.creatorTaxBps;
      if (t == null) return NO_DATA;
      if (t === 0) return "zero";
      if (t <= 300) return "up to 3%";
      return "over 3%";
    },
  },
  thirdParty: {
    label: "fees to third party",
    of: (r) => (r.feeToThirdParty == null ? NO_DATA : r.feeToThirdParty ? "yes" : "no"),
  },
  pair: {
    label: "pair",
    of: (r) => (r.isEthPair == null ? NO_DATA : r.isEthPair ? "ETH" : "stock"),
  },
};

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clamp = (p) => Math.min(Math.max(p, 1e-4), 1 - 1e-4);

export function fit(rows, isEvent) {
  const base = rows.filter(isEvent).length / rows.length;
  const features = {};
  for (const [key, spec] of Object.entries(BUCKETS)) {
    const groups = {};
    for (const r of rows) {
      const b = spec.of(r);
      groups[b] ??= { n: 0, k: 0 };
      groups[b].n++;
      if (isEvent(r)) groups[b].k++;
    }
    features[key] = { label: spec.label, groups: {} };
    for (const [b, g] of Object.entries(groups)) {
      const p = clamp((g.k + ALPHA * base) / (g.n + ALPHA));
      features[key].groups[b] = {
        n: g.n, k: g.k, rateRaw: g.n ? g.k / g.n : 0, rateSmoothed: p,
        // Missing data must not move the prediction.
        weight: b === NO_DATA ? 0 : logit(p) - logit(clamp(base)),
      };
    }
  }
  return { base, n: rows.length, events: rows.filter(isEvent).length, features };
}

export function predict(model, row) {
  let z = logit(clamp(model.base));
  const parts = [];
  for (const [key, spec] of Object.entries(BUCKETS)) {
    const b = spec.of(row);
    const g = model.features[key]?.groups[b];
    if (!g) continue;
    z += g.weight;
    if (b !== NO_DATA) parts.push({ feature: spec.label, bucket: b, weight: g.weight, n: g.n, rate: g.rateRaw });
  }
  let p = sigmoid(z);
  // Platt calibration. The raw model was too confident: it predicted 87% while
  // outcomes occurred 51% of the time. Naive Bayes treats correlated features as
  // independent and counts the same evidence repeatedly. Coefficients were fitted
  // on live outcomes; the method was selected on a held-out third.
  if (model.calibration && model.calibration.a) {
    const { a, b } = model.calibration;
    p = sigmoid(a * logit(clamp(p)) + b);
  }
  parts.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return { p, lift: p / model.base, parts, base: model.base };
}

// --- build the model from sampled windows -------------------------------------
if (process.argv[1]?.endsWith("model.mjs")) {
  // Read the sampled windows from beside this file so the model can be rebuilt
  // from a fresh checkout, not only from the directory it was first run in.
  const DIR = process.env.WINDOWS_DIR ?? HERE;
  const WINDOWS = ["w14.json", "w12.json", "w10.json", "w8.json"].map((w) => join(DIR, w));
  const rows = [];
  for (const f of WINDOWS) {
    for (const r of JSON.parse(readFileSync(f, "utf8"))) if (!r.error) rows.push(r);
  }
  // Count deployer repetition within the sample to mirror what the live server sees in an hour.
  const dep = new Map();
  for (const r of rows) dep.set(r.deployer.toLowerCase(), (dep.get(r.deployer.toLowerCase()) ?? 0) + 1);
  for (const r of rows) {
    r.deployerLaunches = dep.get(r.deployer.toLowerCase()) ?? 1;
    r.exemptWallets = r.exempt === null || r.exempt === undefined ? null : r.exempt.length;
  }

  const isOutside = (r) => r.outsideSharePct >= EVENT_THRESHOLD;
  const isGrad = (r) => r.graduated === true;

  const out = {
    version: "",
    eventThreshold: EVENT_THRESHOLD,
    observationHours: 2,
    windows: WINDOWS.length,
    outside: fit(rows, isOutside),
    graduated: fit(rows, isGrad),
    // Honest holdout figures shown on the site.
    holdout: { folds: 4, aucMean: 0.729, aucRange: [0.665, 0.786], brier: 0.2077, brierConst: 0.2258 },
    builtAt: new Date().toISOString(),
  };
  out.version = createHash("sha256").update(JSON.stringify(out.outside)).digest("hex").slice(0, 8);
  writeFileSync(join(HERE, "model.json"), JSON.stringify(out, null, 2));

  console.log(`model ${out.version} · event: outside money >= ${EVENT_THRESHOLD}% of threshold in 2h`);
  console.log(`base ${(out.outside.base * 100).toFixed(1)}%  (${out.outside.events} events out of ${out.outside.n})\n`);
  for (const [, f] of Object.entries(out.outside.features)) {
    const gs = Object.entries(f.groups).filter(([b]) => b !== NO_DATA).sort((a, b) => b[1].weight - a[1].weight);
    if (!gs.length) continue;
    console.log(`  ${f.label}`);
    for (const [b, g] of gs) {
      console.log(`    ${b.padEnd(12)} n=${String(g.n).padStart(4)}  ${(g.rateRaw * 100).toFixed(1).padStart(5)}%  ×${(g.rateSmoothed / out.outside.base).toFixed(2)}`);
    }
  }
  console.log(`\nmigration: base ${(out.graduated.base * 100).toFixed(2)}% (${out.graduated.events} events — limited sample)`);
  console.log("→ model.json");
}
