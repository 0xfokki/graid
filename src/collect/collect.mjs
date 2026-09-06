import { createPublicClient, http, parseAbi, parseAbiItem, decodeFunctionData, parseEventLogs } from "viem";
import { writeFileSync } from "fs";

// Logs use the official RPC because publicnode does not support eth_getLogs. Strict limits require pauses.
const LOGS = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 0, timeout: 25000 }) });
// Regular reads use publicnode because it is faster and has more generous limits.
const READ = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { retryCount: 2, timeout: 25000 }) });

const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const ZERO = "0x0000000000000000000000000000000000000000";
const SUPPLY = 1000000000n * 10n ** 18n;
const HOURS_BACK = Number(process.env.HOURS_BACK ?? 12);
const WANT = Number(process.env.WANT ?? 20);

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

const PHASE = ["curve", "swept", "POOL", "rescued"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryHard(fn, tries = 6, wait = 1500) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(wait * (i + 1));
    }
  }
}

// --- 1. Convert "N hours ago" to a block number -------------------------------
const head = await READ.getBlockNumber();
const [bNow, bOld] = await Promise.all([
  READ.getBlock({ blockNumber: head }),
  READ.getBlock({ blockNumber: head - 100000n }),
]);
const secPerBlock = (Number(bNow.timestamp) - Number(bOld.timestamp)) / 100000;
const from = head - BigInt(Math.round((HOURS_BACK * 3600) / secPerBlock));
console.log(`head ${head}, block time ${(secPerBlock * 1000).toFixed(0)} ms`);
console.log(`${HOURS_BACK}h lookback starts at block ${from}\n`);

// --- 2. Fetch launches --------------------------------------------------------
const launches = [];
for (let b = from; launches.length < WANT && b < from + 20000n; b += 2000n) {
  const logs = await tryHard(() =>
    LOGS.getLogs({ address: FACTORY, event: evTokenLaunched, fromBlock: b, toBlock: b + 1999n }),
  );
  for (const l of logs) {
    if (launches.length >= WANT) break;
    launches.push({
      token: l.args.token,
      curve: l.args.curve,
      deployer: l.args.deployer,
      pairToken: l.args.pairToken,
      block: Number(l.blockNumber),
      tx: l.transactionHash,
    });
  }
  console.log(`  blocks ${b}..${b + 1999n}: found ${logs.length}, collected ${launches.length}`);
  await sleep(500);
}
console.log(`\nlaunches collected: ${launches.length}\n`);

// --- 3. Features and outcome for each launch ----------------------------------
const rows = [];
for (const L of launches) {
  const r = { ...L };
  try {
    const rec = await tryHard(() =>
      READ.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getLaunchedToken", args: [L.token] }),
    );
    r.phase = Number(rec.phase);
    r.outcome = PHASE[r.phase];
    r.graduated = r.phase === 2;
    r.creatorTaxBps = Number(rec.creatorTaxBps);
    r.feeToThirdParty = rec.creatorFeeRecipient.toLowerCase() !== rec.deployer.toLowerCase();

    const [name, symbol] = await Promise.all([
      READ.readContract({ address: L.token, abi: tokenAbi, functionName: "name" }).catch(() => "?"),
      READ.readContract({ address: L.token, abi: tokenAbi, functionName: "symbol" }).catch(() => "?"),
    ]);
    r.name = name;
    r.symbol = symbol;

    const info = await READ.readContract({ address: L.token, abi: tokenAbi, functionName: "getTokenInfo" }).catch(() => null);
    if (info) {
      const s = info[3];
      r.hasSocials = Boolean(s.twitter || s.telegram || s.website || s.discord || s.farcaster);
      r.hasDescription = String(info[2] ?? "").trim().length > 10;
    } else {
      r.hasSocials = null;
      r.hasDescription = null;
    }

    const [real, thr, la] = await Promise.all([
      READ.readContract({ address: L.curve, abi: curveAbi, functionName: "realQuoteReserve" }).catch(() => 0n),
      READ.readContract({ address: L.curve, abi: curveAbi, functionName: "graduationThreshold" }).catch(() => 0n),
      READ.readContract({ address: L.curve, abi: curveAbi, functionName: "launchedAt" }).catch(() => 0n),
    ]);
    r.progressPct = thr > 0n ? (Number(real) / Number(thr)) * 100 : 0;
    r.launchedAt = Number(la);

    // Creator buy = total CurveBuy inside the launch transaction, as a share of 1B supply.
    const receipt = await tryHard(() => READ.getTransactionReceipt({ hash: L.tx }));
    const buys = parseEventLogs({ abi: [evCurveBuy], logs: receipt.logs, eventName: "CurveBuy" });
    const devTokens = buys.reduce((a, b) => a + b.args.tokensOut, 0n);
    r.devBuyPct = (Number(devTokens) / Number(SUPPLY)) * 100;

    // Exempt wallets from launch calldata.
    const tx = await tryHard(() => READ.getTransaction({ hash: L.tx }));
    try {
      const d = decodeFunctionData({ abi: routerAbi, data: tx.input });
      r.exemptWallets = d.args[6].length;
    } catch {
      r.exemptWallets = null;
    }

    rows.push(r);
    process.stdout.write(".");
  } catch (e) {
    r.error = e.shortMessage ?? e.message;
    rows.push(r);
    process.stdout.write("x");
  }
  await sleep(120);
}

// --- 4. Display ---------------------------------------------------------------
console.log("\n");
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
console.log(
  pad("symbol", 12), pad("outcome", 8), pad("dev buy", 9), pad("exempt", 7),
  pad("tax", 6), pad("3rd", 4), pad("socials", 8), pad("progress", 9), "pair",
);
console.log("-".repeat(88));
for (const r of rows) {
  if (r.error) {
    console.log(pad(r.symbol ?? r.token.slice(0, 10), 12), "ERROR", r.error.slice(0, 55));
    continue;
  }
  console.log(
    pad(r.symbol, 12),
    pad(r.outcome, 8),
    pad(r.devBuyPct.toFixed(2) + "%", 9),
    pad(r.exemptWallets ?? "—", 7),
    pad((r.creatorTaxBps / 100).toFixed(1) + "%", 6),
    pad(r.feeToThirdParty ? "yes" : "—", 4),
    pad(r.hasSocials === null ? "?" : r.hasSocials ? "yes" : "no", 8),
    pad(r.progressPct.toFixed(1) + "%", 9),
    r.pairToken === ZERO ? "ETH" : r.pairToken.slice(0, 10),
  );
}

const ok = rows.filter((r) => !r.error);
console.log("-".repeat(88));
console.log(`processed ${ok.length}/${rows.length}   migrated ${ok.filter((r) => r.graduated).length}`);
console.log(`fields available: exempt ${ok.filter((r) => r.exemptWallets !== null).length}, socials ${ok.filter((r) => r.hasSocials !== null).length}`);

writeFileSync("data-sample.json", JSON.stringify(rows, (k, v) => (typeof v === "bigint" ? String(v) : v), 2));
console.log("saved to data-sample.json");
