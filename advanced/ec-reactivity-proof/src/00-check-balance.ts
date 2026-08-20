import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { formatEther } from "viem";

const ctx = createChainContext();
const bal = await ctx.publicClient.getBalance({ address: ctx.account.address });
console.log("address:", ctx.account.address);
console.log("network:", ctx.net.name, ctx.net.chainId, ctx.net.rpcUrl);
console.log("balance (wei):", bal.toString());
console.log("balance:", formatEther(bal), ctx.net.nativeSymbol);
