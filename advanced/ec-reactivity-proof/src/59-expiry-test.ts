// Decisive one-pass test of the expiry hypothesis: our raw calls hardcode
// expireTimestampNs to a one-year horizon; these markets expire in minutes
// to hours; maybe that horizon itself is an unconditional reject. Health
// check first, capture a real successful order's exact nine argument values
// by decoding its own mined transaction, then replicate that exact call raw
// from the EOA. If that succeeds, isolate which field mattered. All markets
// and addresses resolved live. One pass, no loops.
import "dotenv/config";
import { decodeFunctionData, parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, activeMarkets, marketOnchain, placeLimit, MARKET_STATUS } from "@dreamdex-bot-kit/ec-core";

const SDK_MAX_FEE_PER_GAS = 60_000_000_000n;
const SDK_MAX_PRIORITY_FEE_PER_GAS = 0n;

const POOL_ABI = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
]);
const CANCEL_ABI = parseAbi(["function cancelOrder(uint128 orderId)"]);

type PlaceArgs = readonly [number, bigint, bigint, bigint, number, number, `0x${string}`, bigint, bigint];

async function rawPlace(ctx: ReturnType<typeof createChainContext>, pool: `0x${string}`, args: PlaceArgs, label: string): Promise<{ hash?: `0x${string}`; status?: string; error?: string; orderId?: bigint }> {
  try {
    const orderId = await ctx.publicClient.simulateContract({ address: pool, abi: POOL_ABI, functionName: "placeBinaryOrder", args, account: ctx.account }).then((s) => s.result[1]);
    const hash = await ctx.walletClient.writeContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "placeBinaryOrder",
      args,
      account: ctx.account,
      chain: ctx.walletClient.chain,
      gas: 10_000_000n,
      maxFeePerGas: SDK_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: SDK_MAX_PRIORITY_FEE_PER_GAS,
    });
    const r = await ctx.publicClient.waitForTransactionReceipt({ hash });
    console.log(`${label}: status=${r.status} tx=${hash} orderId=${orderId}`);
    if (r.status === "success") {
      const cancelHash = await ctx.walletClient.writeContract({
        address: pool,
        abi: CANCEL_ABI,
        functionName: "cancelOrder",
        args: [orderId],
        account: ctx.account,
        chain: ctx.walletClient.chain,
        maxFeePerGas: SDK_MAX_FEE_PER_GAS,
        maxPriorityFeePerGas: SDK_MAX_PRIORITY_FEE_PER_GAS,
      });
      const rc = await ctx.publicClient.waitForTransactionReceipt({ hash: cancelHash });
      console.log(`${label} cancel: status=${rc.status} tx=${cancelHash}`);
    }
    return { hash, status: r.status, orderId };
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`${label}: REVERTED (${msg.slice(0, 150)})`);
    return { error: msg };
  }
}

async function main(): Promise<void> {
  const ctx = createChainContext();

  console.log("=== step 1: health check + capture a real successful order's exact fields ===");
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
  console.log(`market's own expiry (unix sec): ${picked.onchain.expiry}`);
  console.log(`current unix time (sec): ${Math.floor(Date.now() / 1000)}`);

  let sdkArgs: PlaceArgs | null = null;
  try {
    const res = await placeLimit(sdkCtx, { market: picked.m, onchain: picked.onchain, outcome: "YES", side: "buy", price: 0.18, size: 2, type: "post-only" });
    console.log(`health check place SUCCEEDED: orderId=${res.orderId} hash=${res.hash}`);
    if (res.hash) {
      const tx = await ctx.publicClient.getTransaction({ hash: res.hash as `0x${string}` });
      const decoded = decodeFunctionData({ abi: POOL_ABI, data: tx.input });
      sdkArgs = decoded.args as unknown as PlaceArgs;
      console.log(`decoded SDK call args: ${JSON.stringify(sdkArgs, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      console.log(`SDK expireTimestampNs: ${sdkArgs[3]} (${Number(sdkArgs[3]) / 1e9} unix sec)`);
      const expirySec = Number(sdkArgs[3]) / 1e9;
      const nowSec = Date.now() / 1000;
      console.log(`SDK expiry is ${((expirySec - nowSec) / (365.25 * 24 * 3600)).toFixed(2)} years past now`);
      console.log(`market's own expiry is ${((Number(picked.onchain.expiry) - nowSec) / 60).toFixed(1)} minutes past now`);
      console.log(`SDK expiry vs market expiry: SDK expiry is ${expirySec > Number(picked.onchain.expiry) ? "FAR PAST" : "BEFORE"} the market's own expiry`);
    }
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

  if (!sdkArgs) throw new Error("could not capture SDK args, no tx hash on the successful result");

  console.log("\n=== step 2: decisive replication, raw call with the SDK's exact just-used values ===");
  const replication = await rawPlace(ctx, picked.onchain.pool, sdkArgs, "replication");

  if (replication.status === "success") {
    console.log("\nreplication SUCCEEDED. isolating which field mattered...");
    console.log("\n=== step 3a: SDK's price, our original one-year expiry ===");
    const oneYearExpiry = BigInt((Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60)) * 1_000_000_000n;
    const argsA: PlaceArgs = [sdkArgs[0], sdkArgs[1], sdkArgs[2], oneYearExpiry, sdkArgs[4], sdkArgs[5], sdkArgs[6], sdkArgs[7], sdkArgs[8]];
    await rawPlace(ctx, picked.onchain.pool, argsA, "test A (SDK price, our old expiry)");

    console.log("\n=== step 3b: SDK's expiry, a fresh valid price ===");
    const freshPrice = sdkArgs[1] > 5000n ? sdkArgs[1] - 5000n : sdkArgs[1] + 5000n;
    const argsB: PlaceArgs = [sdkArgs[0], freshPrice, sdkArgs[2], sdkArgs[3], sdkArgs[4], sdkArgs[5], sdkArgs[6], sdkArgs[7], sdkArgs[8]];
    await rawPlace(ctx, picked.onchain.pool, argsB, "test B (SDK expiry, fresh price)");
  } else {
    console.log("\nreplication ALSO REVERTED with the SDK's exact just-used values.");
    console.log("field values are not the cause. dumping account/nonce context:");
    const nonce = await ctx.publicClient.getTransactionCount({ address: ctx.account.address });
    console.log(`current account nonce: ${nonce}`);
    console.log(`account: ${ctx.account.address}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`RUN FAILED: ${(e as Error).message.slice(0, 500)}`);
    process.exit(1);
  },
);
