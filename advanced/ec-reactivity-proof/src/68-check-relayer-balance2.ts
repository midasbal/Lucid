import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { formatEther } from "viem";
const ctx = createChainContext(process.env.RELAYER_PK as `0x${string}`);
const bal = await ctx.publicClient.getBalance({ address: ctx.account.address });
console.log(`relayer ${ctx.account.address}: ${formatEther(bal)} STT`);
process.exit(0);
