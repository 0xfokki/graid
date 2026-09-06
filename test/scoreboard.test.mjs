// Tests for the public track record.
//
// Every case here is a bug that actually happened, or the invariant that would
// have caught it. The scoreboard is the one thing readers are asked to trust,
// so a silent error in it is worse than an outage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The module keeps its index in module scope, so each test needs its own copy.
let n = 0;
const freshBoard = () => import(`../src/scoreboard.mjs?case=${n++}`);

const dir = () => mkdtempSync(join(tmpdir(), "graid-test-"));
const pred = (token, p, extra = {}) => JSON.stringify({
  token, p_outside: p, t: "2026-01-01T00:00:00.000Z", modelVersion: "test", symbol: "T", ...extra,
}) + "\n";
const res = (token, event) => JSON.stringify({
  token, event, outsideSharePct: event ? 30 : 0, t: "2026-01-01T02:00:00.000Z",
}) + "\n";

test("the top decile is ranked by probability alone, never by the outcome", async () => {
  // The regression: sorting by the whole record let resolved-true rows float to
  // the top among equal probabilities, which inflated the published hit rate.
  // Here the thirty highest scores are all tied at 0.9. The losers are written
  // first, so a probability-only sort keeps them at the front of the tie and the
  // top decile must come out empty. Any sort that consults the label scores 1.0.
  const board = await freshBoard();
  const d = dir();
  const P = join(d, "p.jsonl"), R = join(d, "r.jsonl");
  let p = "", r = "";
  for (let i = 0; i < 15; i++) { p += pred(`0xlose${i}`, 0.9); r += res(`0xlose${i}`, false); }
  for (let i = 0; i < 15; i++) { p += pred(`0xwin${i}`, 0.9);  r += res(`0xwin${i}`, true); }
  for (let i = 0; i < 120; i++) { p += pred(`0xlow${i}`, 0.1); r += res(`0xlow${i}`, i % 4 === 0); }
  writeFileSync(P, p); writeFileSync(R, r);

  board.refresh(P, R);
  const top = board.topDecile(0.1);
  assert.equal(top.n, 15, "a tenth of 150 records is 15");
  assert.equal(top.hitRate, 0,
    `the label leaked into the ranking: hit rate came out ${top.hitRate}`);
});

test("reading incrementally gives the same answer as reading the file once", async () => {
  const stepwise = await freshBoard();
  const oneShot = await freshBoard();
  const d = dir();
  const P = join(d, "p.jsonl"), R = join(d, "r.jsonl");

  const first = pred("0xa", 0.8) + pred("0xb", 0.2);
  const firstRes = res("0xa", true) + res("0xb", false);
  writeFileSync(P, first); writeFileSync(R, firstRes);
  stepwise.refresh(P, R);                    // read the first half

  appendFileSync(P, pred("0xc", 0.6) + pred("0xd", 0.4));
  appendFileSync(R, res("0xc", true) + res("0xd", false));
  stepwise.refresh(P, R);                    // read only the new bytes

  oneShot.refresh(P, R);                     // read everything at once

  const a = stepwise.compute(0.3), b = oneShot.compute(0.3);
  assert.equal(a.resolved, 4);
  assert.deepEqual(
    { made: a.made, resolved: a.resolved, brier: a.brier, auc: a.auc, eventRate: a.eventRate },
    { made: b.made, resolved: b.resolved, brier: b.brier, auc: b.auc, eventRate: b.eventRate },
  );
});

test("a half-written final line is not counted until it is complete", async () => {
  // The writer appends; a reader can arrive mid-line. Counting that line twice,
  // or parsing half of it, would corrupt the record permanently.
  const board = await freshBoard();
  const d = dir();
  const P = join(d, "p.jsonl"), R = join(d, "r.jsonl");
  writeFileSync(P, pred("0xa", 0.8)); writeFileSync(R, res("0xa", true));
  board.refresh(P, R);
  assert.equal(board.compute(0.3).made, 1);

  const whole = pred("0xb", 0.5);
  appendFileSync(P, whole.slice(0, 20));     // torn write
  board.refresh(P, R);
  assert.equal(board.compute(0.3).made, 1, "an incomplete line must not be parsed");

  appendFileSync(P, whole.slice(20));        // the rest arrives
  board.refresh(P, R);
  assert.equal(board.compute(0.3).made, 2, "the completed line must be counted exactly once");
});

test("AUC is 1 for a perfect ranking and 0 for an inverted one", async () => {
  const good = await freshBoard(), bad = await freshBoard();
  const d = dir();
  const P = join(d, "p.jsonl"), R = join(d, "r.jsonl");
  const P2 = join(d, "p2.jsonl"), R2 = join(d, "r2.jsonl");
  let p = "", r = "", p2 = "";
  for (let i = 0; i < 50; i++) {
    const hit = i < 25;
    p  += pred(`0x${i}`, hit ? 0.9 : 0.1);   // right way round
    p2 += pred(`0x${i}`, hit ? 0.1 : 0.9);   // exactly backwards
    r  += res(`0x${i}`, hit);
  }
  writeFileSync(P, p); writeFileSync(R, r);
  writeFileSync(P2, p2); writeFileSync(R2, r);
  good.refresh(P, R); bad.refresh(P2, R2);
  assert.equal(good.compute(0.5).auc, 1);
  assert.equal(bad.compute(0.5).auc, 0);
});

test("a shrinking file is re-read from the start rather than skipped", async () => {
  // If the log is ever replaced instead of appended to, the offset would point
  // past the end and the board would silently stop updating.
  const board = await freshBoard();
  const d = dir();
  const P = join(d, "p.jsonl"), R = join(d, "r.jsonl");
  writeFileSync(P, pred("0xa", 0.8) + pred("0xb", 0.2) + pred("0xc", 0.5));
  writeFileSync(R, res("0xa", true));
  board.refresh(P, R);
  assert.equal(board.compute(0.3).made, 3);

  writeFileSync(P, pred("0xz", 0.7));        // replaced with a shorter file
  board.refresh(P, R);
  assert.ok(board.compute(0.3).made >= 1, "the replacement file must be read");
});
