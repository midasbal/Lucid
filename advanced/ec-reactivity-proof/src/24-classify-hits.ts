// Classify every ReactiveHit log by topic0, and decode one MarketFinalized
// hit (if any) directly from its raw log data.
import "dotenv/config";
import { decodeEventLog } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";

const HANDLER_ABI = [
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

const MARKET_FINALIZED_TOPIC0 = "0xb1884334e955f8d8727678d4fa52dd9fc7140ff5e4ad38d358453bd400ada178";
const REDEEMED_TOPIC0 = "0xe31682dd835b7d7bcc4d22f343666af1cc50614bfa16f510ed812ad4ed56f3b4";

const MARKET_FINALIZED_ABI_ITEM = {
  type: "event",
  name: "MarketFinalized",
  inputs: [
    { name: "marketKey", type: "uint256", indexed: true },
    { name: "pool", type: "address", indexed: true },
    { name: "nonce", type: "uint64", indexed: false },
    { name: "collateralToken", type: "address", indexed: false },
    { name: "netBacking", type: "uint256", indexed: false },
    { name: "voided", type: "bool", indexed: false },
    { name: "payoutNumerators", type: "uint256[]", indexed: false },
  ],
  anonymous: false,
} as const;

async function main(): Promise<void> {
  const ctx = createChainContext();
  loadConfig();
  const handlerAddress = process.env.HANDLER_ADDRESS as `0x${string}`;

  const latest = await ctx.publicClient.getBlockNumber();
  // Handler deployed around block 465798xxx per earlier proof; scan from there.
  const from = 465798800n;

  type ReactiveHitLog = Awaited<ReturnType<typeof ctx.publicClient.getContractEvents<typeof HANDLER_ABI, "ReactiveHit">>>[number];
  const logs: ReactiveHitLog[] = [];
  let cursor = from;
  while (cursor <= latest) {
    const to = cursor + 900n < latest ? cursor + 900n : latest;
    const chunk = await ctx.publicClient.getContractEvents({
      address: handlerAddress,
      abi: HANDLER_ABI,
      eventName: "ReactiveHit",
      fromBlock: cursor,
      toBlock: to,
    });
    logs.push(...chunk);
    cursor = to + 1n;
  }

  console.log(`total ReactiveHit logs: ${logs.length}`);

  const counts = new Map<string, number>();
  const marketFinalizedLogs: typeof logs = [];
  for (const log of logs) {
    const topic0 = log.args.topic0 as string;
    counts.set(topic0, (counts.get(topic0) ?? 0) + 1);
    if (topic0 === MARKET_FINALIZED_TOPIC0) marketFinalizedLogs.push(log);
  }

  console.log("\ncounts by topic0:");
  for (const [topic0, count] of counts) {
    const label = topic0 === MARKET_FINALIZED_TOPIC0 ? "MarketFinalized (corrected)" : topic0 === REDEEMED_TOPIC0 ? "Redeemed" : "(other)";
    console.log(`  ${topic0}  x${count}  ${label}`);
  }

  console.log(`\nMarketFinalized hits: ${marketFinalizedLogs.length}`);
  if (marketFinalizedLogs.length > 0) {
    const first = marketFinalizedLogs[0];
    if (!first) throw new Error("unreachable");
    const emitter = (first.args as { emitter: `0x${string}` }).emitter;

    const underlyingLogs = await ctx.publicClient.getLogs({
      address: emitter,
      topics: [MARKET_FINALIZED_TOPIC0 as `0x${string}`],
      fromBlock: first.blockNumber! - 5n,
      toBlock: first.blockNumber! + 5n,
    } as Parameters<typeof ctx.publicClient.getLogs>[0]);

    const target = underlyingLogs.find((l) => l.blockNumber === first.blockNumber);
    if (target) {
      const decoded = decodeEventLog({ abi: [MARKET_FINALIZED_ABI_ITEM], data: target.data, topics: target.topics });
      console.log(`\ndecoded first MarketFinalized hit (handler tx ${first.transactionHash}):`);
      console.log(`  underlying settlement tx: ${target.transactionHash}`);
      console.log(`  args: ${JSON.stringify(decoded.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      const pool = (decoded.args as unknown as { pool: `0x${string}` }).pool;
      console.log(`  pool (identifies the market): ${pool}`);
      console.log(`  explorer: ${ctx.net.explorer}/tx/${first.transactionHash}`);
    } else {
      console.log("could not re-locate the underlying settlement log by block number");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
