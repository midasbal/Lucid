// Confirm the submission-channel hypothesis directly: does a raw
// placeBinaryOrder succeed when signed and submitted the way the SDK's own
// local-account path does, via Somnia's realtime_sendRawTransaction, versus
// reverting through the standard writeContract path, and does that carry
// down through ContractOrderGate too? Health check first, with a bounded
// retry since the venue is intermittently flaky, then three tests in the
// same clean window. Order ids are decoded from the OrderPlaced event log on
// the receipt, never from a pre-send simulateContract call, since that itself
// exercises the standard eth_call channel this test is trying not to depend
// on. All markets and addresses resolved live.
import "dotenv/config";
import { parseAbi, parseAbiItem, decodeEventLog, encodeFunctionData, type TransactionReceipt } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, activeMarkets, marketOnchain, placeLimit, loadConfig, MARKET_STATUS } from "@dreamdex-bot-kit/ec-core";
import { compileContract } from "./compile.js";

const POOL_ABI = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
]);
const CANCEL_ABI = parseAbi(["function cancelOrder(uint128 orderId)"]);
const GET_ORDER_ABI = parseAbi([
  "function getOrder(uint128 orderId) view returns ((uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))",
]);
const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const ORDER_PLACED_EVENT = parseAbiItem(
  "event OrderPlaced(uint128 indexed orderId, (uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs) placedOrder)",
);

const MAX_FEE_PER_GAS = 60_000_000_000n;
const MAX_PRIORITY_FEE_PER_GAS = 0n;
const GAS = 10_000_000n;

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

async function realtimeSend(ctx: ReturnType<typeof createChainContext>, to: `0x${string}`, data: `0x${string}`, value: bigint = 0n): Promise<`0x${string}`> {
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
    value,
  });
  const raw = await (ctx.publicClient.request as (a: unknown) => Promise<unknown>)({
    method: "realtime_sendRawTransaction",
    params: [signed],
  });
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

  console.log("=== finding a healthy window ===");
  let picked: { m: Awaited<ReturnType<typeof activeMarkets>>[number]; onchain: NonNullable<Awaited<ReturnType<typeof marketOnchain>>> } | null = null;
  let healthy = false;
  for (let attempt = 1; attempt <= 4 && !healthy; attempt++) {
    const sdkCtx = createExchange({ withSigner: true });
    await sdkCtx.exchange.loadMarkets(true);
    const markets = await activeMarkets(sdkCtx, { max: 1e6 });
    picked = null;
    for (const m of markets) {
      if (m.info.marketType !== "BINARY") continue;
      const onchain = await marketOnchain(sdkCtx, m);
      if (!onchain || onchain.status !== MARKET_STATUS.Trading) continue;
      const ttlMin = (Number(onchain.expiry) - Date.now() / 1000) / 60;
      if (ttlMin < 15) continue;
      picked = { m, onchain };
      break;
    }
    if (!picked) {
      await sdkCtx.exchange.close();
      throw new Error("no live Trading market with enough runway");
    }
    try {
      const res = await placeLimit(sdkCtx, { market: picked.m, onchain: picked.onchain, outcome: "YES", side: "buy", price: 0.16, size: 2, type: "post-only" });
      console.log(`health check attempt ${attempt}: place SUCCEEDED orderId=${res.orderId} hash=${res.hash}`);
      if (res.orderId !== undefined) {
        const cancelHash = await sdkCtx.exchange.trader.cancelOrder({ pool: picked.onchain.pool, orderId: res.orderId });
        console.log(`health check attempt ${attempt}: cancel SUCCEEDED hash=${typeof cancelHash === "string" ? cancelHash : (cancelHash as { hash: string }).hash}`);
      }
      healthy = true;
    } catch (e) {
      console.log(`health check attempt ${attempt}: reverted (${(e as Error).message.slice(0, 150)})`);
      picked = null;
    }
    await sdkCtx.exchange.close();
    if (!healthy && attempt < 4) {
      console.log("waiting 20s before retry...");
      await sleep(20_000);
    }
  }
  if (!healthy || !picked) {
    console.log("\ndeferred, venue still flaky after 4 attempts.");
    process.exit(0);
  }

  const { onchain } = picked;
  const pool = onchain.pool;
  console.log(`\n=== clean window found on ${picked.m.symbol}, pool ${pool}, running the three tests ===`);

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const expiry = (nowSec + 300n) * 1_000_000_000n;
  const tick = 1000n;
  const price = 200000n - (200000n % tick);
  const quantity = 2_000_000n;

  console.log(`\n--- test A: EOA raw, realtime_sendRawTransaction ---`);
  try {
    const dataA = encodeFunctionData({
      abi: POOL_ABI,
      functionName: "placeBinaryOrder",
      args: [0, price, quantity, expiry, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n],
    });
    const hash = await realtimeSend(ctx, pool, dataA);
    console.log(`A: submitted via realtime_sendRawTransaction, tx=${hash}`);
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    console.log(`A: status=${receipt.status} gasUsed=${receipt.gasUsed}`);
    if (receipt.status === "success") {
      const orderIdA = orderIdFromReceipt(receipt);
      console.log(`A: orderId (from OrderPlaced log)=${orderIdA}`);
      if (orderIdA !== undefined) {
        const resting = await ctx.publicClient.readContract({ address: pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderIdA] });
        console.log(`A: resting order owner=${resting.owner}, quantityRemaining=${resting.quantityRemaining}`);
        const dataCancelA = encodeFunctionData({ abi: CANCEL_ABI, functionName: "cancelOrder", args: [orderIdA] });
        const cancelHashA = await realtimeSend(ctx, pool, dataCancelA);
        const cancelReceiptA = await ctx.publicClient.waitForTransactionReceipt({ hash: cancelHashA });
        console.log(`A: cancel status=${cancelReceiptA.status} tx=${cancelHashA}`);
      }
    }
  } catch (e) {
    console.log(`A: FAILED (${(e as Error).message.slice(0, 300)})`);
  }

  console.log(`\n--- test B: EOA raw, standard writeContract ---`);
  const priceB = price + tick;
  try {
    const hashB = await ctx.walletClient.writeContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "placeBinaryOrder",
      args: [0, priceB, quantity, expiry, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n],
      account: ctx.account,
      chain: ctx.walletClient.chain,
      gas: GAS,
      maxFeePerGas: MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
    });
    const receiptB = await ctx.publicClient.waitForTransactionReceipt({ hash: hashB });
    console.log(`B: status=${receiptB.status} tx=${hashB}`);
    if (receiptB.status === "success") {
      const orderIdB = orderIdFromReceipt(receiptB);
      console.log(`B: orderId (from OrderPlaced log)=${orderIdB}`);
      if (orderIdB !== undefined) {
        const cancelHashB = await ctx.walletClient.writeContract({ address: pool, abi: CANCEL_ABI, functionName: "cancelOrder", args: [orderIdB], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS });
        await ctx.publicClient.waitForTransactionReceipt({ hash: cancelHashB });
        console.log(`B: cancelled, tx=${cancelHashB}`);
      }
    }
  } catch (e) {
    console.log(`B: REVERTED (${(e as Error).message.slice(0, 300)})`);
  }

  console.log(`\n--- test C: ContractOrderGate, realtime_sendRawTransaction ---`);
  const { abi, bytecode } = compileContract("ContractOrderGate.sol", "ContractOrderGate");
  const deployHash = await ctx.walletClient.deployContract({ abi, bytecode, args: [pool, collateral], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS });
  const deployReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== "success" || !deployReceipt.contractAddress) throw new Error("deploy failed");
  const gate = deployReceipt.contractAddress;
  console.log(`deployed at: ${gate}, deploy tx: ${deployHash}`);

  const fundHash = await ctx.walletClient.writeContract({ address: collateral, abi: ERC20_ABI, functionName: "transfer", args: [gate, 2_000_000n], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS });
  await ctx.publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log(`fund tx: ${fundHash}`);

  const priceC = price + 2n * tick;
  try {
    const dataC = encodeFunctionData({ abi, functionName: "placeOrder", args: [0, priceC, quantity] });
    const hashC = await realtimeSend(ctx, gate, dataC);
    console.log(`C: submitted via realtime_sendRawTransaction, tx=${hashC}`);
    const receiptC = await ctx.publicClient.waitForTransactionReceipt({ hash: hashC });
    console.log(`C: status=${receiptC.status} gasUsed=${receiptC.gasUsed}`);
    if (receiptC.status === "success") {
      const orderIdC = orderIdFromReceipt(receiptC);
      console.log(`C: orderId (from OrderPlaced log)=${orderIdC}`);
      if (orderIdC !== undefined) {
        const resting = await ctx.publicClient.readContract({ address: pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderIdC] });
        console.log(`C: resting order owner=${resting.owner}, is the contract=${resting.owner.toLowerCase() === gate.toLowerCase()}`);

        const dataCancelC = encodeFunctionData({ abi, functionName: "cancelOrder", args: [orderIdC] });
        const cancelHashC = await realtimeSend(ctx, gate, dataCancelC);
        const cancelReceiptC = await ctx.publicClient.waitForTransactionReceipt({ hash: cancelHashC });
        console.log(`C: cancel status=${cancelReceiptC.status} tx=${cancelHashC}`);

        const after = await ctx.publicClient.readContract({ address: pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderIdC] });
        console.log(`C: after cancel, quantityRemaining=${after.quantityRemaining}, gone=${after.quantityRemaining === 0n}`);
      }
    }
  } catch (e) {
    console.log(`C: FAILED (${(e as Error).message.slice(0, 300)})`);
  }

  console.log("\n=== DONE ===");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`RUN FAILED: ${(e as Error).message.slice(0, 500)}`);
    process.exit(1);
  },
);
