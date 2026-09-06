// Collector v2. Three differences from v1:
//   1. Fixed observation window: observe every launch for exactly OBS_HOURS.
//      The same window for all prevents newer launches from looking systematically worse.
//   2. Count OUTSIDE money: buys outside the launch transaction, not from the deployer
//      or exempt wallets. Creator buys move the curve themselves, so in v1 the creator
//      buy feature partly predicted itself.
//   3. Store raw values rather than a precomputed label. Choose the event threshold later.
import { createPublicClient, http, parseAbi, parseAbiItem, decodeFunctionData, parseEventLogs } from "viem";
import { writeFileSync } from "fs";

const LOGS = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 0, timeout: 30000 }) });
const READ = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { retryCount: 2, timeout: 25000 }) });

const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const ZERO = "0x0000000000000000000000000000000000000000";
const SUPPLY = 1000000000n * 10n ** 18n;

const HOURS_BACK = Number(process.env.HOURS_BACK ?? 14);   // Sample lookback.
const WANT       = Number(process.env.WANT ?? 600);        // Number of launches to collect.
const OBS_HOURS  = Number(process.env.OBS_HOURS ?? 2);     // Observation window per launch.
const ADDR_CHUNK = 120;                                    // Addresses per log filter.
const RANGE      = 2000n;                                  // Blocks per eth_getLogs request.

const evTokenLaunched = parseAbiItem("event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)");
const evCurveBuy  = parseAbiItem("event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)");
const evCurveSell = parseAbiItem("event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)");

const factoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);
const tokenAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)",
  "function name() view returns (string)", "function symbol() view returns (string)",
]);
const routerAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tryHard(fn, tries = 7, wait = 1400) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { if (i === tries - 1) throw e; await sleep(wait * (i + 1)); }
  }
}

// --- 0. Window geometry -------------------------------------------------------
const head = await READ.getBlockNumber();
const [bNow, bOld] = await Promise.all([READ.getBlock({ blockNumber: head }), READ.getBlock({ blockNumber: head - 100000n })]);
const secPerBlock = (Number(bNow.timestamp) - Number(bOld.timestamp)) / 100000;
const obsBlocks = BigInt(Math.round((OBS_HOURS * 3600) / secPerBlock));
const from = head - BigInt(Math.round((HOURS_BACK * 3600) / secPerBlock));
console.log(`block ${(secPerBlock * 1000).toFixed(0)} ms · sample starts at ${from} · observation ${OBS_HOURS}h = ${obsBlocks} blocks`);

// --- 1. Launches ---------------------------------------------------------------
const launches = [];
for (let b = from; launches.length < WANT && b < from + 300000n; b += RANGE) {
  const logs = await tryHard(() => LOGS.getLogs({ address: FACTORY, event: evTokenLaunched, fromBlock: b, toBlock: b + RANGE - 1n }));
  for (const l of logs) {
    if (launches.length >= WANT) break;
    launches.push({
      token: l.args.token, curve: l.args.curve, deployer: l.args.deployer,
      pairToken: l.args.pairToken, threshold: l.args.graduationThreshold,
      block: l.blockNumber, tx: l.transactionHash,
    });
  }
  process.stdout.write(`\rlaunches: ${launches.length}   `);
  await sleep(430);
}
const firstBlock = launches[0].block, lastBlock = launches[launches.length - 1].block;
console.log(`\n${launches.length} launches, blocks ${firstBlock}..${lastBlock} (${Number(lastBlock - firstBlock) * secPerBlock / 60 | 0} min)`);
if (lastBlock + obsBlocks > head) console.log(`WARNING: the observation window is still open for later launches`);

// --- 2. Static features for each launch ---------------------------------------
console.log("reading features...");
const byCurve = new Map();
const rows = [];
let done = 0;
const queue = [...launches];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const L = queue.shift();
    const r = {
      token: L.token, curve: L.curve, deployer: L.deployer, pairToken: L.pairToken,
      block: Number(L.block), tx: L.tx, isEthPair: L.pairToken === ZERO,
      threshold: String(L.threshold),
    };
    try {
      const rec = await tryHard(() => READ.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getLaunchedToken", args: [L.token] }));
      r.phase = Number(rec.phase);
      r.graduated = r.phase === 2;
      r.creatorTaxBps = Number(rec.creatorTaxBps);
      r.feeToThirdParty = rec.creatorFeeRecipient.toLowerCase() !== rec.deployer.toLowerCase();

      const [name, symbol] = await Promise.all([
        READ.readContract({ address: L.token, abi: tokenAbi, functionName: "name" }).catch(() => "?"),
        READ.readContract({ address: L.token, abi: tokenAbi, functionName: "symbol" }).catch(() => "?"),
      ]);
      r.name = name; r.symbol = symbol;

      const info = await READ.readContract({ address: L.token, abi: tokenAbi, functionName: "getTokenInfo" }).catch(() => null);
      r.hasSocials = info ? Boolean(info[3].twitter || info[3].telegram || info[3].website || info[3].discord || info[3].farcaster) : null;
      r.socialCount = info ? [info[3].twitter, info[3].telegram, info[3].website, info[3].discord, info[3].farcaster].filter(Boolean).length : null;
      r.descLen = info ? String(info[2] ?? "").trim().length : null;

      const receipt = await tryHard(() => READ.getTransactionReceipt({ hash: L.tx }));
      const buys = parseEventLogs({ abi: [evCurveBuy], logs: receipt.logs, eventName: "CurveBuy" });
      r.devBuyPct = (Number(buys.reduce((a, b) => a + b.args.tokensOut, 0n)) / Number(SUPPLY)) * 100;
      r.devQuoteIn = String(buys.reduce((a, b) => a + b.args.quoteIn, 0n));

      const tx = await tryHard(() => READ.getTransaction({ hash: L.tx }));
      try { r.exempt = decodeFunctionData({ abi: routerAbi, data: tx.input }).args[6].map((a) => a.toLowerCase()); }
      catch { r.exempt = null; }

      byCurve.set(L.curve.toLowerCase(), r);
      rows.push(r);
    } catch (e) {
      r.error = e.shortMessage ?? e.message;
      rows.push(r);
    }
    if (++done % 25 === 0) process.stdout.write(`\r  ${done}/${launches.length}   `);
  }
}));
console.log(`\nprocessed ${rows.filter((r) => !r.error).length}/${rows.length}`);

// --- 3. Curve activity during the observation window --------------------------
// Filter logs by our curve addresses to avoid receiving the entire network.
for (const r of rows) {
  r.buysTotal = 0; r.outsideBuys = 0; r.outsideQuoteIn = 0n; r.outsideBuyers = new Set();
  r.sellCount = 0; r.quoteOut = 0n; r.devSellCount = 0; r.devSellQuote = 0n; r.firstOutsideBlock = null;
}
let failedRanges = 0, okRanges = 0;
const curves = rows.filter((r) => !r.error).map((r) => r.curve);
const obsFrom = firstBlock, obsTo = lastBlock + obsBlocks > head ? head : lastBlock + obsBlocks;
const chunks = [];
for (let i = 0; i < curves.length; i += ADDR_CHUNK) chunks.push(curves.slice(i, i + ADDR_CHUNK));
const totalCalls = chunks.length * Number((obsTo - obsFrom) / RANGE + 1n);
console.log(`activity: blocks ${obsFrom}..${obsTo}, ${chunks.length} address groups, about ${totalCalls} requests`);

let call = 0;
for (const chunk of chunks) {
  for (let b = obsFrom; b <= obsTo; b += RANGE) {
    const hi = b + RANGE - 1n > obsTo ? obsTo : b + RANGE - 1n;
    let logs = null;
    try { logs = await tryHard(() => LOGS.getLogs({ address: chunk, events: [evCurveBuy, evCurveSell], fromBlock: b, toBlock: hi }), 8, 2000); okRanges++; }
    catch { failedRanges++; process.stdout.write("!"); continue; }
    for (const l of logs) {
      const r = byCurve.get(l.address.toLowerCase());
      if (!r) continue;
      // Observation window for this specific launch.
      if (l.blockNumber < BigInt(r.block) || l.blockNumber > BigInt(r.block) + obsBlocks) continue;
      const dep0 = r.deployer.toLowerCase();
      if (l.eventName === "CurveSell") {
        r.sellCount++; r.quoteOut += l.args.quoteOut;
        // Count only a sale by the creator as a creator dump.
        const seller = l.args.seller.toLowerCase(), sRecip = l.args.recipient.toLowerCase();
        if (seller === dep0 || sRecip === dep0 || (r.exempt && (r.exempt.includes(seller) || r.exempt.includes(sRecip)))) {
          r.devSellCount++; r.devSellQuote += l.args.quoteOut;
        }
        continue;
      }
      r.buysTotal++;
      if (l.transactionHash === r.tx) continue;                       // A buy in the launch transaction is not outside money.
      const buyer = l.args.buyer.toLowerCase(), recip = l.args.recipient.toLowerCase();
      const dep = r.deployer.toLowerCase();
      if (buyer === dep || recip === dep) continue;
      if (r.exempt && (r.exempt.includes(buyer) || r.exempt.includes(recip))) continue;
      r.outsideBuys++;
      r.outsideQuoteIn += l.args.quoteIn;
      r.outsideBuyers.add(buyer);
      if (r.firstOutsideBlock === null) r.firstOutsideBlock = Number(l.blockNumber);
    }
    if (++call % 10 === 0) process.stdout.write(`\r  ${call}/${totalCalls}   `);
    await sleep(410);
  }
}

// --- 4. Derived values --------------------------------------------------------
const { Counter } = { Counter: null };
const depCount = new Map();
for (const r of rows) depCount.set(r.deployer.toLowerCase(), (depCount.get(r.deployer.toLowerCase()) ?? 0) + 1);
const nameCount = new Map();
for (const r of rows) { const k = String(r.symbol ?? "").toLowerCase(); nameCount.set(k, (nameCount.get(k) ?? 0) + 1); }

for (const r of rows) {
  const thr = Number(r.threshold) || 1;
  r.outsideSharePct = (Number(r.outsideQuoteIn) / thr) * 100;
  r.outsideBuyerCount = r.outsideBuyers.size;
  r.firstOutsideSec = r.firstOutsideBlock === null ? null : (r.firstOutsideBlock - r.block) * secPerBlock;
  r.devSharePctOfThreshold = (Number(r.devQuoteIn ?? 0) / thr) * 100;
  r.devDumped = r.devBuyPct > 1 && r.devSellCount > 0;
  r.devSellQuote = String(r.devSellQuote);
  r.deployerLaunches = depCount.get(r.deployer.toLowerCase()) ?? 1;
  r.symbolClones = nameCount.get(String(r.symbol ?? "").toLowerCase()) ?? 1;
  delete r.outsideBuyers;
  r.outsideQuoteIn = String(r.outsideQuoteIn);
  r.quoteOut = String(r.quoteOut);
}

const ok = rows.filter((r) => !r.error);
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * p)] ?? 0; };
const shares = ok.map((r) => r.outsideSharePct);
console.log(`\n\n=== OUTSIDE MONEY (share of migration threshold) ===`);
console.log(`  any arrived (>0):          ${ok.filter((r) => r.outsideBuys > 0).length} / ${ok.length}  (${(ok.filter((r) => r.outsideBuys > 0).length / ok.length * 100).toFixed(1)}%)`);
for (const t of [0.5, 1, 5, 10, 25]) {
  const n = ok.filter((r) => r.outsideSharePct >= t).length;
  console.log(`  reached ${String(t).padStart(4)}% threshold: ${String(n).padStart(4)}  (${(n / ok.length * 100).toFixed(1)}%)`);
}
console.log(`  median share: ${q(shares, 0.5).toFixed(3)}%   p90: ${q(shares, 0.9).toFixed(2)}%`);
console.log(`  migrated: ${ok.filter((r) => r.graduated).length}`);
console.log(`  creator dumped (sale from creator address): ${ok.filter((r) => r.devDumped).length}`);
console.log(`  activity log completeness: ${okRanges}/${okRanges + failedRanges} ranges` + (failedRanges ? `  — ${failedRanges} UNREAD, data incomplete` : ""));
console.log(`  exempt lists known for ${ok.filter((r) => r.exempt !== null).length}`);

writeFileSync(process.env.OUT ?? "launches2.json", JSON.stringify(rows, (k, v) => (typeof v === "bigint" ? String(v) : v), 2));
console.log("→ " + (process.env.OUT ?? "launches2.json"));
