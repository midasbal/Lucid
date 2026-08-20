// Decisive one-pass test: does setting maxFeePerGas to match the SDK's own
// fixed 60 gwei default fix the 0xd3dea628 revert, for both an EOA-direct
// raw call and the deployed ContractOrderGate? Health check first via the
// SDK's own Trader.placeOrder; if that itself is flaky, stop. No loops, one
// attempt per step. All markets and addresses resolved live.
import "dotenv/config";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, activeMarkets, marketOnchain, placeLimit, MARKET_STATUS, loadConfig, outcomeSymbols } from "@dreamdex-bot-kit/ec-core";
import { createReadOnlyContext, resolveMarket, getMarketDefinition } from "@dreamdex-bot-kit/lucid-core";
import { compileContract } from "./compile.js";

const SDK_MAX_FEE_PER_GAS = 60_000_000_000n; // matches @somnia-chain/markets-sdk's Config.DEFAULT_FEES
const SDK_MAX_PRIORITY_FEE_PER_GAS = 0n;

const POOL_ABI = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
]);
const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const GET_ORDER_ABI = parseAbi(["function getOrder(uint128 orderId) view returns ((uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))"]);

async function main(): Promise<void> {
  const ctx = createChainContext();

  const block = await ctx.publicClient.getBlock();
  console.log(`current block baseFeePerGas: ${block.baseFeePerGas}`);
  console.log(`SDK fixed maxFeePerGas: ${SDK_MAX_FEE_PER_GAS} (60 gwei), maxPriorityFeePerGas: ${SDK_MAX_PRIORITY_FEE_PER_GAS}`);
  console.log(`SDK fee source: node_modules/@somnia-chain/markets-sdk/src/config.ts:185-188 (Config.DEFAULT_FEES), applied in writer.ts:193`);

  console.log("\n=== step 0: health check via the SDK's own Trader.placeOrder ===");
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
  if (!picked) throw new Error("no live Trading market with enough runway");
  console.log(`market: ${picked.m.symbol} pool: ${picked.onchain.pool}`);

  try {
    const res = await placeLimit(sdkCtx, { market: picked.m, onchain: picked.onchain, outcome: "YES", side: "buy", price: 0.15, size: 2, type: "post-only" });
    console.log(`health check place SUCCEEDED: orderId=${res.orderId} hash=${res.hash}`);
    if (res.orderId !== undefined) {
      const cancelHash = await sdkCtx.exchange.trader.cancelOrder({ pool: picked.onchain.pool, orderId: res.orderId });
      console.log(`health check cancel SUCCEEDED: hash=${typeof cancelHash === "string" ? cancelHash : (cancelHash as { hash: string }).hash}`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    await sdkCtx.exchange.close();
    console.log(`\ndeferred, venue flaky. health check reverted: ${msg.slice(0, 300)}`);
    process.exit(0);
  }
  await sdkCtx.exchange.close();

  console.log("\n=== venue healthy, proceeding to the fee matrix ===");

  const roCtx = createReadOnlyContext();
  const { market, onchain } = await resolveMarket(roCtx, picked.m.symbol);
  const definition = await getMarketDefinition(roCtx, market);
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
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const expiry = (nowSec + 365n * 24n * 60n * 60n) * 1_000_000_000n;
  console.log(`price=${priceAligned} quantity=${quantity} bestBid=${bestBid ?? "none"}`);

  console.log("\n=== test A: EOA raw, direct to pool, maxFeePerGas=60gwei ===");
  try {
    const orderIdA = await ctx.publicClient
      .simulateContract({
        address: onchain.pool,
        abi: POOL_ABI,
        functionName: "placeBinaryOrder",
        args: [0, priceAligned, quantity, expiry, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n],
        account: ctx.account,
      })
      .then((s) => s.result[1]);
    const hashA = await ctx.walletClient.writeContract({
      address: onchain.pool,
      abi: POOL_ABI,
      functionName: "placeBinaryOrder",
      args: [0, priceAligned, quantity, expiry, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n],
      account: ctx.account,
      chain: ctx.walletClient.chain,
      gas: 10_000_000n,
      maxFeePerGas: SDK_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: SDK_MAX_PRIORITY_FEE_PER_GAS,
    });
    const rA = await ctx.publicClient.waitForTransactionReceipt({ hash: hashA });
    console.log(`A status: ${rA.status} gasUsed: ${rA.gasUsed} tx: ${hashA} orderId: ${orderIdA}`);
    if (rA.status === "success") {
      const cancelHashA = await ctx.walletClient.writeContract({
        address: onchain.pool,
        abi: parseAbi(["function cancelOrder(uint128 orderId)"]),
        functionName: "cancelOrder",
        args: [orderIdA],
        account: ctx.account,
        chain: ctx.walletClient.chain,
        maxFeePerGas: SDK_MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: SDK_MAX_PRIORITY_FEE_PER_GAS,
      });
      const rCancelA = await ctx.publicClient.waitForTransactionReceipt({ hash: cancelHashA });
      console.log(`A cancel status: ${rCancelA.status} tx: ${cancelHashA}`);
    }
  } catch (e) {
    console.log(`A REVERTED: ${(e as Error).message.slice(0, 300)}`);
  }

  console.log("\n=== test B: through ContractOrderGate, maxFeePerGas=60gwei ===");
  const cfg = loadConfig();
  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc;
  if (!collateral) throw new Error("no collateral resolved");
  const { abi, bytecode } = compileContract("ContractOrderGate.sol", "ContractOrderGate");
  const deployHash = await ctx.walletClient.deployContract({ abi, bytecode, args: [onchain.pool, collateral], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: SDK_MAX_FEE_PER_GAS, maxPriorityFeePerGas: SDK_MAX_PRIORITY_FEE_PER_GAS });
  const deployReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== "success" || !deployReceipt.contractAddress) throw new Error("deploy failed");
  const gate = deployReceipt.contractAddress;
  console.log(`deploy tx: ${deployHash}`);
  console.log(`deployed at: ${gate}`);

  const fundHash = await ctx.walletClient.writeContract({ address: collateral, abi: ERC20_ABI, functionName: "transfer", args: [gate, 2_000_000n], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: SDK_MAX_FEE_PER_GAS, maxPriorityFeePerGas: SDK_MAX_PRIORITY_FEE_PER_GAS });
  await ctx.publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log(`fund tx: ${fundHash}`);

  try {
    const placeSim = await ctx.publicClient.simulateContract({ address: gate, abi, functionName: "placeOrder", args: [0, priceAligned, quantity], account: ctx.account });
    const orderId = placeSim.result as bigint;
    const placeHashB = await ctx.walletClient.writeContract({
      address: gate,
      abi,
      functionName: "placeOrder",
      args: [0, priceAligned, quantity],
      account: ctx.account,
      chain: ctx.walletClient.chain,
      maxFeePerGas: SDK_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: SDK_MAX_PRIORITY_FEE_PER_GAS,
    });
    const rB = await ctx.publicClient.waitForTransactionReceipt({ hash: placeHashB });
    console.log(`B place status: ${rB.status} gasUsed: ${rB.gasUsed} tx: ${placeHashB}`);

    if (rB.status === "success") {
      const resting = await ctx.publicClient.readContract({ address: onchain.pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] });
      console.log(`resting order owner: ${resting.owner}, is the contract: ${resting.owner.toLowerCase() === gate.toLowerCase()}`);

      const readCtx = createExchange({ withSigner: false });
      await readCtx.exchange.loadMarkets(true);
      const portfolio = await readCtx.exchange.client.getPortfolio(gate);
      await readCtx.exchange.close();
      const openOrderForGate = portfolio.openOrders.find((o) => o.orderId?.toString() === orderId.toString());
      console.log(`fetchOpenOrders (via getPortfolio for the contract address) shows this order: ${Boolean(openOrderForGate)}`);

      const cancelHashB = await ctx.walletClient.writeContract({
        address: gate,
        abi,
        functionName: "cancelOrder",
        args: [orderId],
        account: ctx.account,
        chain: ctx.walletClient.chain,
        maxFeePerGas: SDK_MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: SDK_MAX_PRIORITY_FEE_PER_GAS,
      });
      const rC = await ctx.publicClient.waitForTransactionReceipt({ hash: cancelHashB });
      console.log(`B cancel status: ${rC.status} tx: ${cancelHashB}`);

      const after = await ctx.publicClient.readContract({ address: onchain.pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] });
      console.log(`after cancel, quantityRemaining: ${after.quantityRemaining}, gone: ${after.quantityRemaining === 0n}`);

      console.log(`\nB SUMMARY: orderId=${orderId} place=${placeHashB} cancel=${cancelHashB}`);
    }
  } catch (e) {
    console.log(`B REVERTED: ${(e as Error).message.slice(0, 300)}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`RUN FAILED: ${(e as Error).message.slice(0, 500)}`);
    process.exit(1);
  },
);
