// Read-only Gate A verification dump: resolves the live venue, picks one
// active binary event-contract market, and prints its full row shape,
// order book, and underlying price feed reading. Sends no transactions.
//
//   NETWORK=testnet npx tsx scripts/gate-a-dump.ts

import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const { createExchange, loadConfig, shutdown, resolveVenue, activeMarkets, marketOnchain, outcomeSymbols } =
  await import("@dreamdex-bot-kit/ec-core");

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ctx = createExchange({ withSigner: false });
  await ctx.exchange.loadMarkets(true);

  const resolved = await resolveVenue(ctx);
  console.log(`network : ${cfg.network} (chain ${cfg.chainId})`);
  console.log(`venue   : ${JSON.stringify(resolved.scope)} source=${resolved.source} scoped active=${resolved.markets}`);

  const markets = await activeMarkets(ctx, { max: 1 });
  const market = markets[0];
  if (!market) {
    console.log("\nNo active binary market found. GATE A: BLOCKED (no live market to inspect).");
    await shutdown(ctx);
    return;
  }

  console.log("\n===== RAW UnifiedMarket ROW =====");
  console.log(JSON.stringify(market, (_k, v) => (typeof v === "bigint" ? v.toString() + "n" : v), 2));

  const onchain = await marketOnchain(ctx, market);
  console.log("\n===== RAW MarketOnchain SNAPSHOT (getMarketOnchain) =====");
  console.log(JSON.stringify(onchain, (_k, v) => (typeof v === "bigint" ? v.toString() + "n" : v), 2));

  const { yes } = outcomeSymbols(market);
  console.log(`\n===== fetchOrderBook(${JSON.stringify(yes)}, 5) =====`);
  const book = await ctx.exchange.fetchOrderBook(yes, 5);
  console.log(JSON.stringify(book, (_k, v) => (typeof v === "bigint" ? v.toString() + "n" : v), 2));

  const asset = market.info.marketType === "BINARY" ? market.info.asset : undefined;
  if (asset) {
    console.log(`\n===== fetchPrice(${JSON.stringify(asset)}) =====`);
    try {
      const price = await ctx.exchange.fetchPrice(asset);
      console.log(JSON.stringify(price, (_k, v) => (typeof v === "bigint" ? v.toString() + "n" : v), 2));
    } catch (e) {
      console.log(`fetchPrice threw: ${(e as Error).message}`);
    }
  } else {
    console.log("\nNo `asset` field found on market.info - cannot call fetchPrice.");
  }

  await shutdown(ctx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
