// Phase A step 1: take a small position on BOTH sides of one live market so
// one side is guaranteed to win. Deterministic test device, not the product
// flow. Re-checks the pool's live lot/tick size first (the lot-size bug from
// LIFECYCLE.md), rather than trusting a config default.
import "dotenv/config";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, resolveVenue, activeMarkets, marketOnchain, outcomeSymbols, MARKET_STATUS, placeLimit, shutdown } from "@dreamdex-bot-kit/ec-core";
import { toHuman } from "@somnia-chain/markets-sdk";

const TARGET_SYMBOL = "BTC-0-19AUG26-1800/tUSDC";
const NOTIONAL_PER_SIDE = 3; // small, "a little YES and a little NO"

const BOOK_PARAMS_ABI = parseAbi(["function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))"]);

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const ecCtx = createExchange({ withSigner: true });
  await ecCtx.exchange.loadMarkets(true);
  await resolveVenue(ecCtx);

  const markets = await activeMarkets(ecCtx, { max: 1e6 });
  const market = markets.find((m) => m.symbol === TARGET_SYMBOL);
  if (!market) throw new Error(`${TARGET_SYMBOL} not active`);

  const onchain = await marketOnchain(ecCtx, market);
  if (!onchain || onchain.status !== MARKET_STATUS.Trading) throw new Error(`market not Trading (status=${onchain?.status})`);

  const params = await ctx.publicClient.readContract({ address: onchain.pool, abi: BOOK_PARAMS_ABI, functionName: "getOrderBookParameters" });
  console.log(`live pool params: tick=${params.tickSize} minQty=${params.minQuantity} lot=${params.lotSize}`);
  console.log(`ec-core config lot (for comparison): ${cfg.lot}, tick: ${cfg.tick}`);
  if (params.lotSize !== cfg.lot) {
    console.log(`MISMATCH: set MM_LOT=${params.lotSize} in .env before running this script, then re-run.`);
    process.exit(1);
  }

  const { yes, no } = outcomeSymbols(market);

  const book = await ecCtx.exchange.fetchOrderBook(yes, 5);
  console.log(`\nYES book: bids=${JSON.stringify(book.bids)} asks=${JSON.stringify(book.asks)}`);
  const bestAsk = book.asks[0]?.[0];
  const bestBid = book.bids[0]?.[0];
  if (bestAsk === undefined || bestBid === undefined) throw new Error("book not two-sided");

  // Buy YES crossing the ask.
  const yesCrossPrice = Math.min(bestAsk + 0.02, 0.98);
  const yesSize = NOTIONAL_PER_SIDE / yesCrossPrice;
  console.log(`\nbuying YES: price=${yesCrossPrice.toFixed(4)} size=${yesSize.toFixed(4)}`);
  const yesResult = await placeLimit(ecCtx, { market, onchain, outcome: "YES", side: "buy", price: yesCrossPrice, size: yesSize, type: "ioc" });
  console.log(`YES result: filled=${yesResult.filled} price=${yesResult.price} hash=${yesResult.hash}`);

  // Buy NO crossing its own ask (NO price = 1 - YES bid, but placeLimit
  // takes NO's own price directly; read NO's book instead of inverting).
  const noBook = await ecCtx.exchange.fetchOrderBook(no, 5);
  console.log(`\nNO book: bids=${JSON.stringify(noBook.bids)} asks=${JSON.stringify(noBook.asks)}`);
  const noBestAsk = noBook.asks[0]?.[0];
  if (noBestAsk === undefined) throw new Error("NO book has no asks");
  const noCrossPrice = Math.min(noBestAsk + 0.02, 0.98);
  const noSize = NOTIONAL_PER_SIDE / noCrossPrice;
  console.log(`\nbuying NO: price=${noCrossPrice.toFixed(4)} size=${noSize.toFixed(4)}`);
  const noResult = await placeLimit(ecCtx, { market, onchain, outcome: "NO", side: "buy", price: noCrossPrice, size: noSize, type: "ioc" });
  console.log(`NO result: filled=${noResult.filled} price=${noResult.price} hash=${noResult.hash}`);

  await new Promise((r) => setTimeout(r, 2000));

  const yesBal = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.account.address, id: onchain.yesId });
  const noBal = await ecCtx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: ctx.account.address, id: onchain.noId });

  console.log(`\n=== POSITIONS ===`);
  console.log(`market: ${market.symbol}`);
  console.log(`marketId: ${market.info.marketType === "BINARY" ? market.info.marketId : ""}`);
  console.log(`pool: ${onchain.pool}, nonce: ${onchain.nonce}`);
  console.log(`YES balance: ${toHuman(yesBal, cfg.decimals)} (raw ${yesBal}), yesId: ${onchain.yesId}`);
  console.log(`NO balance: ${toHuman(noBal, cfg.decimals)} (raw ${noBal}), noId: ${onchain.noId}`);
  console.log(`outcomeToken: ${onchain.outcomeToken}`);
  console.log(`expiry: ${onchain.expiry}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
