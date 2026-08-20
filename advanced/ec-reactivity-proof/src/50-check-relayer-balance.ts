import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther } from "viem";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.resolve(__dirname, "../.env.relayer") });
process.env.PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
process.env.NETWORK = "testnet";

const { createChainContext } = await import("@dreamdex-bot-kit/core");
const ctx = createChainContext();
const bal = await ctx.publicClient.getBalance({ address: ctx.account.address });
console.log(`relayer address: ${ctx.account.address}`);
console.log(`relayer STT: ${formatEther(bal)}`);
