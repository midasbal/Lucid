import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";
import { Reactivity } from "@somnia-chain/reactivity";
import { formatEther, toEventSelector } from "viem";

const ctx = createChainContext();
const cfg = loadConfig();

const HANDLER = "0x0fb364ecb91e5e4e8c5aa623b28df723387b54d1" as `0x${string}`;
const SUBSCRIPTION_ID = 13104907n;
const OWNER = "0xE4eA8b4FC1BBFf290f3Dbd29CE8471348de860dB" as `0x${string}`;
const SETTLEMENT = cfg.addresses.binarySettlement as `0x${string}`;

console.log("=== handler code check ===");
const code = await ctx.publicClient.getCode({ address: HANDLER });
console.log(`handler ${HANDLER} has code: ${!!code && code !== "0x"}`);

console.log("\n=== subscription check ===");
const reactivity = new Reactivity({ public: ctx.publicClient, wallet: ctx.walletClient });
try {
  const info = await reactivity.getSubscriptionInfo(SUBSCRIPTION_ID);
  console.log(JSON.stringify(info, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const finalizedTopic = toEventSelector("MarketFinalized(uint256,address,uint64,address,uint256,bool,uint256[])");
  const sd = (info as any).subscriptionData ?? (info as any)[0];
  const owner = (info as any).owner ?? (info as any)[1];
  console.log(`subscribed emitter matches BinarySettlement: ${sd.emitter?.toLowerCase() === SETTLEMENT.toLowerCase()}`);
  console.log(`subscribed topic matches MarketFinalized (corrected): ${sd.eventTopics?.[0]?.toLowerCase() === finalizedTopic.toLowerCase()}`);
  console.log(`handlerContractAddress matches: ${sd.handlerContractAddress?.toLowerCase() === HANDLER.toLowerCase()}`);
  console.log(`subscription owner: ${owner}`);
} catch (e) {
  console.log(`getSubscriptionInfo failed: ${(e as Error).message.slice(0, 300)}`);
}

console.log("\n=== owner floor check ===");
const bal = await ctx.publicClient.getBalance({ address: OWNER });
console.log(`owner ${OWNER} balance: ${formatEther(bal)} STT (need >= 32)`);
process.exit(0);
