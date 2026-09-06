// One-off audit: which of our scored launches later reached a Uniswap pool.
//
// Unlike g2.mjs this prints the individual tokens rather than aggregate bands,
// so a claim about any single graduation can be traced back to its prediction.
import { createPublicClient, http, parseAbiItem } from "viem";
import { readFileSync } from "fs";
import { join } from "path";
const DATA = process.env.DATA_DIR ?? ".";
const LOGS = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 0, timeout: 30000 }) });
const READ = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { retryCount: 2 }) });
const F = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const pg = parseAbiItem("event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)");

const preds = new Map();
let minBlock = Infinity;
for (const l of readFileSync(join(DATA, "predictions.jsonl"), "utf8").split(String.fromCharCode(10))) {
  if (!l.trim()) continue;
  try { const d = JSON.parse(l);
    preds.set(d.token.toLowerCase(), d);
    if (d.block && d.block < minBlock) minBlock = d.block;
  } catch {}
}
const head = await READ.getBlockNumber();
console.log(`predictions ${preds.size}, earliest block ${minBlock}, head ${head}`);

const grads = [];
let from = BigInt(minBlock), bad = 0, done = 0;
const STEP = 5000n;
for (let b = from; b <= head; b += STEP) {
  const hi = b + STEP - 1n > head ? head : b + STEP - 1n;
  let logs = null;
  for (let i = 0; i < 4 && !logs; i++) {
    logs = await LOGS.getLogs({ address: F, event: pg, fromBlock: b, toBlock: hi }).catch(() => null);
    if (!logs) await new Promise(r => setTimeout(r, 900 * (i + 1)));
  }
  if (!logs) { bad++; continue; }
  for (const g of logs) grads.push(g.args.token.toLowerCase());
  if (++done % 25 === 0) process.stdout.write(`\r  ${done} ranges, found ${grads.length}   `);
  await new Promise(r => setTimeout(r, 260));
}
console.log(`\ngraduations in the period: ${grads.length}, ranges that failed to read: ${bad}`);
const ours = grads.filter(t => preds.has(t)).map(t => preds.get(t));
console.log(`of those, ones we scored: ${ours.length}`);
ours.sort((a,b) => b.p_outside - a.p_outside);
console.log();
for (const d of ours.slice(0, 25)) {
  console.log(`  $${String(d.symbol).slice(0,16).padEnd(17)} outside ${(d.p_outside*100).toFixed(1).padStart(5)}%   pool ${(d.p_graduated*100).toFixed(2).padStart(5)}%`);
}
const hi = ours.filter(d => d.p_outside >= 0.5).length;
console.log(`\nof the ones we scored that graduated: ${hi} were put above 50%  (${(hi/Math.max(1,ours.length)*100).toFixed(0)}%)`);
