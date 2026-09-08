// Tests for the scoring model.
//
// These cover invariants we actually got wrong at some point, not arithmetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fit, predict, BUCKETS, NO_DATA } from "../src/model.mjs";

// A row the bucket functions can read. Every field is present so that
// omitting one in a test is a deliberate signal of "not known".
const row = (over = {}) => ({
  devBuyPct: 2, deployerLaunches: 1, exemptWallets: 0, hasSocials: true,
  creatorTaxBps: 0, feeToThirdParty: false, isEthPair: true, ...over,
});

// A sample where the event correlates with the creator buy, so weights are non-zero.
function sample(n = 400) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const heavy = i % 2 === 0;
    rows.push(row({
      devBuyPct: heavy ? 8 : 0,
      // The heavy-buy half draws the event three times out of four.
      __event: heavy ? i % 4 !== 1 : i % 4 === 1,
    }));
  }
  return rows;
}
const isEvent = (r) => r.__event === true;

test("missing data carries zero weight, so it cannot move the prediction", () => {
  const m = fit(sample(), isEvent);
  for (const [key] of Object.entries(BUCKETS)) {
    const g = m.features[key].groups[NO_DATA];
    if (g) assert.equal(g.weight, 0, `${key}: NO_DATA must weigh nothing`);
  }
});

test("a row with nothing known scores exactly the base rate", () => {
  const m = fit(sample(), isEvent);
  const { p, parts } = predict(m, {});          // every bucket resolves to NO_DATA
  assert.ok(Math.abs(p - m.base) < 1e-9, `expected the base rate ${m.base}, got ${p}`);
  assert.equal(parts.length, 0, "unknown features must not be shown as evidence");
});

test("evidence moves the score in the direction the data supports", () => {
  const m = fit(sample(), isEvent);
  const heavy = predict(m, row({ devBuyPct: 8 })).p;
  const none = predict(m, row({ devBuyPct: 0 })).p;
  assert.ok(heavy > none, `a heavier creator buy should score higher: ${heavy} vs ${none}`);
});

test("calibration is applied and is monotone", () => {
  const m = fit(sample(), isEvent);
  const raw = predict(m, row({ devBuyPct: 8 })).p;
  const calibrated = predict({ ...m, calibration: { a: 0.5378, b: -0.2175 } },
                             row({ devBuyPct: 8 })).p;
  assert.notEqual(raw, calibrated, "calibration coefficients must actually be used");

  // Shrinking towards the middle must preserve the ordering of any two scores.
  const cal = { a: 0.5378, b: -0.2175 };
  const a = predict({ ...m, calibration: cal }, row({ devBuyPct: 8 })).p;
  const b = predict({ ...m, calibration: cal }, row({ devBuyPct: 0 })).p;
  assert.ok(a > b, "calibration must not reorder predictions");
});

test("probabilities stay strictly inside (0, 1)", () => {
  const m = fit(sample(), isEvent);
  for (const r of [row(), row({ devBuyPct: 100 }), row({ devBuyPct: 0 }), {}]) {
    const { p } = predict({ ...m, calibration: { a: 0.5378, b: -0.2175 } }, r);
    assert.ok(p > 0 && p < 1, `probability out of range: ${p}`);
    assert.ok(Number.isFinite(p), `probability not finite: ${p}`);
  }
});

test("the shipped outside model carries calibration on the object the server scores", () => {
  const shipped = JSON.parse(readFileSync(new URL("../src/model.json", import.meta.url), "utf8"));
  assert.ok(shipped.outside.calibration, "model.outside.calibration is missing");
  assert.equal(shipped.calibration, undefined,
    "a top-level calibration is ignored because the server passes model.outside to predict()");

  const calibrated = predict(shipped.outside, row()).p;
  const rawModel = { ...shipped.outside };
  delete rawModel.calibration;
  const raw = predict(rawModel, row()).p;
  assert.notEqual(calibrated, raw, "the production scoring path must apply calibration");
});
