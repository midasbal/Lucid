import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";

const HANDLER_ABI = [
  { type: "function", name: "hitCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const ctx = createChainContext();
const handlerAddress = process.env.HANDLER_ADDRESS as `0x${string}`;
const hitCount = await ctx.publicClient.readContract({ address: handlerAddress, abi: HANDLER_ABI, functionName: "hitCount" });
const block = await ctx.publicClient.getBlockNumber();
console.log(`hitCount=${hitCount} block=${block}`);
