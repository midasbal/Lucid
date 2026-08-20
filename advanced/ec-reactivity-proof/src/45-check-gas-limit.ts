import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { SomniaReactivityPrecompileABI } from "@somnia-chain/reactivity";

const PRECOMPILE = "0x0000000000000000000000000000000000000100" as const;
const SUBSCRIPTION_ID = 13104907n;

const ctx = createChainContext();
const info = await ctx.publicClient.readContract({
  address: PRECOMPILE,
  abi: SomniaReactivityPrecompileABI,
  functionName: "getSubscriptionInfo",
  args: [SUBSCRIPTION_ID],
});
console.log(JSON.stringify(info, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
