import "dotenv/config";
import { decodeAbiParameters, toEventSelector } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";

const MYSTERY_TOPIC0 = "0xb1884334e955f8d8727678d4fa52dd9fc7140ff5e4ad38d358453bd400ada178";

async function main(): Promise<void> {
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

  const log = logs[0];
  if (!log) throw new Error("no logs found");

  console.log(`tx=${log.transactionHash}`);
  console.log(`topics[1] (marketKey?): ${log.topics[1]}`);
  console.log(`topics[2] (pool?):      ${log.topics[2]}`);
  console.log(`data: ${log.data}\n`);

  // Print raw 32-byte words.
  const hex = log.data.slice(2);
  const words: string[] = [];
  for (let i = 0; i < hex.length; i += 64) words.push(hex.slice(i, i + 64));
  words.forEach((w, i) => console.log(`word[${i}] (offset ${i * 32}): 0x${w}`));

  console.log("\nTrying decode as (uint64 nonce, address collateralToken, uint256 netBacking, bool voided, uint256[] payoutNumerators):");
  try {
    const decoded = decodeAbiParameters(
      [
        { name: "nonce", type: "uint64" },
        { name: "collateralToken", type: "address" },
        { name: "netBacking", type: "uint256" },
        { name: "voided", type: "bool" },
        { name: "payoutNumerators", type: "uint256[]" },
      ],
      log.data,
    );
    console.log(JSON.stringify(decoded, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

    const sig = "MarketFinalized(uint256,address,uint64,address,uint256,bool,uint256[])";
    console.log(`\ntopic0 for MarketFinalized(uint256,address,uint64,address,uint256,bool,uint256[]): ${toEventSelector(sig)}`);
    console.log(`matches mystery topic0: ${toEventSelector(sig) === MYSTERY_TOPIC0}`);
  } catch (e) {
    console.log("failed:", (e as Error).message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
