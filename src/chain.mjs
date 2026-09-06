import { createPublicClient, http, parseAbi, parseAbiItem, decodeFunctionData, parseEventLogs } from "viem";

export const LOGS = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { retryCount: 0, timeout: 25000 }) });
export const READ = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { retryCount: 2, timeout: 25000 }) });

export const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const ZERO = "0x0000000000000000000000000000000000000000";
const SUPPLY = 1000000000n * 10n ** 18n;

export const evTokenLaunched = parseAbiItem(
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

export const PHASE = ["on curve", "curve closed", "IN POOL", "rescued"];

/** Read a token by address: model features plus current state. */
export async function readToken(token, opts = {}) {
  const rec = await READ.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getLaunchedToken", args: [token] });
  if (!rec.exists) throw new Error("not a pons v2 token");

  const [name, symbol] = await Promise.all([
    READ.readContract({ address: token, abi: tokenAbi, functionName: "name" }).catch(() => "?"),
    READ.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }).catch(() => "?"),
  ]);
  const info = await READ.readContract({ address: token, abi: tokenAbi, functionName: "getTokenInfo" }).catch(() => null);
  const [real, thr, la] = await Promise.all([
    READ.readContract({ address: rec.curve, abi: curveAbi, functionName: "realQuoteReserve" }).catch(() => 0n),
    READ.readContract({ address: rec.curve, abi: curveAbi, functionName: "graduationThreshold" }).catch(() => 0n),
    READ.readContract({ address: rec.curve, abi: curveAbi, functionName: "launchedAt" }).catch(() => 0n),
  ]);

  const r = {
    token,
    curve: rec.curve,
    deployer: rec.deployer,
    pairToken: rec.pairToken,
    isEthPair: rec.pairToken === ZERO,
    phase: Number(rec.phase),
    phaseName: PHASE[Number(rec.phase)],
    graduated: Number(rec.phase) === 2,
    creatorTaxBps: Number(rec.creatorTaxBps),
    feeToThirdParty: rec.creatorFeeRecipient.toLowerCase() !== rec.deployer.toLowerCase(),
    feeRecipient: rec.creatorFeeRecipient,
    name,
    symbol,
    description: info ? String(info[2] ?? "") : "",
    hasSocials: info ? Boolean(info[3].twitter || info[3].telegram || info[3].website || info[3].discord || info[3].farcaster) : null,
    hasDescription: info ? String(info[2] ?? "").trim().length > 10 : null,
    progressPct: thr > 0n ? (Number(real) / Number(thr)) * 100 : 0,
    launchedAt: Number(la),
    realQuote: String(real),
    threshold: String(thr),
    devBuyPct: null,
    exemptWallets: null,
  };
  r.traction = r.progressPct > 0.05 || r.phase >= 1;
  r.ageMin = r.launchedAt ? (Date.now() / 1000 - r.launchedAt) / 60 : null;

  // Creator buy and exempt wallets require the launch transaction, so they are optional and more expensive.
  if (opts.tx) {
    try {
      const receipt = await READ.getTransactionReceipt({ hash: opts.tx });
      const buys = parseEventLogs({ abi: [evCurveBuy], logs: receipt.logs, eventName: "CurveBuy" });
      r.devBuyPct = (Number(buys.reduce((a, b) => a + b.args.tokensOut, 0n)) / Number(SUPPLY)) * 100;
      const tx = await READ.getTransaction({ hash: opts.tx });
      try {
        const ex = decodeFunctionData({ abi: routerAbi, data: tx.input }).args[6].map((a) => a.toLowerCase());
        r.exemptWallets = ex.length; r.exemptRaw = ex;
      } catch {}
    } catch {}
  }
  return r;
}

/** Find the token launch transaction to recover creator buy data. Expensive; use on demand only. */
export async function findLaunchTx(token, curve, aroundBlock) {
  if (!aroundBlock) return null;
  const from = BigInt(aroundBlock) - 5n;
  const to = BigInt(aroundBlock) + 5n;
  try {
    const logs = await LOGS.getLogs({ address: FACTORY, event: evTokenLaunched, fromBlock: from, toBlock: to });
    const hit = logs.find((l) => l.args.token.toLowerCase() === token.toLowerCase());
    return hit?.transactionHash ?? null;
  } catch { return null; }
}


const evCurveSell = parseAbiItem(
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
);

/**
 * Activity on one curve during the observation window. Counts OUTSIDE buys:
 * not in the launch transaction, not from the deployer, and not from declared exempt wallets.
 * complete=false means some log ranges could not be read and the data is incomplete.
 */
export async function curveActivity(curve, fromBlock, deployer, exempt, launchTx, windowMs = 7200000, maxRanges = Infinity) {
  const head = await READ.getBlockNumber();
  const BLOCK_MS = 101;
  const span = BigInt(Math.round(windowMs / BLOCK_MS));
  let from = fromBlock != null ? BigInt(fromBlock) : head - span;
  let to = from + span > head ? head : from + span;
  const dep = String(deployer ?? "").toLowerCase();
  const ex = Array.isArray(exempt) ? exempt.map((a) => a.toLowerCase()) : [];

  let outsideQuoteIn = 0n, outsideBuys = 0, devSells = 0, buysTotal = 0, ok = 0, bad = 0;
  const buyers = new Set();
  const RANGE = 2000n;
  // Browser requests need a limit: a full window requires 36 passes and 25+ seconds.
  // The resolver runs without a limit because accuracy matters more than latency there.
  if (Number.isFinite(maxRanges)) {
    const want = BigInt(maxRanges) * RANGE;
    if (to - from > want) from = to - want;
  }
  let used = 0;
  for (let b = from; b <= to; b += RANGE) {
    if (++used > maxRanges) { bad++; break; }
    const hi = b + RANGE - 1n > to ? to : b + RANGE - 1n;
    let logs = null;
    for (let i = 0; i < 4 && !logs; i++) {
      logs = await LOGS.getLogs({ address: curve, events: [evCurveBuy, evCurveSell], fromBlock: b, toBlock: hi }).catch(() => null);
      if (!logs) await new Promise((r) => setTimeout(r, 900 * (i + 1)));
    }
    if (!logs) { bad++; continue; }
    ok++;
    for (const l of logs) {
      if (l.eventName === "CurveSell") {
        const s0 = l.args.seller.toLowerCase(), r0 = l.args.recipient.toLowerCase();
        if (s0 === dep || r0 === dep || ex.includes(s0) || ex.includes(r0)) devSells++;
        continue;
      }
      buysTotal++;
      if (launchTx && l.transactionHash === launchTx) continue;
      const b0 = l.args.buyer.toLowerCase(), r0 = l.args.recipient.toLowerCase();
      if (b0 === dep || r0 === dep || ex.includes(b0) || ex.includes(r0)) continue;
      outsideBuys++; outsideQuoteIn += l.args.quoteIn; buyers.add(b0);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { outsideQuoteIn: String(outsideQuoteIn), outsideBuys, outsideBuyers: buyers.size, devSells, buysTotal, complete: bad === 0, ranges: ok + bad, failed: bad };
}
