// Watches specifically for a ReactiveHit whose topic0 matches MarketFinalized
// (as opposed to 04-verify.ts, which stops at the first hit of any kind).
// Polls until found or a timeout is hit.
import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";

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

const MARKET_FINALIZED_TOPIC0 = "0xaa0d535f55946d4080e0c3a62bb1c53e2596353e9ab633fca0ce625fa518edc1";
const POLL_INTERVAL_MS = 20_000;
const TIMEOUT_MS = 35 * 60 * 1000;
const MAX_RANGE = 900n;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const handlerAddress = process.env.HANDLER_ADDRESS as `0x${string}`;
  const ctx = createChainContext();
  console.log(`watching handler ${handlerAddress} for a MarketFinalized-topic ReactiveHit`);

  let cursor = await ctx.publicClient.getBlockNumber();
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const latest = await ctx.publicClient.getBlockNumber();
    let from = cursor;
    while (from <= latest) {
      const to = from + MAX_RANGE < latest ? from + MAX_RANGE : latest;
      const logs = await ctx.publicClient.getContractEvents({
        address: handlerAddress,
        abi: HANDLER_ABI,
        eventName: "ReactiveHit",
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        if (log.args.topic0 === MARKET_FINALIZED_TOPIC0) {
          const receipt = await ctx.publicClient.getTransactionReceipt({ hash: log.transactionHash });
          const tx = await ctx.publicClient.getTransaction({ hash: log.transactionHash });
          console.log("\nMarketFinalized-topic ReactiveHit fired.");
          console.log(`tx hash  : ${log.transactionHash}`);
          console.log(`block    : ${log.blockNumber}`);
          console.log(`args     : ${JSON.stringify(log.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
          console.log(`from     : ${receipt.from}`);
          console.log(`nonce    : ${tx.nonce}`);
          console.log(`gasUsed  : ${receipt.gasUsed}`);
          console.log(`explorer : ${ctx.net.explorer}/tx/${log.transactionHash}`);
          return;
        }
      }
      from = to + 1n;
    }
    cursor = latest + 1n;
    const hitCount = await ctx.publicClient.readContract({ address: handlerAddress, abi: HANDLER_ABI, functionName: "hitCount" });
    console.log(`[${new Date().toISOString()}] scanned to block ${latest}, hitCount=${hitCount}, no MarketFinalized hit yet`);
    await sleep(POLL_INTERVAL_MS);
  }

  console.log("\nTimed out waiting for a MarketFinalized-topic hit.");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
