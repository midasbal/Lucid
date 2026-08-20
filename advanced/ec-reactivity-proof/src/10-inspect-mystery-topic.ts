import "dotenv/config";
import { toEventSelector } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";

const MYSTERY_TOPIC0 = "0xb1884334e955f8d8727678d4fa52dd9fc7140ff5e4ad38d358453bd400ada178";

// Candidate signatures to test against the mystery topic0: every event on
// BinarySettlement per the SDK source, plus the MODULE-level MarketFinalized
// (different contract in the SDK's own type system, but worth ruling out
// in case the deployed BinarySettlement's real ABI diverges from the SDK).
const candidates: { label: string; sig: string }[] = [
  { label: "settlement MarketFinalized (as subscribed)", sig: "MarketFinalized(uint256,address,uint64,address,uint256,bool,uint8)" },
  { label: "module MarketFinalized (bytes32,address,uint256)", sig: "MarketFinalized(bytes32,address,uint256)" },
  { label: "SettlementFeeCharged", sig: "SettlementFeeCharged(uint256,address,uint256,uint256)" },
  { label: "Redeemed", sig: "Redeemed(uint256,address,address,uint8,uint256,uint256)" },
  { label: "PayoutOwed", sig: "PayoutOwed(address,address,uint256)" },
  { label: "OwedClaimed", sig: "OwedClaimed(address,address,uint256)" },
];

async function main(): Promise<void> {
  for (const c of candidates) {
    const topic0 = toEventSelector(c.sig);
    console.log(`${topic0}  ${topic0 === MYSTERY_TOPIC0 ? "<== MATCH" : ""}  ${c.label}: ${c.sig}`);
  }

  const ctx = createChainContext();
  const cfg = loadConfig();
  const binarySettlement = cfg.addresses.binarySettlement as `0x${string}`;

  const logs: Awaited<ReturnType<typeof ctx.publicClient.getLogs>> = [];
  let cursor = 465796566n;
  const end = 465809166n;
  while (cursor <= end) {
    const to = cursor + 900n < end ? cursor + 900n : end;
    const chunk = await ctx.publicClient.getLogs({ address: binarySettlement, topics: [MYSTERY_TOPIC0 as `0x${string}`], fromBlock: cursor, toBlock: to } as Parameters<typeof ctx.publicClient.getLogs>[0]);
    logs.push(...chunk);
    cursor = to + 1n;
  }

  console.log(`\nfound ${logs.length} raw log(s) with this topic0`);
  for (const log of logs.slice(0, 2)) {
    console.log(`\nblock=${log.blockNumber} tx=${log.transactionHash}`);
    console.log(`topics (${log.topics.length}): ${JSON.stringify(log.topics)}`);
    console.log(`data length (bytes, excl 0x): ${(log.data.length - 2) / 2}`);
    console.log(`data: ${log.data}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
