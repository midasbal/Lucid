import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { parseAbi, encodeFunctionData } from "viem";

const AGENT = (process.env.CLEANUP_AGENT ?? "0x1c2224c0e69482c95c4cfbfa587211d3e0e70e6c") as `0x${string}`;
const GATE_ABI = parseAbi([
  "function cancelQuote(uint128 orderId)",
  "function bidOrderId() view returns (uint128)",
  "function askOrderId() view returns (uint128)",
]);

const ctx = createChainContext();
const MAX_FEE_PER_GAS = 60_000_000_000n;

async function realtimeSend(to: `0x${string}`, data: `0x${string}`) {
  const nonce = await ctx.publicClient.getTransactionCount({ address: ctx.account.address, blockTag: "pending" });
  const signed = await ctx.account.signTransaction!({
    type: "eip1559", chainId: ctx.walletClient.chain!.id, to, data, gas: 10_000_000n, nonce,
    maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: 0n, value: 0n,
  });
  const raw = await (ctx.publicClient.request as (a: unknown) => Promise<unknown>)({ method: "realtime_sendRawTransaction", params: [signed] });
  return (raw as { transactionHash?: `0x${string}`; hash?: `0x${string}` }).transactionHash ?? (raw as { hash: `0x${string}` }).hash;
}

const bidId = await ctx.publicClient.readContract({ address: AGENT, abi: GATE_ABI, functionName: "bidOrderId" });
const askId = await ctx.publicClient.readContract({ address: AGENT, abi: GATE_ABI, functionName: "askOrderId" });
console.log(`before: bidOrderId=${bidId} askOrderId=${askId}`);

if (bidId !== 0n) {
  try {
    const tx = await realtimeSend(AGENT, encodeFunctionData({ abi: GATE_ABI, functionName: "cancelQuote", args: [bidId] }));
    const r = await ctx.publicClient.waitForTransactionReceipt({ hash: tx! });
    console.log(`cancel bid tx=${tx} status=${r.status}`);
  } catch (e) { console.log(`cancel bid error: ${(e as Error).message.slice(0, 200)}`); }
}
if (askId !== 0n) {
  try {
    const tx = await realtimeSend(AGENT, encodeFunctionData({ abi: GATE_ABI, functionName: "cancelQuote", args: [askId] }));
    const r = await ctx.publicClient.waitForTransactionReceipt({ hash: tx! });
    console.log(`cancel ask tx=${tx} status=${r.status}`);
  } catch (e) { console.log(`cancel ask error: ${(e as Error).message.slice(0, 200)}`); }
}

const finalBid = await ctx.publicClient.readContract({ address: AGENT, abi: GATE_ABI, functionName: "bidOrderId" });
const finalAsk = await ctx.publicClient.readContract({ address: AGENT, abi: GATE_ABI, functionName: "askOrderId" });
console.log(`after: bidOrderId=${finalBid} askOrderId=${finalAsk}`);
process.exit(0);
