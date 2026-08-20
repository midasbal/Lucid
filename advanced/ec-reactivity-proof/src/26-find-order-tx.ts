import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";

const POOL = "0x354a1Cb845D9A2562b079023f614B1e93344A790" as `0x${string}`;
const OUR_ADDRESS = "0xE4eA8b4FC1BBFf290f3Dbd29CE8471348de860dB".toLowerCase();

async function main(): Promise<void> {
  const ctx = createChainContext();
  // Position taken well before finalization at block 465825260; search a
  // window before that.
  const to = 465825260n;
  const from = to - 3000n;

  let cursor = from;
  while (cursor <= to) {
    const chunkTo = cursor + 900n < to ? cursor + 900n : to;
    const block = await ctx.publicClient.getBlock({ blockNumber: chunkTo, includeTransactions: false });
    void block;
    const txs = await ctx.publicClient.getLogs({ address: POOL, fromBlock: cursor, toBlock: chunkTo });
    for (const log of txs) {
      const tx = await ctx.publicClient.getTransaction({ hash: log.transactionHash });
      if (tx.from.toLowerCase() === OUR_ADDRESS) {
        console.log(`found: tx=${log.transactionHash} block=${log.blockNumber} from=${tx.from} to=${tx.to}`);
      }
    }
    cursor = chunkTo + 1n;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
