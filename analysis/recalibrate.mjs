// Fit the probability calibration on resolved live predictions and validate it
// on a later, untouched slice. This deliberately reconstructs the raw score
// from the recorded inputs: fitting on already-calibrated p_outside values would
// compound whichever calibration happened to be deployed at the time.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { gunzipSync } from "zlib";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { predict } from "../src/model.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.DATA_DIR ?? join(ROOT, "data");
const MODEL_FILE = process.env.MODEL_FILE ?? join(ROOT, "src", "model.json");
// By default fit on the recent-but-not-latest 30% and reserve the newest 15%.
// Early live traffic came from a different base-rate regime and otherwise pulls
// the intercept upward long after that regime has ended.
const TRAIN_START = Number(process.env.TRAIN_START ?? 0.70);
const TRAIN_END = Number(process.env.TRAIN_END ?? 0.90);
const EPS = 1e-6;
const BINS = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1.01];

function load(prefix) {
  if (!existsSync(DATA)) return [];
  const rows = [];
  for (const file of readdirSync(DATA).filter((f) => f.startsWith(prefix)).sort()) {
    const body = file.endsWith(".gz")
      ? gunzipSync(readFileSync(join(DATA, file))).toString("utf8")
      : readFileSync(join(DATA, file), "utf8");
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* tolerate a torn final line */ }
    }
  }
  return rows;
}

const clamp = (p) => Math.max(EPS, Math.min(1 - EPS, p));
const logit = (p) => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// Newton/IRLS fit for y ~ sigmoid(a * logit(rawP) + b).
function fitPlatt(rows) {
  let a = 1, b = 0;
  for (let step = 0; step < 50; step++) {
    let gaa = 0, gab = 0, gbb = 0, ga = 0, gb = 0;
    for (const row of rows) {
      const x = logit(row.rawP);
      const q = sigmoid(a * x + b);
      const w = Math.max(EPS, q * (1 - q));
      ga += (q - row.y) * x;
      gb += q - row.y;
      gaa += w * x * x;
      gab += w * x;
      gbb += w;
    }
    // Tiny ridge term keeps the two-by-two solve stable without affecting the fit.
    gaa += 1e-8; gbb += 1e-8;
    const det = gaa * gbb - gab * gab;
    const da = (gbb * ga - gab * gb) / det;
    const db = (gaa * gb - gab * ga) / det;
    a -= da; b -= db;
    if (Math.max(Math.abs(da), Math.abs(db)) < 1e-10) break;
  }
  if (!(a > 0) || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`invalid monotone calibration fit: a=${a}, b=${b}`);
  }
  return { a, b };
}

function evaluate(rows, calibration) {
  const scored = rows.map((row) => ({
    ...row,
    p: sigmoid(calibration.a * logit(row.rawP) + calibration.b),
  }));
  const rate = scored.reduce((sum, row) => sum + row.y, 0) / scored.length;
  const brier = scored.reduce((sum, row) => sum + (row.p - row.y) ** 2, 0) / scored.length;
  const base = scored.reduce((sum, row) => sum + (rate - row.y) ** 2, 0) / scored.length;
  const calibrationRows = [];
  for (let i = 0; i < BINS.length - 1; i++) {
    const lo = BINS[i], hi = BINS[i + 1];
    const bin = scored.filter((row) => row.p >= lo && row.p < hi);
    if (bin.length < 15) continue;
    calibrationRows.push({
      range: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}%`,
      n: bin.length,
      said: bin.reduce((sum, row) => sum + row.p, 0) / bin.length,
      actual: bin.reduce((sum, row) => sum + row.y, 0) / bin.length,
    });
  }
  return { n: scored.length, rate, brier, base, calibrationRows };
}

function print(label, result) {
  console.log(`\n${label}: n=${result.n}, rate=${(result.rate * 100).toFixed(1)}%, ` +
    `Brier=${result.brier.toFixed(4)} (base ${result.base.toFixed(4)})`);
  console.table(result.calibrationRows.map((row) => ({
    ...row,
    said: `${(row.said * 100).toFixed(1)}%`,
    actual: `${(row.actual * 100).toFixed(1)}%`,
  })));
}

const model = JSON.parse(readFileSync(MODEL_FILE, "utf8"));
const rawModel = { ...model.outside };
delete rawModel.calibration;

const predictions = new Map();
for (const row of load("predictions")) {
  if (row.token && row.f) predictions.set(row.token.toLowerCase(), row);
}
const outcomes = new Map();
for (const row of load("resolutions")) {
  if (row.token) outcomes.set(row.token.toLowerCase(), row);
}

const pairs = [];
for (const [token, outcome] of outcomes) {
  const logged = predictions.get(token);
  if (!logged) continue;
  const rawP = predict(rawModel, logged.f).p;
  pairs.push({ rawP, y: outcome.event ? 1 : 0, at: Date.parse(outcome.t) });
}
pairs.sort((x, y) => x.at - y.at);
if (pairs.length < 100) throw new Error(`only ${pairs.length} usable resolved predictions`);

if (!(TRAIN_START >= 0 && TRAIN_START < TRAIN_END && TRAIN_END < 1)) {
  throw new Error("TRAIN_START and TRAIN_END must satisfy 0 <= start < end < 1");
}
const start = Math.floor(pairs.length * TRAIN_START);
const cut = Math.floor(pairs.length * TRAIN_END);
const train = pairs.slice(start, cut);
const test = pairs.slice(cut);
const calibration = process.env.CAL_A != null && process.env.CAL_B != null
  ? { a: Number(process.env.CAL_A), b: Number(process.env.CAL_B) }
  : fitPlatt(train);

console.log(`fitted on chronological rows ${start + 1}-${cut} of ${pairs.length}; ` +
  `the newest ${test.length} are holdout data`);
console.log(JSON.stringify({ method: "platt", ...calibration }, null, 2));
print("train", evaluate(train, calibration));
print("later holdout", evaluate(test, calibration));

if (process.argv.includes("--write")) {
  delete model.calibration; // legacy location; predict(model.outside, ...) never reads it
  model.outside.calibration = {
    method: "platt",
    ...calibration,
    fittedOn: train.length,
    validatedOn: test.length,
    fittedAt: new Date().toISOString(),
    note: "fitted on recent corrected-population outcomes; validated on the newest chronological holdout",
  };
  const versionedOutside = {
    ...model.outside,
    calibration: { method: "platt", a: calibration.a, b: calibration.b },
  };
  model.version = createHash("sha256")
    .update(JSON.stringify(versionedOutside))
    .digest("hex")
    .slice(0, 8);
  writeFileSync(MODEL_FILE, JSON.stringify(model, null, 1) + "\n");
  console.log(`wrote calibrated model ${model.version} to ${MODEL_FILE}`);
}
