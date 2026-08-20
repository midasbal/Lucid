// Step 4: poll the deployed handler for a ReactiveHit, proving the precompile
// invoked it without us sending the triggering transaction. Polls until the
// counter increments or a timeout is hit (default 40 minutes, ~2 settlement
// cycles for a 15-minute-window market plus margin).
//
//   npx tsx src/04-verify.ts

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

const POLL_INTERVAL_MS = 15_000;
const TIMEOUT_MS = 40 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const handlerAddress = process.env.HANDLER_ADDRESS as `0x${string}` | undefined;
  if (!handlerAddress) throw new Error("HANDLER_ADDRESS not set - run 02-deploy.ts first.");

  const ctx = createChainContext();
  console.log(`watching handler ${handlerAddress} on ${ctx.net.name}`);

  const startBlock = await ctx.publicClient.getBlockNumber();
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const hitCount = await ctx.publicClient.readContract({ address: handlerAddress, abi: HANDLER_ABI, functionName: "hitCount" });
    const nowBlock = await ctx.publicClient.getBlockNumber();
    console.log(`[${new Date().toISOString()}] hitCount=${hitCount} block=${nowBlock}`);

    if (hitCount > 0n) {
      const logs = await ctx.publicClient.getContractEvents({
        address: handlerAddress,
        abi: HANDLER_ABI,
        eventName: "ReactiveHit",
        fromBlock: startBlock,
        toBlock: nowBlock,
      });
      const hit = logs[0];
      if (!hit) throw new Error("hitCount > 0 but no ReactiveHit log found in range - widen fromBlock.");

      console.log("\nReactiveHit fired.");
      console.log(`tx hash      : ${hit.transactionHash}`);
      console.log(`block number : ${hit.blockNumber}`);
      console.log(`args         : ${JSON.stringify(hit.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
      console.log(`explorer     : ${ctx.net.explorer}/tx/${hit.transactionHash}`);

      const receipt = await ctx.publicClient.getTransactionReceipt({ hash: hit.transactionHash });
      console.log(`gas used     : ${receipt.gasUsed}`);
      console.log(`from         : ${receipt.from}`);
      console.log(`to           : ${receipt.to}`);
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  console.log("\nTimed out without a ReactiveHit. See PROOF.md fallback reporting instructions.");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
