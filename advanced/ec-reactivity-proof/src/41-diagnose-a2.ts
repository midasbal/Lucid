import "dotenv/config";
import { decodeEventLog } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, MARKET_STATUS } from "@dreamdex-bot-kit/ec-core";

const MARKET_ID = "0x0000000000000000000000000000000000000000000000000000000000004702" as `0x${string}`;
const POOL = "0xC3fc705100CFbcCBf1032c4c5E820E6210017de7" as `0x${string}`;
const CORRECTED_TOPIC0 = "0xb1884334e955f8d8727678d4fa52dd9fc7140ff5e4ad38d358453bd400ada178" as const;

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
  const cfg = loadConfig();
  const ecCtx = createExchange({ withSigner: false });

  console.log("=== 1. Live market status (getMarketOnchain) ===");
  const onchain = await ecCtx.exchange.client.getMarketOnchain(MARKET_ID);
  console.log(JSON.stringify(onchain, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const statusName = Object.keys(MARKET_STATUS).find((k) => MARKET_STATUS[k as keyof typeof MARKET_STATUS] === onchain?.status);
  console.log(`status: ${statusName}`);
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`now: ${nowSec}, expiry: ${onchain?.expiry}, diff: ${Number(onchain?.expiry ?? 0n) - nowSec}s`);

  console.log("\n=== 2. Searching BinarySettlement logs for this pool ===");
  const binarySettlement = cfg.addresses.binarySettlement as `0x${string}`;
  const latest = await ctx.publicClient.getBlockNumber();

  async function findBlockNear(targetTimestampSec: bigint): Promise<bigint> {
    let hi = latest;
    let lo = hi > 200_000n ? hi - 200_000n : 0n;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const block = await ctx.publicClient.getBlock({ blockNumber: mid });
      if (block.timestamp < targetTimestampSec) lo = mid + 1n;
      else hi = mid;
    }
    return lo;
  }

  const from = onchain ? await findBlockNear(onchain.expiry - 120n) : (latest - 3000n > 0n ? latest - 3000n : 0n);
  console.log(`search window: block ${from} to ${latest}`);

  const allLogs: Awaited<ReturnType<typeof ctx.publicClient.getLogs>> = [];
  let cursor = from;
  while (cursor <= latest) {
    const to = cursor + 900n < latest ? cursor + 900n : latest;
    const chunk = await ctx.publicClient.getLogs({ address: binarySettlement, fromBlock: cursor, toBlock: to });
    allLogs.push(...chunk);
    cursor = to + 1n;
  }
  const logs = allLogs.filter((l) => l.topics[0] === CORRECTED_TOPIC0);

  console.log(`fetched ${allLogs.length} total BinarySettlement log(s), ${logs.length} MarketFinalized (filtered client-side)`);
  let foundOurs = false;
  for (const log of logs) {
    const decoded = decodeEventLog({ abi: [MARKET_FINALIZED_ABI_ITEM], data: log.data, topics: log.topics });
    const args = decoded.args as unknown as { pool: `0x${string}`; nonce: bigint; payoutNumerators: readonly bigint[] };
    if (args.pool.toLowerCase() === POOL.toLowerCase()) {
      console.log(`MATCH for our pool: tx=${log.transactionHash} block=${log.blockNumber} nonce=${args.nonce} payoutNumerators=${JSON.stringify(args.payoutNumerators.map(String))}`);
      foundOurs = true;
    }
  }
  if (!foundOurs) {
    console.log("No MarketFinalized log found for our pool in the searched window.");
  }

  console.log("\n=== 3. Diagnosis ===");
  if (onchain?.finalized) {
    console.log("Market IS finalized on-chain (finalized=true).");
    if (!foundOurs) console.log("But no matching MarketFinalized log was found in the search window - widen the window or check topic0.");
  } else if (onchain && onchain.status === MARKET_STATUS.Locked) {
    console.log("Market is Locked (window ended, awaiting settlement price) but not yet finalized.");
    console.log("This is the state where pokeOracle() or voidExpired() would eventually matter if the oracle answer never lands.");
  } else if (onchain && onchain.status === MARKET_STATUS.Trading) {
    console.log("Market is still Trading - expiry has not actually passed yet, or the on-chain clock disagrees with wall clock.");
  } else {
    console.log(`Market status is ${statusName}, not yet finalized.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
