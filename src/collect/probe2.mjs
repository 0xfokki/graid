import { createPublicClient, http, toEventSelector } from "viem";
import { readFileSync } from "fs";
const READ = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { retryCount: 2, timeout: 25000 }) });
const rows = [];
for (const f of ["w14.json","w12.json","w10.json","w8.json"]) for (const r of JSON.parse(readFileSync(f,"utf8"))) if(!r.error) rows.push(r);

const known = {
  [toEventSelector("TokenLaunched(address,address,address,address,uint256,uint256)")]: "TokenLaunched",
  [toEventSelector("CurveBuy(address,address,uint256,uint256,uint256,uint256)")]: "CurveBuy",
  [toEventSelector("Transfer(address,address,uint256)")]: "Transfer",
  [toEventSelector("Approval(address,address,uint256)")]: "Approval",
};
// Candidates for "declared exempt."
for (const sig of ["SnipeTaxExemptSet(address,bool)","SnipeTaxExempt(address)","ExemptSet(address,bool)","SnipeTaxExemptionAdded(address)"])
  known[toEventSelector(sig)] = sig;

const withEx = rows.filter(r => Array.isArray(r.exempt) && r.exempt.length >= 2)[0];
const noEx   = rows.filter(r => r.exempt === null || r.exempt === undefined)[0];

for (const [label, r] of [["WITH DECLARED exempt (" + (r0=>r0)(withEx?.exempt?.length) + ")", withEx], ["WITHOUT DECODE", noEx]]) {
  if (!r) continue;
  console.log(`\n===== ${label} =====  ${r.symbol}  ${r.tx.slice(0,14)}…`);
  const rc = await READ.getTransactionReceipt({ hash: r.tx });
  const seen = new Map();
  for (const l of rc.logs) {
    const name = known[l.topics[0]] ?? l.topics[0].slice(0, 12) + "…";
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  for (const [k,v] of seen) console.log(`   ${k}  ×${v}`);
  // Find tax=0 buys inside the launch transaction.
  const buyTopic = toEventSelector("CurveBuy(address,address,uint256,uint256,uint256,uint256)");
  const buys = rc.logs.filter(l => l.topics[0] === buyTopic);
  console.log(`   buys in launch transaction: ${buys.length}`);
}
