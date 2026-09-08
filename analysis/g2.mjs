// Migration check: how often do launches we scored highly actually reach a pool?
//
// Walks PoolGraduated events from the earliest block we ever predicted on, then
// compares graduation rates across score bands. Writes graduated.json for the site.
import { createPublicClient, http, parseAbiItem } from "viem";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
const DATA = process.env.DATA_DIR ?? ".";
const LOGS = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 0, timeout: 30000 }) });
const READ = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { retryCount: 2 }) });
const F = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const pg = parseAbiItem("event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)");
const preds = [];
let minBlock = Infinity;
for (const l of readFileSync(join(DATA, "predictions.jsonl"), "utf8").split(String.fromCharCode(10))) {
  if (!l.trim()) continue;
  try { const d = JSON.parse(l); preds.push(d); if (d.block < minBlock) minBlock = d.block; } catch {}
}
const byTok = new Map(preds.map(d => [d.token.toLowerCase(), d]));
const head = await READ.getBlockNumber();
const grads = new Set();
for (let b = BigInt(minBlock); b <= head; b += 5000n) {
  const hi = b + 4999n > head ? head : b + 4999n;
  let logs = null;
  for (let i = 0; i < 4 && !logs; i++) {
    logs = await LOGS.getLogs({ address: F, event: pg, fromBlock: b, toBlock: hi }).catch(() => null);
    if (!logs) await new Promise(r => setTimeout(r, 900*(i+1)));
  }
  if (logs) for (const g of logs) grads.add(g.args.token.toLowerCase());
  await new Promise(r => setTimeout(r, 250));
}
// Only count launches that had time to get there: predictions older than 3 hours.
const cut = Date.now() - 3*3600*1000;
const mature = preds.filter(d => Date.parse(d.t) < cut);
const g = mature.filter(d => grads.has(d.token.toLowerCase()));
console.log(`mature predictions: ${mature.length}, of which graduated: ${g.length}  (${(g.length/mature.length*100).toFixed(2)}%)`);
console.log();
for (const t of [0.5, 0.65, 0.75, 0.85]) {
  const above = mature.filter(d => d.p_outside >= t);
  const hit = above.filter(d => grads.has(d.token.toLowerCase()));
  if (above.length < 30) continue;
  console.log(`  scored >= ${(t*100).toFixed(0)}%:  ${above.length} tokens, graduated ${hit.length}  (${(hit.length/above.length*100).toFixed(2)}%)   x${(hit.length/above.length)/(g.length/mature.length) ? ((hit.length/above.length)/(g.length/mature.length)).toFixed(2) : "-"}`);
}
const below = mature.filter(d => d.p_outside < 0.2);
const bh = below.filter(d => grads.has(d.token.toLowerCase()));
console.log(`  scored <  20%:  ${below.length} tokens, graduated ${bh.length}  (${(bh.length/below.length*100).toFixed(2)}%)`);
// Persist the list for the site to render.
const list = [...grads].map(t => byTok.get(t)).filter(Boolean)
  .map(d => ({ token: d.token, symbol: d.symbol, p: d.p_outside, pg: d.p_graduated, t: d.t }))
  // Newest first, not highest first. The model has a ceiling that many launches
  // reach, so ordering by score filled the published list with one repeated number.
  .sort((a,b) => Date.parse(b.t) - Date.parse(a.t));
const rate = (arr) => arr.filter(d => grads.has(d.token.toLowerCase())).length / Math.max(1, arr.length);
const hiRate = rate(mature.filter(d => d.p_outside >= 0.65));
const loRate = rate(mature.filter(d => d.p_outside < 0.20));
writeFileSync(join(DATA, "graduated.json"), JSON.stringify({
  at: new Date().toISOString(), total: grads.size, ours: list.length,
  // Counted over every migration we scored, not over the published sample, so the
  // page can say what share of them it is showing.
  oursAbove50: list.filter((d) => d.p >= 0.5).length,
  stats: { mature: mature.length, graduated: g.length, base: g.length / mature.length,
           hiRate, loRate, lift: loRate ? hiRate / loRate : null,
           hiN: mature.filter(d => d.p_outside >= 0.65).length },
  list: list.slice(0, 200),   // the page picks a varied handful out of this
}, null, 1));
console.log(`\n-> graduated.json  (${list.length} entries)`);
