import { createPublicClient, http, parseAbiItem, parseEventLogs } from "viem";
import { readFileSync } from "fs";
const LOGS = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 0, timeout: 30000 }) });
const evBuy = parseAbiItem("event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)");

const rows = [];
for (const f of ["w14.json","w12.json","w10.json","w8.json"]) for (const r of JSON.parse(readFileSync(f,"utf8"))) if(!r.error) rows.push(r);

// Use launches with KNOWN exempt lists to compare the heuristic with ground truth.
const known = rows.filter(r => Array.isArray(r.exempt) && r.exempt.length > 0).slice(0, 8);
console.log(`testing ${known.length} launches with known exempt lists\n`);

let hit = 0, miss = 0, falsePos = 0;
for (const r of known) {
  // First three seconds, approximately 30 blocks.
  let logs = null;
  for (let i = 0; i < 4 && !logs; i++) {
    logs = await LOGS.getLogs({ address: r.curve, event: evBuy, fromBlock: BigInt(r.block), toBlock: BigInt(r.block) + 8n }).catch(() => null);
    if (!logs) await new Promise(s => setTimeout(s, 1200));
  }
  if (!logs) { console.log(`  ${r.symbol}: logs could not be fully read`); continue; }
  const truth = new Set(r.exempt.map(a => a.toLowerCase()));
  const guessed = new Set();
  const lines = [];
  for (const l of logs) {
    if (l.transactionHash === r.tx) continue;                 // Creator buy.
    const q = Number(l.args.quoteIn), t = Number(l.args.tax);
    if (!q) continue;
    const ratio = t / q;
    const buyer = l.args.buyer.toLowerCase();
    if (ratio < 0.20) guessed.add(buyer);                      // Low tax implies exempt.
    lines.push(`      ${buyer.slice(0,10)}… tax ${(ratio*100).toFixed(1)}%  ${truth.has(buyer)?"(listed)":""}`);
  }
  const g = [...guessed], correct = g.filter(a => truth.has(a)).length;
  hit += correct; falsePos += g.length - correct;
  miss += [...truth].filter(a => !guessed.has(a)).length;
  console.log(`  ${String(r.symbol).slice(0,12).padEnd(13)} declared ${truth.size}, window buys ${logs.length}, correct ${correct}, false positives ${g.length-correct}`);
  if (lines.length && lines.length < 7) lines.forEach(l => console.log(l));
  await new Promise(s => setTimeout(s, 450));
}
console.log(`\nTOTAL: matched ${hit}, missed ${miss}, false positives ${falsePos}`);
