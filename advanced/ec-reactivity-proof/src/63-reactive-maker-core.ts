// The reactive agent's core mechanic, proven live: a contract quotes two
// resting orders, and the instant one fills, the 0x0100 precompile calls
// its onEvent handler, which cancels the other, with no process in the
// loop. Every expiry used is min(now+300s, market's own expiry), never the
// hardcoded one-year horizon CONTRACT-ORDER-GATE.md confirmed as the real
// cause of every 0xd3dea628 revert this project hit. All markets and
// addresses resolved live.
import "dotenv/config";
import { parseAbi, parseAbiItem, decodeEventLog, encodeFunctionData, toEventSelector, type TransactionReceipt } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, activeMarkets, marketOnchain, outcomeSymbols, placeLimit, loadConfig, MARKET_STATUS } from "@dreamdex-bot-kit/ec-core";
import { Reactivity, SomniaReactivityPrecompileABI } from "@somnia-chain/reactivity";
import { compileContract } from "./compile.js";

const GATE_ABI_EXTRA = parseAbi([
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

function orderIdFromReceipt(receipt: TransactionReceipt): bigint | undefined {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: [ORDER_PLACED_EVENT], data: log.data, topics: log.topics });
      if (decoded.eventName === "OrderPlaced") return decoded.args.orderId;
    } catch {
      continue;
    }
  }
  return undefined;
}

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

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc;
  if (!collateral) throw new Error("no collateral resolved");

  console.log("=== resolving a live market with headroom ===");
  const sdkCtx = createExchange({ withSigner: true });
  await sdkCtx.exchange.loadMarkets(true);
  const markets = await activeMarkets(sdkCtx, { max: 1e6 });
  let picked: { m: (typeof markets)[number]; onchain: NonNullable<Awaited<ReturnType<typeof marketOnchain>>> } | null = null;
  for (const m of markets) {
    if (m.info.marketType !== "BINARY") continue;
    const onchain = await marketOnchain(sdkCtx, m);
    if (!onchain || onchain.status !== MARKET_STATUS.Trading) continue;
    const ttlMin = (Number(onchain.expiry) - Date.now() / 1000) / 60;
    if (ttlMin < 20) continue;
    picked = { m, onchain };
    break;
  }
  if (!picked) throw new Error("no live Trading market with enough headroom");
  const { m: market, onchain } = picked;
  const pool = onchain.pool;
  console.log(`market: ${market.symbol}, pool: ${pool}, expiry: ${onchain.expiry}`);

  const paramsAbi = parseAbi(["function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))"]);
  const params = await ctx.publicClient.readContract({ address: pool, abi: paramsAbi, functionName: "getOrderBookParameters" });
  const tick = params.tickSize;
  console.log(`live tick=${tick} lot=${params.lotSize} minQty=${params.minQuantity}`);

  const { yes } = outcomeSymbols(market);
  const book = await sdkCtx.exchange.fetchOrderBook(yes, 5);
  const bestBid = book.bids[0]?.[0];
  const bestAsk = book.asks[0]?.[0];
  console.log(`live book: bestBid=${bestBid} bestAsk=${bestAsk}`);
  if (bestBid === undefined || bestAsk === undefined) throw new Error("book must be two-sided already to place safely");

  const oneUnit = 10 ** onchain.decimals;
  const rawBid = BigInt(Math.round(bestBid * oneUnit));
  const rawAsk = BigInt(Math.round(bestAsk * oneUnit));
  const bidPrice = (rawBid - 5n * tick > 0n ? rawBid - 5n * tick : tick) - ((rawBid - 5n * tick) % tick);
  const quantity = 2_000_000n;

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const shortExpiry = ((nowSec + 300n) < onchain.expiry ? nowSec + 300n : onchain.expiry) * 1_000_000_000n;
  console.log(`short expiry: ${shortExpiry} (${new Date(Number(shortExpiry / 1_000_000_000n) * 1000).toISOString()})`);

  await sdkCtx.exchange.close();

  console.log("\n=== deploying ReactiveMaker ===");
  const { abi, bytecode } = compileContract("ReactiveMaker.sol", "ReactiveMaker");
  const deployHash = await ctx.walletClient.deployContract({ abi, bytecode, args: [pool, collateral], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS });
  const deployReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== "success" || !deployReceipt.contractAddress) throw new Error("deploy failed");
  const agent = deployReceipt.contractAddress;
  console.log(`deployed at: ${agent}, deploy tx: ${deployHash}, block: ${deployReceipt.blockNumber}`);

  const fundHash = await ctx.walletClient.writeContract({ address: collateral, abi: ERC20_ABI, functionName: "transfer", args: [agent, 4_000_000n], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS });
  await ctx.publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log(`fund tx: ${fundHash}`);

  console.log("\n=== placing the bid (BUY_YES) ===");
  const dataBid = encodeFunctionData({ abi: GATE_ABI_EXTRA, functionName: "placeQuote", args: [0, bidPrice, quantity, shortExpiry, true] });
  const bidTx = await realtimeSend(ctx, agent, dataBid);
  const bidReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: bidTx });
  console.log(`bid place: status=${bidReceipt.status} tx=${bidTx} gasUsed=${bidReceipt.gasUsed}`);
  if (bidReceipt.status !== "success") throw new Error("bid placement reverted");
  const bidOrderId = orderIdFromReceipt(bidReceipt);
  if (bidOrderId === undefined) throw new Error("no bid orderId decoded");
  const bidResting = await ctx.publicClient.readContract({ address: pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [bidOrderId] });
  console.log(`bid orderId=${bidOrderId} isBid=${bidResting.isBid} price=${bidResting.price} owner=${bidResting.owner}`);

  console.log("\n=== placing the ask (BUY_NO) ===");
  const askPrice = rawAsk - (rawAsk % tick);
  const dataAsk = encodeFunctionData({ abi: GATE_ABI_EXTRA, functionName: "placeQuote", args: [2, askPrice, quantity, shortExpiry, false] });
  const askTx = await realtimeSend(ctx, agent, dataAsk);
  const askReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: askTx });
  console.log(`ask place: status=${askReceipt.status} tx=${askTx} gasUsed=${askReceipt.gasUsed}`);
  if (askReceipt.status !== "success") throw new Error("ask placement reverted");
  const askOrderId = orderIdFromReceipt(askReceipt);
  if (askOrderId === undefined) throw new Error("no ask orderId decoded");
  const askResting = await ctx.publicClient.readContract({ address: pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [askOrderId] });
  console.log(`ask orderId=${askOrderId} isBid=${askResting.isBid} price=${askResting.price} owner=${askResting.owner}`);

  console.log("\n=== subscribing to OrderFilled on this pool ===");
  const topic0 = toEventSelector("OrderFilled(uint128,uint128,uint256,uint256,uint256,uint256)");
  console.log(`OrderFilled topic0: ${topic0}`);
  const reactivity = new Reactivity({ public: ctx.publicClient, wallet: ctx.walletClient });
  const subResult = await reactivity.subscribe({
    handlerContractAddress: agent,
    filter: { eventTopics: [topic0], emitter: pool },
    options: { priorityFeePerGas: 0n, maxFeePerGas: MAX_FEE_PER_GAS, gasLimit: HANDLER_GAS_LIMIT },
  });
  if (subResult instanceof Error) throw subResult;
  console.log(`subscribe tx: ${subResult}`);
  const subReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: subResult });
  console.log(`subscribe status: ${subReceipt.status} gasUsed: ${subReceipt.gasUsed}`);
  let subscriptionId: bigint | null = null;
  for (const log of subReceipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: SomniaReactivityPrecompileABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "SubscriptionCreated") {
        subscriptionId = (decoded.args as { subscriptionId: bigint }).subscriptionId;
        break;
      }
    } catch {
      continue;
    }
  }
  console.log(`subscriptionId: ${subscriptionId}`);

  console.log("\n=== EOA crossing order: buy into the ask, sized to fill it exactly ===");
  const eoaCtx = createExchange({ withSigner: true });
  await eoaCtx.exchange.loadMarkets(true);
  const eoaMarkets = await activeMarkets(eoaCtx, { max: 1e6 });
  const eoaMarket = eoaMarkets.find((x) => x.symbol === market.symbol);
  if (!eoaMarket) throw new Error("market vanished");
  const eoaOnchain = await marketOnchain(eoaCtx, eoaMarket);
  if (!eoaOnchain) throw new Error("no onchain snapshot");
  const crossPrice = Number(askPrice) / oneUnit + 0.01 > 0.99 ? 0.99 : Number(askPrice) / oneUnit + 0.01;
  console.log(`EOA taker: BUY_YES ioc at ${crossPrice}, size 2`);
  const takerRes = await placeLimit(eoaCtx, { market: eoaMarket, onchain: eoaOnchain, outcome: "YES", side: "buy", price: crossPrice, size: 2, type: "ioc" });
  console.log(`taker result: filled=${takerRes.filled} price=${takerRes.price} hash=${takerRes.hash}`);
  await eoaCtx.exchange.close();

  console.log("\n=== waiting for the reactive callback ===");
  let reactedLog: { transactionHash: `0x${string}`; args: { filledOrderId: bigint; cancelledOrderId: bigint } } | null = null;
  for (let i = 0; i < 10 && !reactedLog; i++) {
    await sleep(4000);
    const logs = await ctx.publicClient.getContractEvents({ address: agent, abi: [REACTED_EVENT], eventName: "Reacted", fromBlock: deployReceipt.blockNumber, toBlock: "latest" });
    if (logs.length > 0) {
      const l = logs[0];
      if (l) reactedLog = { transactionHash: l.transactionHash, args: l.args as { filledOrderId: bigint; cancelledOrderId: bigint } };
    }
    console.log(`  poll ${i + 1}: Reacted logs found=${logs.length}`);
  }

  if (!reactedLog) {
    console.log("\nno Reacted event observed within the poll window. checking resting state directly...");
    const bidNow = await ctx.publicClient.readContract({ address: pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [bidOrderId] });
    const askNow = await ctx.publicClient.readContract({ address: pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [askOrderId] });
    console.log(`bid quantityRemaining=${bidNow.quantityRemaining}, ask quantityRemaining=${askNow.quantityRemaining}`);
    console.log("\n=== SUMMARY (no reaction observed) ===");
    console.log(JSON.stringify({ market: market.symbol, pool, agent, deployHash, fundHash, bidTx, askTx, bidOrderId: bidOrderId.toString(), askOrderId: askOrderId.toString(), subscribeTx: subResult, subscriptionId: subscriptionId?.toString(), takerHash: takerRes.hash }, null, 2));
    return;
  }

  console.log(`\nReacted event found: tx=${reactedLog.transactionHash} filledOrderId=${reactedLog.args.filledOrderId} cancelledOrderId=${reactedLog.args.cancelledOrderId}`);
  const reactTx = await ctx.publicClient.getTransaction({ hash: reactedLog.transactionHash });
  const reactReceipt = await ctx.publicClient.getTransactionReceipt({ hash: reactedLog.transactionHash });
  console.log(`reactive tx: from=${reactTx.from} to=${reactTx.to} nonce=${reactTx.nonce} status=${reactReceipt.status} gasUsed=${reactReceipt.gasUsed}`);
  const ourRealNonce = await ctx.publicClient.getTransactionCount({ address: ctx.account.address });
  console.log(`our EOA's real account nonce right now: ${ourRealNonce} (the reactive tx's nonce ${reactTx.nonce} should be wildly larger, a synthetic reactivity-queue value, not this)`);

  const cancelledOrder = await ctx.publicClient.readContract({ address: pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [reactedLog.args.cancelledOrderId] });
  console.log(`cancelled order quantityRemaining now: ${cancelledOrder.quantityRemaining} (0 means gone)`);

  console.log("\n=== SUMMARY ===");
  console.log(
    JSON.stringify(
      {
        market: market.symbol,
        pool,
        agent,
        deployHash,
        fundHash,
        bidTx,
        bidOrderId: bidOrderId.toString(),
        askTx,
        askOrderId: askOrderId.toString(),
        subscribeTx: subResult,
        subscriptionId: subscriptionId?.toString(),
        takerHash: takerRes.hash,
        takerFilled: takerRes.filled,
        reactiveTx: reactedLog.transactionHash,
        reactiveTxNonce: reactTx.nonce,
        reactiveTxFrom: reactTx.from,
        ourRealNonce,
        filledOrderId: reactedLog.args.filledOrderId.toString(),
        cancelledOrderId: reactedLog.args.cancelledOrderId.toString(),
        cancelledOrderQuantityRemainingAfter: cancelledOrder.quantityRemaining.toString(),
      },
      null,
      2,
    ),
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`RUN FAILED: ${(e as Error).message.slice(0, 800)}`);
    process.exit(1);
  },
);
