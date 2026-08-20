// Step 4 + 5 setup: poll our specific market for finalization AND poll the
// handler's hitCount for a corrected-topic0 MarketFinalized firing. Reports
// both independently so we can tell whether the subscription genuinely
// caught our market's own finalization or a different one.
import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange } from "@dreamdex-bot-kit/ec-core";

const MARKET_ID = "0x00000000000000000000000000000000000000000000000000000000000046f1" as `0x${string}`;
const CORRECTED_TOPIC0 = "0xb1884334e955f8d8727678d4fa52dd9fc7140ff5e4ad38d358453bd400ada178";

const HANDLER_ABI = [
  { type: "function", name: "hitCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "ReactiveHit",
    inputs: [
      { name: "emitter", type: "address", indexed: false },
      { name: "topic0", type: "bytes32", indexed: false },
      { name: "blockNumber", type: "uint256", indexed: false },
    ],
  },
] as const;

const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 20 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const handlerAddress = process.env.HANDLER_ADDRESS as `0x${string}`;
  const ecCtx = createExchange({ withSigner: false });

  const startBlock = await ctx.publicClient.getBlockNumber();
  const startHitCount = await ctx.publicClient.readContract({ address: handlerAddress, abi: HANDLER_ABI, functionName: "hitCount" });
  console.log(`watching from block ${startBlock}, starting hitCount=${startHitCount}`);

  const deadline = Date.now() + TIMEOUT_MS;
  let marketFinalizedReported = false;

  while (Date.now() < deadline) {
    const onchain = await ecCtx.exchange.client.getMarketOnchain(MARKET_ID);
    const nowBlock = await ctx.publicClient.getBlockNumber();
    const hitCount = await ctx.publicClient.readContract({ address: handlerAddress, abi: HANDLER_ABI, functionName: "hitCount" });

    console.log(
      `[${new Date().toISOString()}] block=${nowBlock} market.finalized=${onchain?.finalized} market.status=${onchain?.status} hitCount=${hitCount}`,
    );

    if (hitCount > startHitCount && !marketFinalizedReported) {
      const logs = await ctx.publicClient.getContractEvents({
        address: handlerAddress,
        abi: HANDLER_ABI,
        eventName: "ReactiveHit",
        fromBlock: startBlock,
        toBlock: nowBlock,
      });
      for (const log of logs) {
        if (log.args.topic0 === CORRECTED_TOPIC0) {
          console.log("\nCORRECTED MarketFinalized ReactiveHit fired:");
          console.log(`  tx: ${log.transactionHash}`);
          console.log(`  block: ${log.blockNumber}`);
          console.log(`  args: ${JSON.stringify(log.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
          const receipt = await ctx.publicClient.getTransactionReceipt({ hash: log.transactionHash });
          console.log(`  gasUsed: ${receipt.gasUsed}`);
          console.log(`  explorer: ${ctx.net.explorer}/tx/${log.transactionHash}`);
          marketFinalizedReported = true;
        }
      }
    }

    if (onchain?.finalized) {
      console.log("\nOur market is finalized on-chain.");
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const finalOnchain = await ecCtx.exchange.client.getMarketOnchain(MARKET_ID);
  console.log(`\nfinal onchain snapshot: ${JSON.stringify(finalOnchain, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}`);
  if (!marketFinalizedReported) {
    console.log("\nNo corrected-topic0 MarketFinalized ReactiveHit observed yet in this window.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
