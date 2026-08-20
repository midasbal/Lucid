import "dotenv/config";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";

const ABI = parseAbi(["function isOperator(address owner, address spender) view returns (bool)"]);

const ctx = createChainContext();
const cfg = loadConfig();
const outcomeToken = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9" as `0x${string}`;
const module = cfg.addresses.binaryModule as `0x${string}`;

console.log(`owner (our EOA): ${ctx.account.address}`);
console.log(`outcomeToken: ${outcomeToken}`);
console.log(`module (live-resolved): ${module}`);

const isOp = await ctx.publicClient.readContract({ address: outcomeToken, abi: ABI, functionName: "isOperator", args: [ctx.account.address, module] });
console.log(`\nisOperator(owner, module) = ${isOp}`);
