// Single-variable confirmation: same TrivialForwarder, only expiry varies.
// Short expiry (min(now+300s, market's own expiry), the same rule ec-core's
// placeLimit applies for binary orders) expected to succeed; one-year
// expiry expected to revert 0xd3dea628. If the window holds, repeat both
// from the EOA directly, to confirm the earlier raw-EOA failures were the
// same expiry bug, nothing caller-related. Health check first. All markets
// and addresses resolved live.
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

interface Outcome {
  label: string;
  status: "success" | "reverted" | "error";
  tx?: string;
  gasUsed?: string;
  orderId?: string;
  ownerConfirmed?: boolean;
  cancelTx?: string;
  errorSnippet?: string;
}

async function attempt(
  ctx: ReturnType<typeof createChainContext>,
  label: string,
  to: `0x${string}`,
  data: `0x${string}`,
  pool: `0x${string}`,
  expectOwner: `0x${string}`,
  cancelTo: `0x${string}`,
  cancelData: (orderId: bigint) => `0x${string}`,
): Promise<Outcome> {
  try {
    const hash = await realtimeSend(ctx, to, data);
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      return { label, status: "reverted", tx: hash, gasUsed: receipt.gasUsed.toString() };
    }
    const orderId = orderIdFromReceipt(receipt);
    let ownerConfirmed: boolean | undefined;
    let cancelTx: string | undefined;
    if (orderId !== undefined) {
      const resting = await ctx.publicClient.readContract({ address: pool, abi: GET_ORDER_ABI, functionName: "getOrder", args: [orderId] });
      ownerConfirmed = resting.owner.toLowerCase() === expectOwner.toLowerCase();
      const cHash = await realtimeSend(ctx, cancelTo, cancelData(orderId));
      const cReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: cHash });
      cancelTx = `${cHash} (${cReceipt.status})`;
    }
    return { label, status: "success", tx: hash, gasUsed: receipt.gasUsed.toString(), orderId: orderId?.toString(), ownerConfirmed, cancelTx };
  } catch (e) {
    return { label, status: "error", errorSnippet: (e as Error).message.slice(0, 200) };
  }
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc;
  if (!collateral) throw new Error("no collateral resolved");

  console.log("=== finding a healthy window ===");
  let picked: { m: Awaited<ReturnType<typeof activeMarkets>>[number]; onchain: NonNullable<Awaited<ReturnType<typeof marketOnchain>>> } | null = null;
  let healthy = false;
  for (let attemptN = 1; attemptN <= 4 && !healthy; attemptN++) {
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
      const res = await placeLimit(sdkCtx, { market: picked.m, onchain: picked.onchain, outcome: "YES", side: "buy", price: 0.13, size: 2, type: "post-only" });
      console.log(`health check attempt ${attemptN}: place SUCCEEDED orderId=${res.orderId} hash=${res.hash}`);
      if (res.orderId !== undefined) {
        const cancelHash = await sdkCtx.exchange.trader.cancelOrder({ pool: picked.onchain.pool, orderId: res.orderId });
        console.log(`health check attempt ${attemptN}: cancel SUCCEEDED hash=${typeof cancelHash === "string" ? cancelHash : (cancelHash as { hash: string }).hash}`);
      }
      healthy = true;
    } catch (e) {
      console.log(`health check attempt ${attemptN}: reverted (${(e as Error).message.slice(0, 150)})`);
      picked = null;
    }
    await sdkCtx.exchange.close();
    if (!healthy && attemptN < 4) {
      console.log("waiting 20s before retry...");
      await sleep(20_000);
    }
  }
  if (!healthy || !picked) {
    console.log("\ndeferred, venue still flaky after 4 attempts.");
    process.exit(0);
  }

  const { m, onchain } = picked;
  const pool = onchain.pool;
  console.log(`\n=== clean window, market=${m.symbol} pool=${pool} ===`);

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const shortExpiry = ((nowSec + 300n) < onchain.expiry ? nowSec + 300n : onchain.expiry) * 1_000_000_000n;
  const oneYearExpiry = (nowSec + 365n * 24n * 60n * 60n) * 1_000_000_000n;
  const tick = 1000n;
  const quantity = 2_000_000n;

  console.log("deploying TrivialForwarder...");
  const { abi, bytecode } = compileContract("TrivialForwarder.sol", "TrivialForwarder");
  const deployHash = await ctx.walletClient.deployContract({ abi, bytecode, args: [pool, collateral], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS });
  const deployReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status !== "success" || !deployReceipt.contractAddress) throw new Error("deploy failed");
  const forwarder = deployReceipt.contractAddress;
  console.log(`deployed at: ${forwarder}, tx: ${deployHash}`);

  const fundHash = await ctx.walletClient.writeContract({ address: collateral, abi: ERC20_ABI, functionName: "transfer", args: [forwarder, 2_000_000n], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS });
  await ctx.publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log(`fund tx: ${fundHash}`);

  console.log(`\nshortExpiry=${shortExpiry} (${new Date(Number(shortExpiry / 1_000_000_000n) * 1000).toISOString()})`);
  console.log(`oneYearExpiry=${oneYearExpiry} (${new Date(Number(oneYearExpiry / 1_000_000_000n) * 1000).toISOString()})`);
  console.log(`market's own expiry=${onchain.expiry} (${new Date(Number(onchain.expiry) * 1000).toISOString()})`);

  const results: Outcome[] = [];

  console.log("\n--- forwarder, SHORT expiry ---");
  const price1 = 130000n - (130000n % tick);
  const data1 = encodeFunctionData({ abi, functionName: "placeBinaryOrder", args: [0, price1, quantity, shortExpiry, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n] });
  const res1 = await attempt(ctx, "forwarder short expiry", forwarder, data1, pool, forwarder, forwarder, (orderId) => encodeFunctionData({ abi, functionName: "cancelOrder", args: [orderId] }));
  console.log(JSON.stringify(res1));
  results.push(res1);

  console.log("\n--- forwarder, ONE-YEAR expiry ---");
  const price2 = price1 + tick;
  const data2 = encodeFunctionData({ abi, functionName: "placeBinaryOrder", args: [0, price2, quantity, oneYearExpiry, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n] });
  const res2 = await attempt(ctx, "forwarder one-year expiry", forwarder, data2, pool, forwarder, forwarder, (orderId) => encodeFunctionData({ abi, functionName: "cancelOrder", args: [orderId] }));
  console.log(JSON.stringify(res2));
  results.push(res2);

  console.log("\n--- bonus: EOA raw, SHORT expiry ---");
  const price3 = price1 + 2n * tick;
  const data3 = encodeFunctionData({ abi: POOL_ABI, functionName: "placeBinaryOrder", args: [0, price3, quantity, shortExpiry, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n] });
  const res3 = await attempt(ctx, "EOA short expiry", pool, data3, pool, ctx.account.address, pool, (orderId) => encodeFunctionData({ abi: CANCEL_ABI, functionName: "cancelOrder", args: [orderId] }));
  console.log(JSON.stringify(res3));
  results.push(res3);

  console.log("\n--- bonus: EOA raw, ONE-YEAR expiry ---");
  const price4 = price1 + 3n * tick;
  const data4 = encodeFunctionData({ abi: POOL_ABI, functionName: "placeBinaryOrder", args: [0, price4, quantity, oneYearExpiry, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n] });
  const res4 = await attempt(ctx, "EOA one-year expiry", pool, data4, pool, ctx.account.address, pool, (orderId) => encodeFunctionData({ abi: CANCEL_ABI, functionName: "cancelOrder", args: [orderId] }));
  console.log(JSON.stringify(res4));
  results.push(res4);

  console.log("\n=== FULL SUMMARY ===");
  console.log(JSON.stringify({ market: m.symbol, pool, forwarder, deployHash, fundHash, shortExpiry: shortExpiry.toString(), oneYearExpiry: oneYearExpiry.toString(), results }, null, 2));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`RUN FAILED: ${(e as Error).message.slice(0, 500)}`);
    process.exit(1);
  },
);
