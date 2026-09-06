// Build a training sample of N launches from HOURS_BACK, including features and outcomes.
// Track two outcomes:
//   traction  — the token moved off zero on the curve (event, about 15%)
//   graduated — the token reached a pool (rare, about 2.5%)
import { createPublicClient, http, parseAbi, parseAbiItem, decodeFunctionData, parseEventLogs } from "viem";
import { writeFileSync } from "fs";

const LOGS = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 0, timeout: 25000 }) });
const READ = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { retryCount: 2, timeout: 25000 }) });

const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const ZERO = "0x0000000000000000000000000000000000000000";
const SUPPLY = 1000000000n * 10n ** 18n;
const HOURS_BACK = Number(process.env.HOURS_BACK ?? 12);
const WANT = Number(process.env.WANT ?? 400);
const POOL = 6;

const evTokenLaunched = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
);
const evCurveBuy = parseAbiItem(
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
);

const factoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);
const curveAbi = parseAbi([
  "function realQuoteReserve() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function launchedAt() view returns (uint256)",
]);
const tokenAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const routerAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tryHard(fn, tries = 6, wait = 1500) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { if (i === tries - 1) throw e; await sleep(wait * (i + 1)); }
  }
}

const head = await READ.getBlockNumber();
const [bNow, bOld] = await Promise.all([READ.getBlock({ blockNumber: head }), READ.getBlock({ blockNumber: head - 100000n })]);
const secPerBlock = (Number(bNow.timestamp) - Number(bOld.timestamp)) / 100000;
const from = head - BigInt(Math.round((HOURS_BACK * 3600) / secPerBlock));
console.log(`head ${head}, block ${(secPerBlock * 1000).toFixed(0)} ms, starting at ${from}`);

const launches = [];
for (let b = from; launches.length < WANT && b < from + 200000n; b += 2000n) {
  const logs = await tryHard(() => LOGS.getLogs({ address: FACTORY, event: evTokenLaunched, fromBlock: b, toBlock: b + 1999n }));
  for (const l of logs) {
    if (launches.length >= WANT) break;
    launches.push({ token: l.args.token, curve: l.args.curve, deployer: l.args.deployer, pairToken: l.args.pairToken, block: Number(l.blockNumber), tx: l.transactionHash });
  }
  process.stdout.write(`\rlaunches collected: ${launches.length}   `);
  await sleep(420);
}
console.log(`\n${launches.length} total, enriching...`);

async function enrich(L) {
  const r = { ...L };
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
  r.hasDescription = info ? String(info[2] ?? "").trim().length > 10 : null;

  const [real, thr] = await Promise.all([
    READ.readContract({ address: L.curve, abi: curveAbi, functionName: "realQuoteReserve" }).catch(() => 0n),
    READ.readContract({ address: L.curve, abi: curveAbi, functionName: "graduationThreshold" }).catch(() => 0n),
  ]);
  r.progressPct = thr > 0n ? (Number(real) / Number(thr)) * 100 : 0;
  // Event: the token moved off zero or already reached a pool.
  r.traction = r.progressPct > 0.05 || r.phase >= 1;

  const receipt = await tryHard(() => READ.getTransactionReceipt({ hash: L.tx }));
  const buys = parseEventLogs({ abi: [evCurveBuy], logs: receipt.logs, eventName: "CurveBuy" });
  r.devBuyPct = (Number(buys.reduce((a, b) => a + b.args.tokensOut, 0n)) / Number(SUPPLY)) * 100;

  const tx = await tryHard(() => READ.getTransaction({ hash: L.tx }));
  try { r.exemptWallets = decodeFunctionData({ abi: routerAbi, data: tx.input }).args[6].length; }
  catch { r.exemptWallets = null; }

  r.isEthPair = L.pairToken === ZERO;
  return r;
}

const rows = [];
let done = 0;
const queue = [...launches];
await Promise.all(Array.from({ length: POOL }, async () => {
  while (queue.length) {
    const L = queue.shift();
    try { rows.push(await enrich(L)); } catch (e) { rows.push({ ...L, error: e.shortMessage ?? e.message }); }
    done++;
    if (done % 10 === 0) process.stdout.write(`\renriched ${done}/${launches.length}   `);
  }
}));

const ok = rows.filter((r) => !r.error);
console.log(`\n\nprocessed ${ok.length}/${rows.length}`);
console.log(`traction (moved off zero): ${ok.filter((r) => r.traction).length}  (${(ok.filter((r) => r.traction).length / ok.length * 100).toFixed(1)}%)`);
console.log(`migrated: ${ok.filter((r) => r.graduated).length}  (${(ok.filter((r) => r.graduated).length / ok.length * 100).toFixed(2)}%)`);
console.log(`exempt data available for ${ok.filter((r) => r.exemptWallets !== null).length}`);
writeFileSync("launches.json", JSON.stringify(rows, (k, v) => (typeof v === "bigint" ? String(v) : v), 2));
console.log("→ launches.json");
