import "dotenv/config";
import { formatEther } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, marketOnchain, MARKET_STATUS, shutdown } from "@dreamdex-bot-kit/ec-core";

async function main(): Promise<void> {
  const ctx = createChainContext();
  const balance = await ctx.publicClient.getBalance({ address: ctx.account.address });
  console.log(`subscriber balance now: ${formatEther(balance)} ${ctx.net.nativeSymbol}`);

  const marketId = "0x00000000000000000000000000000000000000000000000000000000000046eb" as `0x${string}`;
  const ecCtx = createExchange({ withSigner: false });
  const onchain = await ecCtx.exchange.client.getMarketOnchain(marketId);
  console.log("\ntargeted market onchain snapshot:");
  console.log(JSON.stringify(onchain, (_k, v) => (typeof v === "bigint" ? v.toString() + "n" : v), 2));
  const statusName = Object.keys(MARKET_STATUS).find((k) => MARKET_STATUS[k as keyof typeof MARKET_STATUS] === onchain?.status);
  console.log(`status name: ${statusName}`);

  await shutdown(ecCtx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
