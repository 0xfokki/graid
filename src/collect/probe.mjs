import { createPublicClient, http } from "viem";
import { readFileSync } from "fs";
const READ = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { retryCount: 2, timeout: 25000 }) });
const rows = [];
for (const f of ["w14.json","w12.json","w10.json","w8.json"]) for (const r of JSON.parse(readFileSync(f,"utf8"))) if(!r.error) rows.push(r);
const bad = rows.filter(r => r.exempt === null || r.exempt === undefined);
console.log(`failed to decode: ${bad.length} out of ${rows.length}`);
const sel = new Map(), toAddr = new Map();
for (const r of bad.slice(0, 40)) {
  try {
    const tx = await READ.getTransaction({ hash: r.tx });
    const s = tx.input.slice(0, 10);
    sel.set(s, (sel.get(s) ?? 0) + 1);
    toAddr.set(tx.to.toLowerCase(), (toAddr.get(tx.to.toLowerCase()) ?? 0) + 1);
  } catch {}
  await new Promise(r => setTimeout(r, 90));
}
console.log("\nselectors:"); for (const [k,v] of [...sel].sort((a,b)=>b[1]-a[1])) console.log(`  ${k}  ×${v}`);
console.log("\ntransaction destinations:"); for (const [k,v] of [...toAddr].sort((a,b)=>b[1]-a[1])) console.log(`  ${k}  ×${v}`);
// Successful decodes for comparison.
const good = rows.filter(r => Array.isArray(r.exempt)).slice(0, 15);
const gsel = new Map(), gto = new Map();
for (const r of good) {
  try { const tx = await READ.getTransaction({ hash: r.tx }); gsel.set(tx.input.slice(0,10), (gsel.get(tx.input.slice(0,10))??0)+1); gto.set(tx.to.toLowerCase(),(gto.get(tx.to.toLowerCase())??0)+1); } catch {}
  await new Promise(r => setTimeout(r, 90));
}
console.log("\n--- successfully decoded, for comparison ---");
console.log("selectors:"); for (const [k,v] of gsel) console.log(`  ${k}  ×${v}`);
console.log("addresses:"); for (const [k,v] of gto)  console.log(`  ${k}  ×${v}`);
