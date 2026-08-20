import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";

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

async function main(): Promise<void> {
  const handlerAddress = process.env.HANDLER_ADDRESS as `0x${string}`;
  const ctx = createChainContext();

  const logs = await ctx.publicClient.getContractEvents({
    address: handlerAddress,
    abi: HANDLER_ABI,
    eventName: "ReactiveHit",
    fromBlock: 465798861n,
    toBlock: 465799700n,
  });

  console.log(`found ${logs.length} ReactiveHit log(s)\n`);

  for (const log of logs) {
    const tx = await ctx.publicClient.getTransaction({ hash: log.transactionHash });
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: log.transactionHash });
    console.log(`--- tx ${log.transactionHash} ---`);
    console.log(`args         : ${JSON.stringify(log.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    console.log(`block number : ${log.blockNumber}`);
    console.log(`tx.from      : ${tx.from}`);
    console.log(`tx.to        : ${tx.to}`);
    console.log(`tx.nonce     : ${tx.nonce}`);
    console.log(`tx.type      : ${tx.type}`);
    console.log(`tx.input     : ${tx.input.slice(0, 74)}...`);
    console.log(`receipt.gasUsed : ${receipt.gasUsed}`);
    console.log("");
  }

  const ourNonce = await ctx.publicClient.getTransactionCount({ address: ctx.account.address });
  console.log(`our account's current regular nonce (eth_getTransactionCount): ${ourNonce}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
