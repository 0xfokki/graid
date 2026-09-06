// Flags are facts about a token, not moral judgments.
//
// It is tempting to color them as "red = bad," but bad for what? Our event is
// whether outside money arrives, and the data says serial deployers and bundles
// increase that probability. Coloring them red would contradict the measurements.
//
// Color therefore represents the measured direction for our event, accompanied by
// the observed rate. Model-independent risks, such as a creator who already exited,
// are marked separately.

const pctOf = (m, key, bucket) => m?.features?.[key]?.groups?.[bucket]?.rateRaw ?? null;

/**
 * @param r token row (see chain.readToken plus repetition/clone counts from the server)
 * @param m outside model (used for the "rate in this group" annotation)
 * @returns array of {code, text, note, dir}; dir: up | down | warn | flat
 */
export function flags(r, m) {
  const out = [];
  const base = m?.base ?? null;
  const add = (code, text, dir, rate) =>
    out.push({ code, text, dir, note: rate == null ? null : `${(rate * 100).toFixed(0)}% vs ${(base * 100).toFixed(0)}% typical` });

  // --- risk independent of the model -------------------------------------------
  if (r.devDumped) add("DUMPED", "CREATOR SOLD OUT", "warn", null);

  // --- facts with a measured direction ------------------------------------------
  const d = r.devBuyPct;
  if (d != null) {
    if (d >= 10) add("DEVBUY", `CREATOR IN ${d.toFixed(0)}%`, "up", pctOf(m, "devBuy", "over 10%"));
    else if (d >= 6) add("DEVBUY", `CREATOR IN ${d.toFixed(1)}%`, "up", pctOf(m, "devBuy", "6–10%"));
    else if (d < 1) add("DEVBUY", "NO SKIN IN GAME", "down", pctOf(m, "devBuy", d < 0.05 ? "none" : "under 1%"));
  }

  const n = r.deployerLaunches;
  if (n != null && n >= 5) add("SERIAL", `SERIAL DEPLOYER ×${n}`, "up", pctOf(m, "serial", "5 or more"));
  else if (n != null && n >= 2) add("SERIAL", `DEPLOYER ×${n}`, "flat", pctOf(m, "serial", "2–4"));

  // exemptWallets == null means "could not read," not "none."
  // Add the flag only when the list is actually known.
  const e = r.exemptWallets;
  if (e != null && e >= 3) add("BUNDLE", `BUNDLE ×${e}`, "up", pctOf(m, "exempt", "3 or more"));
  else if (e === 0) add("BUNDLE", "NO BUNDLE", "down", pctOf(m, "exempt", "none"));

  if (r.hasSocials === false) add("SOCIAL", "NO SOCIALS", "down", pctOf(m, "socials", "no"));

  const t = r.creatorTaxBps;
  if (t > 300) add("FEE", `CREATOR FEE ${(t / 100).toFixed(1)}%`, "down", pctOf(m, "tax", "over 3%"));
  else if (t === 0) add("FEE", "NO CREATOR FEE", "up", pctOf(m, "tax", "zero"));

  if (r.feeToThirdParty) add("KOL", "FEES TO THIRD PARTY", "up", pctOf(m, "thirdParty", "yes"));

  if (r.symbolClones != null && r.symbolClones >= 2) add("CLONE", `TICKER ×${r.symbolClones}`, "flat", null);

  if (!r.isEthPair) add("PAIR", "STOCK PAIR", "up", pctOf(m, "pair", "stock"));

  // --- events that already happened ---------------------------------------------
  if (r.phase === 2) add("POOL", "REACHED POOL", "up", null);
  if (r.outsideBuyerCount != null && r.outsideBuyerCount > 0)
    add("OUTSIDE", `${r.outsideBuyerCount} OUTSIDE BUYERS`, "up", null);

  return out;
}

/** HUD line: "$TICK · FLAG · FLAG · FLAG" */
export function flagLine(sym, fl, max = 4) {
  return [`$${sym}`, ...fl.slice(0, max).map((f) => f.text)].join(" · ");
}
