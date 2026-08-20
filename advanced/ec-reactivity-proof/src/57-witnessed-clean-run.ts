// Single bounded check, no loops. First: confirm the venue is currently
// healthy by placing and cancelling one small post-only order from the EOA
// via the SDK's own Trader.placeOrder path. If that reverts with the
// transient 0xd3dea628, stop and report the venue is still flaky. If it
// succeeds, immediately run the full contract flow once: deploy a fresh
// ContractOrderGate, fund it, place via the contract, confirm the resting
// order's maker is the contract address, cancel via the contract, confirm
// it is gone. All markets and addresses resolved live.
import "dotenv/config";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, activeMarkets, marketOnchain, placeLimit, MARKET_STATUS, loadConfig, outcomeSymbols } from "@dreamdex-bot-kit/ec-core";
import { createReadOnlyContext, resolveMarket, getMarketDefinition } from "@dreamdex-bot-kit/lucid-core";
import { compileContract } from "./compile.js";

const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const GET_ORDER_ABI = parseAbi(["function getOrder(uint128 orderId) view returns ((uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))"]);

const FUND_AMOUNT = 2_000_000n; // 2 tUSDC raw

async function main(): Promise<void> {
  console.log("=== step 1: EOA health check via the SDK's own Trader.placeOrder ===");
  const sdkCtx = createExchange({ withSigner: true });
  await sdkCtx.exchange.loadMarkets(true);
  const markets = await activeMarkets(sdkCtx, { max: 1e6 });
  let picked: { m: (typeof markets)[number]; onchain: NonNullable<Awaited<ReturnType<typeof marketOnchain>>> } | null = null;
  for (const m of markets) {
    if (m.info.marketType !== "BINARY") continue;
    const onchain = await marketOnchain(sdkCtx, m);
    if (!onchain || onchain.status !== MARKET_STATUS.Trading) continue;
    const ttlMin = (Number(onchain.expiry) - Date.now() / 1000) / 60;
    if (ttlMin < 15) continue;
    picked = { m, onchain };
    break;
  }
  if (!picked) throw new Error("no live Trading market with enough runway for the health check");
  console.log(`health check market: ${picked.m.symbol} pool: ${picked.onchain.pool}`);

  let healthCheckOrderId: bigint | undefined;
  let healthCheckPlaceHash: string | undefined;
  let healthCheckCancelHash: string | undefined;
  try {
    const res = await placeLimit(sdkCtx, { market: picked.m, onchain: picked.onchain, outcome: "YES", side: "buy", price: 0.2, size: 2, type: "post-only" });
    healthCheckOrderId = res.orderId;
    healthCheckPlaceHash = res.hash;
    console.log(`health check place SUCCEEDED: orderId=${res.orderId} hash=${res.hash}`);
    if (res.orderId !== undefined) {
      const cancelHash = await sdkCtx.exchange.trader.cancelOrder({ pool: picked.onchain.pool, orderId: res.orderId });
      healthCheckCancelHash = typeof cancelHash === "string" ? cancelHash : (cancelHash as { hash: string }).hash;
      console.log(`health check cancel SUCCEEDED: hash=${healthCheckCancelHash}`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    await sdkCtx.exchange.close();
    if (msg.includes("0xd3dea628") || msg.toLowerCase().includes("unknown reason")) {
      console.log(`\nvenue still flaky, deferring. health check reverted: ${msg.slice(0, 300)}`);
      process.exit(0);
    }
    throw e;
  }
  await sdkCtx.exchange.close();

  console.log("\n=== venue is healthy, proceeding to the contract flow ===");

  const ctx = createChainContext();
  const cfg = loadConfig();
  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc;
  if (!collateral) throw new Error("no collateral address resolved");

  const roCtx = createReadOnlyContext();
  const { market, onchain } = await resolveMarket(roCtx, picked.m.symbol);
  const definition = await getMarketDefinition(roCtx, market);
  console.log(`contract flow market: ${picked.m.symbol} pool: ${onchain.pool} tick=${definition.tickSize} lot=${definition.lotSize}`);

  const { abi, bytecode } = compileContract("ContractOrderGate.sol", "ContractOrderGate");
  const deployHash = await ctx.walletClient.deployContract({ abi, bytecode, args: [onchain.pool, collateral], account: ctx.account, chain: ctx.walletClient.chain });
  const deployReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== "success" || !deployReceipt.contractAddress) throw new Error("deploy failed");
  const gate = deployReceipt.contractAddress;
  console.log(`\ndeploy tx: ${deployHash}`);
  console.log(`deployed at: ${gate}`);

  const fundHash = await ctx.walletClient.writeContract({ address: collateral, abi: ERC20_ABI, functionName: "transfer", args: [gate, FUND_AMOUNT], account: ctx.account, chain: ctx.walletClient.chain });
  await ctx.publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log(`fund tx: ${fundHash}`);

  const { yes } = outcomeSymbols(market);
  const book = await roCtx.exchange.fetchOrderBook(yes, 3);
  const bestBid = book.bids[0]?.[0];
  const tick = definition.tickSize;
  const oneUnit = 10 ** definition.decimals;
  let priceAligned: bigint;
  if (bestBid === undefined) {
    priceAligned = tick * 100n;
  } else {
    const rawBid = BigInt(Math.round(bestBid * oneUnit));
    const target = rawBid > 20n * tick ? rawBid - 20n * tick : tick;
    priceAligned = target - (target % tick);
  }
  const quantity = 2n * BigInt(oneUnit);
  console.log(`\nplacing via the contract: price=${priceAligned} quantity=${quantity} bestBid=${bestBid ?? "none"}`);

  const placeSim = await ctx.publicClient.simulateContract({ address: gate, abi, functionName: "placeOrder", args: [0, priceAligned, quantity], account: ctx.account });
  const orderId = placeSim.result as bigint;
  const placeHash = await ctx.walletClient.writeContract(placeSim.request);
  const placeReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: placeHash });
  console.log(`place tx: ${placeHash}`);
  console.log(`place status: ${placeReceipt.status} gasUsed: ${placeReceipt.gasUsed}`);
  if (placeReceipt.status !== "success") throw new Error("place reverted on chain");

  // fetchOpenOrders (the unified SDK method) is scoped to the connected
  // signer's own address, no arbitrary-address overload, so this reads the
  // same underlying data it wraps directly for the contract's own address.
  const readCtx = createExchange({ withSigner: false });
  await readCtx.exchange.loadMarkets(true);
  const portfolio = await readCtx.exchange.client.getPortfolio(gate);
  await readCtx.exchange.close();
  const openOrderForGate = portfolio.openOrders.find((o) => o.orderId?.toString() === orderId.toString());
  console.log(`\nportfolio open orders for the contract address: ${portfolio.openOrders.length}`);
  console.log(`this order appears in the contract's own open orders: ${Boolean(openOrderForGate)}`);

  const resting = await ctx.publicClient.readContract({ address: onchain.pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] });
  console.log(`getOrder maker/owner: ${resting.owner}`);
  console.log(`owner is the contract: ${resting.owner.toLowerCase() === gate.toLowerCase()}`);
  if (resting.owner.toLowerCase() !== gate.toLowerCase()) throw new Error("owner mismatch");

  const cancelSim = await ctx.publicClient.simulateContract({ address: gate, abi, functionName: "cancelOrder", args: [orderId], account: ctx.account });
  const cancelHash = await ctx.walletClient.writeContract(cancelSim.request);
  const cancelReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: cancelHash });
  console.log(`\ncancel tx: ${cancelHash}`);
  console.log(`cancel status: ${cancelReceipt.status} gasUsed: ${cancelReceipt.gasUsed}`);
  if (cancelReceipt.status !== "success") throw new Error("cancel reverted on chain");

  const after = await ctx.publicClient.readContract({ address: onchain.pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] });
  console.log(`\nafter cancel, quantityRemaining: ${after.quantityRemaining}, gone: ${after.quantityRemaining === 0n}`);

  console.log(`\n=== WITNESSED CLEAN RUN COMPLETE ===`);
  console.log(`health check place: ${healthCheckPlaceHash}`);
  console.log(`health check cancel: ${healthCheckCancelHash}`);
  console.log(`health check orderId: ${healthCheckOrderId}`);
  console.log(`market: ${picked.m.symbol}`);
  console.log(`gate: ${gate}`);
  console.log(`deploy: ${deployHash}`);
  console.log(`fund: ${fundHash}`);
  console.log(`place: ${placeHash}`);
  console.log(`cancel: ${cancelHash}`);
  console.log(`orderId: ${orderId}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`RUN FAILED: ${(e as Error).message.slice(0, 500)}`);
    process.exit(1);
  },
);
