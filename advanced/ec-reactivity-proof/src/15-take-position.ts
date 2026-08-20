// Step 3: take a small marketable position on the side the model edge favors.
// Re-resolves the market fresh (never reuse a stale snapshot right before a
// write) and reads back the resulting ERC-6909 balance as confirmation.
import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, resolveVenue, activeMarkets, marketOnchain, outcomeSymbols, MARKET_STATUS, placeLimit, shutdown } from "@dreamdex-bot-kit/ec-core";
import { toHuman } from "@somnia-chain/markets-sdk";

const TARGET_SYMBOL = "ETH-0-19AUG26-1600-46F1/tUSDC";
const OUTCOME = "YES" as const;
const TARGET_NOTIONAL_TUSDC = 5; // "a few tUSDC of notional"

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const ecCtx = createExchange({ withSigner: true });
  await ecCtx.exchange.loadMarkets(true);
  await resolveVenue(ecCtx);

  const markets = await activeMarkets(ecCtx, { max: 1e6 });
  const market = markets.find((m) => m.symbol === TARGET_SYMBOL);
  if (!market) throw new Error(`${TARGET_SYMBOL} is no longer active - re-run 14-pick-and-price.ts to pick a fresh target`);

  const onchain = await marketOnchain(ecCtx, market);
  if (!onchain || onchain.status !== MARKET_STATUS.Trading) {
    throw new Error(`market status is not Trading (status=${onchain?.status}) - re-pick a target`);
  }

  const { yes } = outcomeSymbols(market);
  const book = await ecCtx.exchange.fetchOrderBook(yes, 5);
  const bestAsk = book.asks[0]?.[0];
  if (bestAsk === undefined) throw new Error("no asks on the YES book - cannot take a marketable buy");

  const crossPrice = Math.min(bestAsk + 0.02, 0.99);
  const size = TARGET_NOTIONAL_TUSDC / crossPrice;

  console.log(`market      : ${market.symbol}`);
  console.log(`book        : bids=${JSON.stringify(book.bids)} asks=${JSON.stringify(book.asks)}`);
  console.log(`crossing at : ${crossPrice.toFixed(4)} (best ask ${bestAsk} + slippage)`);
  console.log(`size        : ${size.toFixed(4)} shares (~${TARGET_NOTIONAL_TUSDC} tUSDC notional)`);

  const result = await placeLimit(ecCtx, {
    market,
    onchain,
    outcome: OUTCOME,
    side: "buy",
    price: crossPrice,
    size,
    type: "ioc",
  });

  console.log(`\norder result: ${JSON.stringify(result)}`);
  if (result.filled === 0) {
    console.log("\nNo fill. Book may have moved or size snapped to zero. See order result above.");
    await shutdown(ecCtx);
    return;
  }

  await new Promise((r) => setTimeout(r, 2000));

  const balance = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.account.address, id: onchain.yesId });

  console.log(`\nposition confirmed:`);
  console.log(`  market       : ${market.symbol} (${market.info.marketType === "BINARY" ? market.info.marketId : ""})`);
  console.log(`  side         : ${OUTCOME}`);
  console.log(`  entry price  : ${result.price}`);
  console.log(`  filled size  : ${result.filled}`);
  console.log(`  tokenId (yesId, ERC-6909): ${onchain.yesId}`);
  console.log(`  outcomeToken (ERC-6909 singleton): ${onchain.outcomeToken}`);
  console.log(`  balance now  : ${toHuman(balance, cfg.decimals)} (raw ${balance})`);

  await shutdown(ecCtx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
