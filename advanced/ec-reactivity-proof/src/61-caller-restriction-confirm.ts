// Settle whether the binary pool blocks contract callers, deterministically,
// not by luck. Three separate healthy windows, each found via the SDK's own
// health check with backoff, and in each window: EOA raw via the realtime
// channel, ContractOrderGate, and a second, even more trivial forwarder
// contract, back to back, same market, same style of order. Order ids read
// from the OrderPlaced event log, never from a pre-send simulateContract
// prediction. All markets and addresses resolved live.
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
const WINDOWS = 3;

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

interface AttemptResult {
  label: string;
  status: "success" | "reverted" | "error";
  tx?: string;
  gasUsed?: string;
  orderId?: string;
  ownerConfirmed?: boolean;
  cancelTx?: string;
  errorSnippet?: string;
}

async function attemptPlace(ctx: ReturnType<typeof createChainContext>, label: string, to: `0x${string}`, data: `0x${string}`, pool: `0x${string}`, expectOwner: `0x${string}`, cancelData: (orderId: bigint) => `0x${string}`): Promise<AttemptResult> {
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
      const cHash = await realtimeSend(ctx, to, cancelData(orderId));
      const cReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: cHash });
      cancelTx = `${cHash} (${cReceipt.status})`;
    }
    return { label, status: "success", tx: hash, gasUsed: receipt.gasUsed.toString(), orderId: orderId?.toString(), ownerConfirmed, cancelTx };
  } catch (e) {
    return { label, status: "error", errorSnippet: (e as Error).message.slice(0, 200) };
  }
}

async function findHealthyWindow(ctx: ReturnType<typeof createChainContext>): Promise<{ m: Awaited<ReturnType<typeof activeMarkets>>[number]; onchain: NonNullable<Awaited<ReturnType<typeof marketOnchain>>> } | null> {
  for (let attempt = 1; attempt <= 4; attempt++) {
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
    if (!picked) {
      await sdkCtx.exchange.close();
      throw new Error("no live Trading market with enough runway");
    }
    try {
      const res = await placeLimit(sdkCtx, { market: picked.m, onchain: picked.onchain, outcome: "YES", side: "buy", price: 0.14, size: 2, type: "post-only" });
      console.log(`  health check attempt ${attempt}: place SUCCEEDED orderId=${res.orderId} hash=${res.hash}`);
      if (res.orderId !== undefined) {
        const cancelHash = await sdkCtx.exchange.trader.cancelOrder({ pool: picked.onchain.pool, orderId: res.orderId });
        console.log(`  health check attempt ${attempt}: cancel SUCCEEDED hash=${typeof cancelHash === "string" ? cancelHash : (cancelHash as { hash: string }).hash}`);
      }
      await sdkCtx.exchange.close();
      return picked;
    } catch (e) {
      console.log(`  health check attempt ${attempt}: reverted (${(e as Error).message.slice(0, 150)})`);
      await sdkCtx.exchange.close();
      if (attempt < 4) {
        console.log("  waiting 20s before retry...");
        await sleep(20_000);
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const collateral = cfg.addresses.collateral ?? cfg.addresses.testUsdc;
  if (!collateral) throw new Error("no collateral resolved");

  const gateCompiled = compileContract("ContractOrderGate.sol", "ContractOrderGate");
  const forwarderCompiled = compileContract("TrivialForwarder.sol", "TrivialForwarder");

  const allResults: { window: number; market: string; results: AttemptResult[] }[] = [];

  for (let w = 1; w <= WINDOWS; w++) {
    console.log(`\n=== window ${w}: finding a healthy window ===`);
    const picked = await findHealthyWindow(ctx);
    if (!picked) {
      console.log(`window ${w}: deferred, venue still flaky after 4 attempts.`);
      allResults.push({ window: w, market: "none", results: [] });
      continue;
    }
    const { m, onchain } = picked;
    const pool = onchain.pool;
    console.log(`window ${w}: clean, market=${m.symbol} pool=${pool}`);

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const expiry = (nowSec + 300n) * 1_000_000_000n;
    const tick = 1000n;
    const quantity = 2_000_000n;

    console.log(`window ${w}: deploying ContractOrderGate and TrivialForwarder...`);
    const gateDeployHash = await ctx.walletClient.deployContract({ abi: gateCompiled.abi, bytecode: gateCompiled.bytecode, args: [pool, collateral], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS });
    const gateReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: gateDeployHash });
    if (gateReceipt.status !== "success" || !gateReceipt.contractAddress) throw new Error("gate deploy failed");
    const gate = gateReceipt.contractAddress;

    const fwdDeployHash = await ctx.walletClient.deployContract({ abi: forwarderCompiled.abi, bytecode: forwarderCompiled.bytecode, args: [pool, collateral], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS });
    const fwdReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: fwdDeployHash });
    if (fwdReceipt.status !== "success" || !fwdReceipt.contractAddress) throw new Error("forwarder deploy failed");
    const forwarder = fwdReceipt.contractAddress;
    console.log(`window ${w}: gate=${gate} (tx ${gateDeployHash})`);
    console.log(`window ${w}: forwarder=${forwarder} (tx ${fwdDeployHash})`);

    const fundGate = await ctx.walletClient.writeContract({ address: collateral, abi: ERC20_ABI, functionName: "transfer", args: [gate, 2_000_000n], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS });
    await ctx.publicClient.waitForTransactionReceipt({ hash: fundGate });
    const fundFwd = await ctx.walletClient.writeContract({ address: collateral, abi: ERC20_ABI, functionName: "transfer", args: [forwarder, 2_000_000n], account: ctx.account, chain: ctx.walletClient.chain, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS });
    await ctx.publicClient.waitForTransactionReceipt({ hash: fundFwd });
    console.log(`window ${w}: funded both (tx ${fundGate}, tx ${fundFwd})`);

    const results: AttemptResult[] = [];

    console.log(`window ${w}: test A, EOA raw via realtime channel...`);
    const priceA = 150000n - (150000n % tick);
    const dataA = encodeFunctionData({ abi: POOL_ABI, functionName: "placeBinaryOrder", args: [0, priceA, quantity, expiry, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n] });
    const resA = await attemptPlace(ctx, "A: EOA raw", pool, dataA, pool, ctx.account.address, (orderId) => encodeFunctionData({ abi: CANCEL_ABI, functionName: "cancelOrder", args: [orderId] }));
    console.log(`window ${w}: A result: ${JSON.stringify(resA)}`);
    results.push(resA);

    console.log(`window ${w}: test B, ContractOrderGate...`);
    const priceB = priceA + tick;
    const dataB = encodeFunctionData({ abi: gateCompiled.abi, functionName: "placeOrder", args: [0, priceB, quantity] });
    const resB = await attemptPlace(ctx, "B: ContractOrderGate", gate, dataB, pool, gate, (orderId) => encodeFunctionData({ abi: gateCompiled.abi, functionName: "cancelOrder", args: [orderId] }));
    console.log(`window ${w}: B result: ${JSON.stringify(resB)}`);
    results.push(resB);

    console.log(`window ${w}: test C, TrivialForwarder...`);
    const priceC = priceA + 2n * tick;
    const dataC = encodeFunctionData({ abi: forwarderCompiled.abi, functionName: "placeBinaryOrder", args: [0, priceC, quantity, expiry, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n] });
    const resC = await attemptPlace(ctx, "C: TrivialForwarder", forwarder, dataC, pool, forwarder, (orderId) => encodeFunctionData({ abi: forwarderCompiled.abi, functionName: "cancelOrder", args: [orderId] }));
    console.log(`window ${w}: C result: ${JSON.stringify(resC)}`);
    results.push(resC);

    allResults.push({ window: w, market: m.symbol, results });

    if (w < WINDOWS) {
      console.log(`\nwindow ${w} done, waiting 30s before seeking the next window...`);
      await sleep(30_000);
    }
  }

  console.log("\n=== FULL SUMMARY ===");
  console.log(JSON.stringify(allResults, null, 2));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`RUN FAILED: ${(e as Error).message.slice(0, 500)}`);
    process.exit(1);
  },
);
