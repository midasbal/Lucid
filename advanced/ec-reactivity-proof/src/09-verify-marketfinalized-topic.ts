// Active verification: fetch every log BinarySettlement emitted over the
// last ~20 minutes, decode each with the full binarySettlementEventsAbi, and
// compare every MarketFinalized log's real topic0 against the one we
// subscribed with. Read-only, no transactions.
import "dotenv/config";
import { decodeEventLog, toEventSelector } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";

const OUR_MARKET_FINALIZED_TOPIC0 = "0xaa0d535f55946d4080e0c3a62bb1c53e2596353e9ab633fca0ce625fa518edc1";

// Transcribed verbatim from @somnia-chain/markets-sdk/src/eventsAbi.ts,
// binarySettlementEventsAbi, in full (all five events on this contract).
const BINARY_SETTLEMENT_EVENTS_ABI = [
  {
    type: "event",
    name: "MarketFinalized",
    inputs: [
      { name: "marketKey", type: "uint256", indexed: true },
      { name: "pool", type: "address", indexed: true },
      { name: "nonce", type: "uint64", indexed: false },
      { name: "collateralToken", type: "address", indexed: false },
      { name: "netBacking", type: "uint256", indexed: false },
      { name: "voided", type: "bool", indexed: false },
      { name: "winningOutcome", type: "uint8", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SettlementFeeCharged",
    inputs: [
      { name: "marketKey", type: "uint256", indexed: true },
      { name: "feeRecipient", type: "address", indexed: true },
      { name: "grossBacking", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Redeemed",
    inputs: [
      { name: "marketKey", type: "uint256", indexed: true },
      { name: "holder", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "outcomeIdx", type: "uint8", indexed: false },
      { name: "amountBurned", type: "uint256", indexed: false },
      { name: "collateralOut", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PayoutOwed",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwedClaimed",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
] as const;

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const binarySettlement = cfg.addresses.binarySettlement as `0x${string}`;
  console.log(`BinarySettlement (live-resolved): ${binarySettlement}`);

  console.log(`\nExpected topic0 for the event we transcribed as the settlement-singleton MarketFinalized:`);
  console.log(`  keccak256("MarketFinalized(uint256,address,uint64,address,uint256,bool,uint8)")`);
  console.log(`  = ${toEventSelector(BINARY_SETTLEMENT_EVENTS_ABI[0])}`);
  console.log(`  (this should equal the subscribed topic0: ${OUR_MARKET_FINALIZED_TOPIC0})`);

  const latest = await ctx.publicClient.getBlockNumber();
  const latestBlock = await ctx.publicClient.getBlock({ blockNumber: latest });
  const nowSec = latestBlock.timestamp;
  const windowSec = 20n * 60n;

  // Binary-search-ish: Somnia advertises ~100ms blocks, but don't trust
  // that for a precise range - walk backward by fixed chunks checking real
  // timestamps until we're outside the 20-minute window or hit genesis-ish.
  const CHUNK = 900n;
  let fromBlock = latest;
  for (let i = 0; i < 200; i++) {
    const probe = fromBlock > CHUNK ? fromBlock - CHUNK : 0n;
    const probeBlock = await ctx.publicClient.getBlock({ blockNumber: probe });
    fromBlock = probe;
    if (nowSec - probeBlock.timestamp >= windowSec || probe === 0n) break;
  }

  console.log(`\nscanning blocks ${fromBlock} to ${latest} (~last 20 minutes, block time ${latestBlock.timestamp - (await ctx.publicClient.getBlock({ blockNumber: fromBlock })).timestamp}s spanned)`);

  const allLogs: Awaited<ReturnType<typeof ctx.publicClient.getLogs>> = [];
  let cursor = fromBlock;
  while (cursor <= latest) {
    const to = cursor + CHUNK < latest ? cursor + CHUNK : latest;
    const logs = await ctx.publicClient.getLogs({ address: binarySettlement, fromBlock: cursor, toBlock: to });
    allLogs.push(...logs);
    cursor = to + 1n;
  }

  console.log(`\nfound ${allLogs.length} total log(s) from BinarySettlement in the window\n`);

  const byTopic0 = new Map<string, number>();
  const marketFinalizedLogs: typeof allLogs = [];

  for (const log of allLogs) {
    const topic0 = log.topics[0] ?? "(none)";
    byTopic0.set(topic0, (byTopic0.get(topic0) ?? 0) + 1);

    try {
      const decoded = decodeEventLog({ abi: BINARY_SETTLEMENT_EVENTS_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "MarketFinalized") marketFinalizedLogs.push(log);
    } catch {
      // topic0 not decodable against this ABI, left in byTopic0 for reporting
    }
  }

  console.log("log counts by topic0:");
  for (const [topic0, count] of byTopic0) {
    let name = "(undecoded against binarySettlementEventsAbi)";
    for (const item of BINARY_SETTLEMENT_EVENTS_ABI) {
      if (toEventSelector(item) === topic0) name = item.name;
    }
    console.log(`  ${topic0}  x${count}  ${name}`);
  }

  console.log(`\nMarketFinalized logs found: ${marketFinalizedLogs.length}`);
  for (const log of marketFinalizedLogs) {
    const decoded = decodeEventLog({ abi: BINARY_SETTLEMENT_EVENTS_ABI, data: log.data, topics: log.topics });
    console.log(`  block=${log.blockNumber} tx=${log.transactionHash} topic0=${log.topics[0]}`);
    console.log(`    args=${JSON.stringify(decoded.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    console.log(`    topic0 matches our subscription: ${log.topics[0] === OUR_MARKET_FINALIZED_TOPIC0}`);
  }

  if (marketFinalizedLogs.length === 0) {
    console.log("\nNo MarketFinalized logs at all in this window despite other BinarySettlement activity above.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
