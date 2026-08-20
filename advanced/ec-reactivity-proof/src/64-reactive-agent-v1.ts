// Reactive agent v1: the full single-market loop on top of ReactiveMaker.sol.
// 63-reactive-maker-core.ts proved the core mechanic once (place two quotes,
// one fills, the precompile reactively cancels the other, in the same
// block) and then stopped. This is the loop that keeps running after that:
// it recomputes fair value from lucid-core every cycle, and treats a side
// whose tracked orderId reads 0 (never placed yet, or just reacted-cancelled
// by the contract's own onEvent) the same way it treats a side that has
// simply drifted past the requote threshold, place a fresh quote for that
// side alone. The two conditions are indistinguishable from the contract's
// state and do not need to be: either way the action is the same.
//
// DRY_RUN (default true): read-only, no wallet, no deploy, no chain writes.
// Picks a live market, computes fair value every cycle, logs what the loop
// would do, exactly the discipline MAKER.md and MAKER-V2.md established.
//
// Live run: deploys and funds a fresh ReactiveMaker, places both sides,
// subscribes to OrderFilled on the pool, then loops. One deliberate EOA
// crossing order is fired mid-run, sized to exactly consume one resting
// side, so the in-loop reactive cancel and the following cycle's automatic
// requote of that side are both captured in one continuous run, not
// inferred from two separate scripts.
import "dotenv/config";
import { parseAbi, encodeFunctionData, decodeEventLog, toEventSelector, parseAbiItem, type TransactionReceipt } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, activeMarkets, marketOnchain, outcomeSymbols, placeLimit, loadConfig, MARKET_STATUS } from "@dreamdex-bot-kit/ec-core";
import { createLucidContext, listLiveMarkets, resolveMarket, getMarketDefinition, getFairValueWithBook } from "@dreamdex-bot-kit/lucid-core";
import { Reactivity, SomniaReactivityPrecompileABI } from "@somnia-chain/reactivity";
import { compileContract } from "./compile.js";
import { planPrices, decideRequote, shouldPin, thresholdToRaw, type AgentConfig, type SideState } from "./agentLogic.js";

const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const HALF_SPREAD = Number(process.env.MM_HALF_SPREAD ?? "0.01");
const REQUOTE_THRESHOLD = Number(process.env.MM_REQUOTE_THRESHOLD ?? "0.006");
const MIN_TTL_SEC = Number(process.env.MM_MIN_TTL_SEC ?? "150");
const MARKET_MIN_TTL_MIN = Number(process.env.MM_MARKET_MIN_TTL_MIN ?? "15");
const LOOP_INTERVAL_MS = Number(process.env.MM_LOOP_INTERVAL_MS ?? "20000");
const RUN_SECONDS = process.env.MM_RUN_SECONDS ? Number(process.env.MM_RUN_SECONDS) : undefined;
const DRY_RUN_CYCLES = Number(process.env.MM_DRY_RUN_CYCLES ?? "6");
const QUOTE_QUANTITY_RAW = BigInt(process.env.MM_QUOTE_QUANTITY_RAW ?? "2000000");
const FUND_AMOUNT_RAW = BigInt(process.env.MM_FUND_AMOUNT_RAW ?? "8000000");
const CROSS_AFTER_CYCLE = Number(process.env.MM_CROSS_AFTER_CYCLE ?? "2");

const AGENT_CFG: AgentConfig = { halfSpread: HALF_SPREAD, requoteThreshold: REQUOTE_THRESHOLD, minTtlSec: MIN_TTL_SEC };
const THRESHOLD_RAW = thresholdToRaw(REQUOTE_THRESHOLD);

const GATE_ABI = parseAbi([
  "function placeQuote(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, bool isBid) returns (uint128 orderId)",
  "function cancelQuote(uint128 orderId)",
  "function bidOrderId() view returns (uint128)",
  "function askOrderId() view returns (uint128)",
]);
const GET_ORDER_ABI = parseAbi([
  "function getOrder(uint128 orderId) view returns ((uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))",
]);
const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const ORDER_PLACED_EVENT = parseAbiItem(
  "event OrderPlaced(uint128 indexed orderId, (uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs) placedOrder)",
);
const REACTED_EVENT = parseAbiItem("event Reacted(uint128 filledOrderId, uint128 cancelledOrderId)");

const MAX_FEE_PER_GAS = 60_000_000_000n;
const MAX_PRIORITY_FEE_PER_GAS = 0n;
const GAS = 10_000_000n;
const HANDLER_GAS_LIMIT = 5_000_000n;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  console.log(`${nowIso()} ${msg}`);
}

function orderIdFromReceipt(receipt: TransactionReceipt): bigint | undefined {
  for (const l of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: [ORDER_PLACED_EVENT], data: l.data, topics: l.topics });
      if (decoded.eventName === "OrderPlaced") return decoded.args.orderId;
    } catch {
      continue;
    }
  }
  return undefined;
}

// -------------------------------------------------------------------------
// DRY_RUN: no wallet, no writes. Picks a live market, computes fair value
// every cycle via lucid-core, and logs exactly what the live loop below
// would do with the contract's tracked order state simulated locally.
// -------------------------------------------------------------------------
async function runDryRun(): Promise<void> {
  const ctx = createLucidContext({});
  log(`reactive-agent-v1 up (DRY_RUN) · halfSpread=${HALF_SPREAD} requoteThreshold=${REQUOTE_THRESHOLD} minTtlSec=${MIN_TTL_SEC} cycles=${DRY_RUN_CYCLES}`);

  const candidates = await listLiveMarkets(ctx);
  const picked = candidates.filter((m) => m.ttlSec / 60 >= MARKET_MIN_TTL_MIN).sort((a, b) => a.ttlSec - b.ttlSec)[0];
  if (!picked) throw new Error(`no live market with ttl >= ${MARKET_MIN_TTL_MIN}min`);
  log(`target market: ${picked.symbol}, ttl ${(picked.ttlSec / 60).toFixed(1)}min`);

  const { market } = await resolveMarket(ctx, picked.symbol);
  const definition = await getMarketDefinition(ctx, market);
  log(`live tick=${definition.tickSize} lot=${definition.lotSize} minQty=${definition.minQuantity}`);

  const bid: SideState = { orderId: 0n };
  const ask: SideState = { orderId: 0n };
  let simulatedOrderIdCounter = 1n;

  for (let cycle = 1; cycle <= DRY_RUN_CYCLES; cycle++) {
    const fv = await getFairValueWithBook(ctx, market);
    const ttlSec = Number(definition.expiry) - Date.now() / 1000;

    if (shouldPin(ttlSec, MIN_TTL_SEC)) {
      log(`[${cycle}] ttl ${ttlSec.toFixed(0)}s < ${MIN_TTL_SEC}s: would cancel all resting quotes and stop`);
      break;
    }

    const { bidPriceRaw, askPriceRaw } = planPrices(fv.fairYes, AGENT_CFG, definition.tickSize);
    const bidDecision = decideRequote(bid, bidPriceRaw, THRESHOLD_RAW);
    const askDecision = decideRequote(ask, askPriceRaw, THRESHOLD_RAW);

    log(
      `[${cycle}] fair=${fv.fairYes.toFixed(4)} vol=${fv.volatility.toFixed(3)} book bid=${fv.book.bestBid ?? "-"} ask=${fv.book.bestAsk ?? "-"} | ` +
        `plan bid=${(Number(bidPriceRaw) / 1e6).toFixed(3)} ask=${(Number(askPriceRaw) / 1e6).toFixed(3)}`,
    );

    if (bidDecision.needed) {
      log(`  would place bid @ ${(Number(bidPriceRaw) / 1e6).toFixed(3)} (reason: ${bidDecision.reason})`);
      bid.orderId = simulatedOrderIdCounter++;
      bid.lastQuotedPriceRaw = bidPriceRaw;
    } else {
      log(`  bid unchanged (drift under threshold)`);
    }

    if (askDecision.needed) {
      log(`  would place ask @ ${(Number(askPriceRaw) / 1e6).toFixed(3)} (reason: ${askDecision.reason})`);
      ask.orderId = simulatedOrderIdCounter++;
      ask.lastQuotedPriceRaw = askPriceRaw;
    } else {
      log(`  ask unchanged (drift under threshold)`);
    }

    if (cycle === CROSS_AFTER_CYCLE) {
      log(`  [simulated] a fill on the ask now, contract would zero askOrderId via its own reactive cancel of the bid`);
      ask.orderId = 0n;
      bid.orderId = 0n;
      bid.lastQuotedPriceRaw = undefined;
    }

    if (cycle < DRY_RUN_CYCLES) await sleep(3000);
  }

  await ctx.exchange.close();
  log("DRY_RUN complete, no orders were ever placed, no wallet was ever required");
}

// -------------------------------------------------------------------------
// Live run
// -------------------------------------------------------------------------
async function realtimeSend(ctx: ReturnType<typeof createChainContext>, to: `0x${string}`, data: `0x${string}`): Promise<`0x${string}`> {
  const nonce = await ctx.publicClient.getTransactionCount({ address: ctx.account.address, blockTag: "pending" });
  const chain = ctx.walletClient.chain;
  if (!chain) throw new Error("no chain on wallet client");
  const signed = await ctx.account.signTransaction!({
    type: "eip1559",
    chainId: chain.id,
    to,
    data,
    gas: GAS,
    nonce,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
    value: 0n,
  });
  const raw = await (ctx.publicClient.request as (a: unknown) => Promise<unknown>)({ method: "realtime_sendRawTransaction", params: [signed] });
  if (raw == null) throw new Error("realtime_sendRawTransaction returned no receipt");
  const hash = (raw as { transactionHash?: `0x${string}`; hash?: `0x${string}` }).transactionHash ?? (raw as { hash: `0x${string}` }).hash;
  if (!hash) throw new Error(`realtime_sendRawTransaction result had no hash: ${JSON.stringify(raw)}`);
  return hash;
}

async function placeSide(
  chainCtx: ReturnType<typeof createChainContext>,
  agent: `0x${string}`,
  kind: 0 | 2,
  price: bigint,
  expiry: bigint,
  isBid: boolean,
): Promise<bigint> {
  const data = encodeFunctionData({ abi: GATE_ABI, functionName: "placeQuote", args: [kind, price, QUOTE_QUANTITY_RAW, expiry, isBid] });
  const tx = await realtimeSend(chainCtx, agent, data);
  const receipt = await chainCtx.publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new Error(`${isBid ? "bid" : "ask"} placement reverted, tx ${tx}`);
  const orderId = orderIdFromReceipt(receipt);
  if (orderId === undefined) throw new Error(`${isBid ? "bid" : "ask"} placed but no orderId decoded, tx ${tx}`);
  log(`  placed ${isBid ? "bid" : "ask"} @ ${(Number(price) / 1e6).toFixed(3)} orderId=${orderId} tx=${tx}`);
  return orderId;
}

async function cancelSide(chainCtx: ReturnType<typeof createChainContext>, agent: `0x${string}`, orderId: bigint, label: string): Promise<void> {
  const data = encodeFunctionData({ abi: GATE_ABI, functionName: "cancelQuote", args: [orderId] });
  const tx = await realtimeSend(chainCtx, agent, data);
  const receipt = await chainCtx.publicClient.waitForTransactionReceipt({ hash: tx });
  log(`  cancelled ${label} orderId=${orderId} tx=${tx} status=${receipt.status}`);
}

async function runLive(): Promise<void> {
  const chainCtx = createChainContext();
  const cfg = loadConfig();
  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc;
  if (!collateral) throw new Error("no collateral resolved");

  const lucidCtx = createLucidContext({ privateKey: process.env.PRIVATE_KEY as `0x${string}` });

  log(`reactive-agent-v1 up (LIVE) · halfSpread=${HALF_SPREAD} requoteThreshold=${REQUOTE_THRESHOLD} minTtlSec=${MIN_TTL_SEC} loopIntervalMs=${LOOP_INTERVAL_MS}`);

  log("=== resolving a live market with headroom ===");
  const candidates = (await listLiveMarkets(lucidCtx)).filter((m) => m.ttlSec / 60 >= MARKET_MIN_TTL_MIN).sort((a, b) => a.ttlSec - b.ttlSec);
  if (candidates.length === 0) throw new Error(`no live Trading market with ttl >= ${MARKET_MIN_TTL_MIN}min`);
  // A market whose fair value or book already sits pinned at the probability
  // extremes (near 0 or 1) is a poor demo candidate: there is no room for a
  // two-sided quote or a clean crossing order (found live, see
  // REACTIVE-AGENT-V1.md). Scan for the first candidate with a two-sided
  // book and a fair value away from the edges; fall back to the
  // least-extreme candidate if every one is pinned.
  let chosenMarket: Awaited<ReturnType<typeof resolveMarket>>["market"] | undefined;
  let chosenDefinition: Awaited<ReturnType<typeof getMarketDefinition>> | undefined;
  let fallback: { market: typeof chosenMarket; definition: typeof chosenDefinition; distanceFromEdge: number } | undefined;
  for (const c of candidates.slice(0, 8)) {
    const { market: m } = await resolveMarket(lucidCtx, c.symbol);
    const def = await getMarketDefinition(lucidCtx, m);
    const fv = await getFairValueWithBook(lucidCtx, m);
    const distanceFromEdge = Math.min(fv.fairYes, 1 - fv.fairYes);
    const twoSidedBook = fv.book.bestBid !== undefined && fv.book.bestAsk !== undefined;
    if (!fallback || distanceFromEdge > fallback.distanceFromEdge) fallback = { market: m, definition: def, distanceFromEdge };
    if (distanceFromEdge >= 0.05 && twoSidedBook) {
      chosenMarket = m;
      chosenDefinition = def;
      break;
    }
  }
  if (!chosenMarket || !chosenDefinition) {
    if (!fallback?.market || !fallback.definition) throw new Error("no candidate market resolved at all");
    log(`no candidate had a comfortable two-sided fair value, falling back to the least-extreme one`);
    chosenMarket = fallback.market;
    chosenDefinition = fallback.definition;
  }
  const market = chosenMarket;
  const definition = chosenDefinition;
  const pool = definition.pool;
  const pickedTtlMin = (Number(definition.expiry) - Date.now() / 1000) / 60;
  log(`market: ${market.symbol}, pool: ${pool}, expiry: ${definition.expiry}, ttl ${pickedTtlMin.toFixed(1)}min`);
  log(`live tick=${definition.tickSize} lot=${definition.lotSize} minQty=${definition.minQuantity}`);

  log("\n=== deploying ReactiveMaker ===");
  const { abi, bytecode } = compileContract("ReactiveMaker.sol", "ReactiveMaker");
  const deployHash = await chainCtx.walletClient.deployContract({
    abi,
    bytecode,
    args: [pool, collateral],
    account: chainCtx.account,
    chain: chainCtx.walletClient.chain,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
  });
  const deployReceipt = await chainCtx.publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== "success" || !deployReceipt.contractAddress) throw new Error("deploy failed");
  const agent = deployReceipt.contractAddress;
  log(`deployed at: ${agent}, deploy tx: ${deployHash}`);

  const fundHash = await chainCtx.walletClient.writeContract({
    address: collateral,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [agent, FUND_AMOUNT_RAW],
    account: chainCtx.account,
    chain: chainCtx.walletClient.chain,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
  });
  await chainCtx.publicClient.waitForTransactionReceipt({ hash: fundHash });
  log(`fund tx: ${fundHash} (${Number(FUND_AMOUNT_RAW) / 1e6} tUSDC)`);

  log("\n=== subscribing to OrderFilled on this pool ===");
  const topic0 = toEventSelector("OrderFilled(uint128,uint128,uint256,uint256,uint256,uint256)");
  const reactivity = new Reactivity({ public: chainCtx.publicClient, wallet: chainCtx.walletClient });
  const subResult = await reactivity.subscribe({
    handlerContractAddress: agent,
    filter: { eventTopics: [topic0], emitter: pool },
    options: { priorityFeePerGas: 0n, maxFeePerGas: MAX_FEE_PER_GAS, gasLimit: HANDLER_GAS_LIMIT },
  });
  if (subResult instanceof Error) throw subResult;
  const subReceipt = await chainCtx.publicClient.waitForTransactionReceipt({ hash: subResult });
  let subscriptionId: bigint | null = null;
  for (const l of subReceipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: SomniaReactivityPrecompileABI, data: l.data, topics: l.topics });
      if (decoded.eventName === "SubscriptionCreated") subscriptionId = (decoded.args as { subscriptionId: bigint }).subscriptionId;
    } catch {
      continue;
    }
  }
  log(`subscribe tx: ${subResult}, subscriptionId: ${subscriptionId}`);

  const bid: SideState = { orderId: 0n };
  const ask: SideState = { orderId: 0n };
  let crossFired = false;
  let stopped = false;
  const deadline = RUN_SECONDS ? Date.now() + RUN_SECONDS * 1000 : undefined;

  const cancelEverything = async (label: string): Promise<void> => {
    log(`shutting down (${label}), cancelling any resting quotes`);
    const liveBid = await chainCtx.publicClient.readContract({ address: agent, abi: GATE_ABI, functionName: "bidOrderId" });
    const liveAsk = await chainCtx.publicClient.readContract({ address: agent, abi: GATE_ABI, functionName: "askOrderId" });
    if (liveBid !== 0n) await cancelSide(chainCtx, agent, liveBid, "bid").catch((e) => log(`  cancel bid failed (expected if already gone): ${(e as Error).message.slice(0, 150)}`));
    if (liveAsk !== 0n) await cancelSide(chainCtx, agent, liveAsk, "ask").catch((e) => log(`  cancel ask failed (expected if already gone): ${(e as Error).message.slice(0, 150)}`));
    const finalBid = await chainCtx.publicClient.readContract({ address: agent, abi: GATE_ABI, functionName: "bidOrderId" });
    const finalAsk = await chainCtx.publicClient.readContract({ address: agent, abi: GATE_ABI, functionName: "askOrderId" });
    log(`final state: bidOrderId=${finalBid} askOrderId=${finalAsk}`);
  };

  const onSignal = (): void => {
    if (stopped) return;
    stopped = true;
    cancelEverything("signal").then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let cycle = 0;
  while (!stopped) {
    cycle++;
    if (deadline && Date.now() >= deadline) {
      log(`MM_RUN_SECONDS=${RUN_SECONDS} elapsed, stopping`);
      break;
    }

    const nowSec = Date.now() / 1000;
    const ttlSec = Number(definition.expiry) - nowSec;
    if (shouldPin(ttlSec, MIN_TTL_SEC)) {
      log(`[${cycle}] ttl ${ttlSec.toFixed(0)}s < ${MIN_TTL_SEC}s: pinning risk`);
      break;
    }

    try {
    const liveBidId = await chainCtx.publicClient.readContract({ address: agent, abi: GATE_ABI, functionName: "bidOrderId" });
    const liveAskId = await chainCtx.publicClient.readContract({ address: agent, abi: GATE_ABI, functionName: "askOrderId" });
    if (bid.orderId !== 0n && liveBidId === 0n) log(`  [${cycle}] bid orderId went from ${bid.orderId} to 0 without our own cancel: reactive handler cancelled it`);
    if (ask.orderId !== 0n && liveAskId === 0n) log(`  [${cycle}] ask orderId went from ${ask.orderId} to 0 without our own cancel: reactive handler cancelled it`);
    bid.orderId = liveBidId;
    ask.orderId = liveAskId;
    if (liveBidId === 0n) bid.lastQuotedPriceRaw = undefined;
    if (liveAskId === 0n) ask.lastQuotedPriceRaw = undefined;

    const fv = await getFairValueWithBook(lucidCtx, market);
    const { bidPriceRaw, askPriceRaw } = planPrices(fv.fairYes, AGENT_CFG, definition.tickSize);

    log(
      `[${cycle}] fair=${fv.fairYes.toFixed(4)} vol=${fv.volatility.toFixed(3)} book bid=${fv.book.bestBid ?? "-"} ask=${fv.book.bestAsk ?? "-"} | ` +
        `plan bid=${(Number(bidPriceRaw) / 1e6).toFixed(3)} ask=${(Number(askPriceRaw) / 1e6).toFixed(3)} | tracked bidId=${bid.orderId} askId=${ask.orderId}`,
    );

    const expireTimestampNs = (BigInt(Math.floor(nowSec)) + 300n < definition.expiry ? BigInt(Math.floor(nowSec)) + 300n : definition.expiry) * 1_000_000_000n;

    // A post-only order that would cross the live book reverts on chain,
    // correctly (MAKER-V2.md hit this same condition). When fair value sits
    // far enough from a thin/stale book that the straddled price would
    // cross, clamp that side to just outside the book's own touch instead of
    // skipping outright, so the agent still holds a real two-sided position
    // at the edge of the book rather than going one-sided for as long as
    // model and market disagree. The clamped price, not the raw fair-value
    // target, is what decideRequote compares against: otherwise a
    // persistently wide model-vs-book gap would recompute a "drifted" fair
    // target every cycle and force a needless cancel-and-replace of a
    // clamped price that has not actually moved.
    const tick = definition.tickSize;
    let effectiveBidPriceRaw = bidPriceRaw;
    let effectiveAskPriceRaw = askPriceRaw;
    let bidClamped = false;
    let askClamped = false;
    let bidSkippable = false;
    let askSkippable = false;
    if (fv.book.bestAsk !== undefined && Number(bidPriceRaw) / 1e6 >= fv.book.bestAsk) {
      const bestAskRaw = BigInt(Math.round(fv.book.bestAsk * 1e6));
      effectiveBidPriceRaw = bestAskRaw > tick ? bestAskRaw - tick : tick;
      bidClamped = true;
    } else if (fv.book.bestAsk === undefined && Number(bidPriceRaw) / 1e6 >= 0.99) {
      bidSkippable = true;
    }
    if (fv.book.bestBid !== undefined && Number(askPriceRaw) / 1e6 <= fv.book.bestBid) {
      const bestBidRaw = BigInt(Math.round(fv.book.bestBid * 1e6));
      effectiveAskPriceRaw = bestBidRaw + tick;
      askClamped = true;
    } else if (fv.book.bestBid === undefined && Number(askPriceRaw) / 1e6 <= 0.01) {
      askSkippable = true;
    }

    const bidDecision = decideRequote(bid, effectiveBidPriceRaw, THRESHOLD_RAW);
    const askDecision = decideRequote(ask, effectiveAskPriceRaw, THRESHOLD_RAW);

    if (bidDecision.needed && bidSkippable) {
      log(`  bid skipped, would cross and no book to clamp against`);
    } else if (bidDecision.needed) {
      if (bidClamped) log(`  bid clamped to book edge ${(Number(effectiveBidPriceRaw) / 1e6).toFixed(3)} (fair-value target ${(Number(bidPriceRaw) / 1e6).toFixed(3)} would have crossed ask ${fv.book.bestAsk})`);
      log(`  bid needs requote (${bidDecision.reason})`);
      if (bid.orderId !== 0n) await cancelSide(chainCtx, agent, bid.orderId, "stale bid").catch((e) => log(`  cancel stale bid failed: ${(e as Error).message.slice(0, 150)}`));
      const newId = await placeSide(chainCtx, agent, 0, effectiveBidPriceRaw, expireTimestampNs, true);
      bid.orderId = newId;
      bid.lastQuotedPriceRaw = effectiveBidPriceRaw;
    }

    if (askDecision.needed && askSkippable) {
      log(`  ask skipped, would cross and no book to clamp against`);
    } else if (askDecision.needed) {
      if (askClamped) log(`  ask clamped to book edge ${(Number(effectiveAskPriceRaw) / 1e6).toFixed(3)} (fair-value target ${(Number(askPriceRaw) / 1e6).toFixed(3)} would have crossed bid ${fv.book.bestBid})`);
      log(`  ask needs requote (${askDecision.reason})`);
      if (ask.orderId !== 0n) await cancelSide(chainCtx, agent, ask.orderId, "stale ask").catch((e) => log(`  cancel stale ask failed: ${(e as Error).message.slice(0, 150)}`));
      const newId = await placeSide(chainCtx, agent, 2, effectiveAskPriceRaw, expireTimestampNs, false);
      ask.orderId = newId;
      ask.lastQuotedPriceRaw = effectiveAskPriceRaw;
    }

    // The clamp-to-book-edge behavior above means the ask should almost
    // always end up resting somewhere valid, so the deliberate proof cross
    // always targets the ask: a marketable BUY_YES IOC needs only tUSDC
    // (abundant), never outcome-token inventory the EOA may not hold on a
    // fresh market the way hitting our own bid with a SELL_YES would.
    if (!crossFired && cycle >= CROSS_AFTER_CYCLE && ask.orderId !== 0n && ask.lastQuotedPriceRaw !== undefined) {
      crossFired = true;
      log("\n=== deliberate EOA crossing order: hit our own resting ask, sized to fill it exactly ===");
      const eoaCtx = createExchange({ withSigner: true });
      await eoaCtx.exchange.loadMarkets(true);
      const eoaMarkets = await activeMarkets(eoaCtx, { max: 1e6 });
      const eoaMarket = eoaMarkets.find((x) => x.symbol === market.symbol);
      if (!eoaMarket) throw new Error("market vanished before the deliberate cross");
      const eoaOnchain = await marketOnchain(eoaCtx, eoaMarket);
      if (!eoaOnchain) throw new Error("no onchain snapshot for the deliberate cross");
      const crossSize = Number(QUOTE_QUANTITY_RAW) / 1e6;
      // Our resting ask is a BUY_NO order that rests as a genuine ask in the
      // unified book (REACTIVE-MAKER-CORE.md confirmed isBid=false). Hit it,
      // at its actual resting price, not the raw fair-value target, since
      // the clamp above may have moved it.
      // Raw tick math, not a hardcoded float cap: a fixed 0.99 ceiling
      // failed live against a market whose ask was already resting at 0.999
      // (found live, see REACTIVE-AGENT-V1.md), since 0.99 sat below the
      // ask it was supposed to cross. Always price 5 ticks through the ask,
      // capped just under 1.0 in raw terms.
      const tick = definition.tickSize;
      const crossPriceRaw = ask.lastQuotedPriceRaw + 5n * tick > 999_000n ? 999_000n : ask.lastQuotedPriceRaw + 5n * tick;
      const crossPrice = Number(crossPriceRaw) / 1e6;
      const takerRes = await placeLimit(eoaCtx, { market: eoaMarket, onchain: eoaOnchain, outcome: "YES", side: "buy", price: crossPrice, size: crossSize, type: "ioc" });
      log(`  taker: filled=${takerRes.filled} price=${takerRes.price} hash=${takerRes.hash}`);
      await eoaCtx.exchange.close();

      log("  watching for the contract's own Reacted event (in-loop, not a separate script)...");
      for (let i = 0; i < 6; i++) {
        await sleep(3000);
        const logs = await chainCtx.publicClient.getContractEvents({ address: agent, abi: [REACTED_EVENT], eventName: "Reacted", fromBlock: deployReceipt.blockNumber, toBlock: "latest" });
        if (logs.length > 0) {
          const r = logs[0]!;
          const args = r.args as { filledOrderId: bigint; cancelledOrderId: bigint };
          const reactReceipt = await chainCtx.publicClient.getTransactionReceipt({ hash: r.transactionHash });
          const takerReceipt = await chainCtx.publicClient.getTransactionReceipt({ hash: takerRes.hash as `0x${string}` });
          log(
            `  Reacted: tx=${r.transactionHash} block=${reactReceipt.blockNumber} (fill block ${takerReceipt.blockNumber}) filledOrderId=${args.filledOrderId} cancelledOrderId=${args.cancelledOrderId}`,
          );
          break;
        }
        log(`  poll ${i + 1}: no Reacted event yet`);
      }
    }

    } catch (e) {
      // Per-cycle fault isolation (MAKER-V2.md hit exactly this gap: one bad
      // cycle silently blocking every later cycle). Log and continue; the
      // next cycle re-reads bidOrderId/askOrderId live from the contract, so
      // any partial state from a caught failure self-corrects on its own,
      // nothing needs to be rolled back by hand.
      log(`  [${cycle}] cycle error, continuing: ${(e as Error).message.slice(0, 300)}`);
    }

    if (cycle < 1e9) await sleep(LOOP_INTERVAL_MS);
  }

  if (!stopped) {
    stopped = true;
    await cancelEverything("loop end");
  }
}

const run = DRY_RUN ? runDryRun : runLive;
run().then(
  () => process.exit(0),
  (e) => {
    console.error(`RUN FAILED: ${(e as Error).message.slice(0, 1000)}`);
    process.exit(1);
  },
);
