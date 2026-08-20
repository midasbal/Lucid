import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";

const POOL = "0x354a1Cb845D9A2562b079023f614B1e93344A790" as `0x${string}`;

const ORDER_FILLED_ABI = [
  {
    type: "event",
    name: "OrderFilled",
    inputs: [
      { name: "takerOrderId", type: "uint128", indexed: true },
      { name: "makerOrderId", type: "uint128", indexed: true },
      { name: "quantityFilled", type: "uint256", indexed: false },
      { name: "takerRemainingQuantity", type: "uint256", indexed: false },
      { name: "makerRemainingQuantity", type: "uint256", indexed: false },
      { name: "fillPrice", type: "uint256", indexed: false },
    ],
  },
] as const;

async function main(): Promise<void> {
  const ctx = createChainContext();
  const to = 465825260n;
  const from = to - 6000n;

  const logs: Awaited<ReturnType<typeof ctx.publicClient.getContractEvents<typeof ORDER_FILLED_ABI, "OrderFilled">>> = [];
  let cursor = from;
  while (cursor <= to) {
    const chunkTo = cursor + 900n < to ? cursor + 900n : to;
    const chunk = await ctx.publicClient.getContractEvents({
      address: POOL,
      abi: ORDER_FILLED_ABI,
      eventName: "OrderFilled",
      fromBlock: cursor,
      toBlock: chunkTo,
    });
    logs.push(...chunk);
    cursor = chunkTo + 1n;
  }

  console.log(`found ${logs.length} OrderFilled logs in window`);
  const byTx = new Map<string, bigint>();
  for (const log of logs) {
    const cur = byTx.get(log.transactionHash) ?? 0n;
    byTx.set(log.transactionHash, cur + log.args.quantityFilled!);
  }

  for (const [tx, total] of byTx) {
    if (total === 10121000n) {
      console.log(`MATCH: tx=${tx} total quantityFilled=${total}`);
    }
  }

  console.log("\nall tx totals:");
  for (const [tx, total] of byTx) console.log(`  ${tx}: ${total}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
