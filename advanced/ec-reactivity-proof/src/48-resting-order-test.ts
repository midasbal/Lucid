// Maker-gate item 1: place small resting post-only bids on both YES and NO,
// a few ticks below best bid so neither crosses, confirm both rest and show
// up via fetchOpenOrders, then cancel both. Records every tx hash.
import "dotenv/config";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, resolveVenue, activeMarkets, marketOnchain, outcomeSymbols, MARKET_STATUS, placeLimit, shutdown } from "@dreamdex-bot-kit/ec-core";

const TARGET_SYMBOL = "BTC-0-19AUG26-2000/tUSDC";
const TICKS_BELOW = 3;
const NOTIONAL_PER_SIDE = 3;

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
  if (!onchain || onchain.status !== MARKET_STATUS.Trading) throw new Error(`not Trading (status=${onchain?.status})`);
  console.log(`market: ${market.symbol}, pool: ${onchain.pool}`);

  const params = await ctx.publicClient.readContract({ address: onchain.pool, abi: BOOK_PARAMS_ABI, functionName: "getOrderBookParameters" });
  const tickHuman = Number(params.tickSize) / Number(10n ** BigInt(cfg.decimals));
  console.log(`live pool params: tick=${params.tickSize} (${tickHuman}) minQty=${params.minQuantity} lot=${params.lotSize}`);
  if (params.lotSize !== cfg.lot) {
    console.log(`MISMATCH vs ec-core config lot=${cfg.lot}: set MM_LOT=${params.lotSize} and re-run.`);
    process.exit(1);
  }

  const { yes, no } = outcomeSymbols(market);

  const yesBook = await ecCtx.exchange.fetchOrderBook(yes, 5);
  const noBook = await ecCtx.exchange.fetchOrderBook(no, 5);
  console.log(`\nYES book: bids=${JSON.stringify(yesBook.bids)} asks=${JSON.stringify(yesBook.asks)}`);
  console.log(`NO book: bids=${JSON.stringify(noBook.bids)} asks=${JSON.stringify(noBook.asks)}`);

  const yesBestBid = yesBook.bids[0]?.[0];
  const noBestBid = noBook.bids[0]?.[0];
  if (yesBestBid === undefined || noBestBid === undefined) throw new Error("one side has no bids to rest below");

  const yesRestPrice = Math.max(yesBestBid - TICKS_BELOW * tickHuman, tickHuman);
  const noRestPrice = Math.max(noBestBid - TICKS_BELOW * tickHuman, tickHuman);
  console.log(`\nYES best bid ${yesBestBid}, resting ${TICKS_BELOW} ticks below at ${yesRestPrice.toFixed(6)}`);
  console.log(`NO best bid ${noBestBid}, resting ${TICKS_BELOW} ticks below at ${noRestPrice.toFixed(6)}`);

  const yesSize = NOTIONAL_PER_SIDE / yesRestPrice;
  const noSize = NOTIONAL_PER_SIDE / noRestPrice;

  const yesOrder = await placeLimit(ecCtx, { market, onchain, outcome: "YES", side: "buy", price: yesRestPrice, size: yesSize, type: "post-only" });
  console.log(`\nYES resting order: rested=${yesOrder.rested} orderId=${yesOrder.orderId} price=${yesOrder.price} size=${yesOrder.size} hash=${yesOrder.hash}`);

  const noOrder = await placeLimit(ecCtx, { market, onchain, outcome: "NO", side: "buy", price: noRestPrice, size: noSize, type: "post-only" });
  console.log(`NO resting order: rested=${noOrder.rested} orderId=${noOrder.orderId} price=${noOrder.price} size=${noOrder.size} hash=${noOrder.hash}`);

  if (!yesOrder.rested || !noOrder.rested) {
    console.log("\nWARNING: at least one order did not rest (crossed and filled, or was rejected). Check book state above.");
  }

  await new Promise((r) => setTimeout(r, 2000));

  console.log(`\n=== fetchOpenOrders(${yes}) ===`);
  const yesOpen = await ecCtx.exchange.fetchOpenOrders(yes);
  console.log(JSON.stringify(yesOpen, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  console.log(`\n=== fetchOpenOrders(${no}) ===`);
  const noOpen = await ecCtx.exchange.fetchOpenOrders(no);
  console.log(JSON.stringify(noOpen, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  console.log(`\n=== Cancelling both ===`);
  if (yesOrder.orderId !== undefined) {
    const cancelYesRes = await ecCtx.exchange.trader.cancelOrder({ pool: onchain.pool, orderId: yesOrder.orderId });
    console.log(`cancel YES tx: ${cancelYesRes.hash}, status: ${cancelYesRes.receipt.status}`);
  }
  if (noOrder.orderId !== undefined) {
    const cancelNoRes = await ecCtx.exchange.trader.cancelOrder({ pool: onchain.pool, orderId: noOrder.orderId });
    console.log(`cancel NO tx: ${cancelNoRes.hash}, status: ${cancelNoRes.receipt.status}`);
  }

  await new Promise((r) => setTimeout(r, 2000));

  console.log(`\n=== fetchOpenOrders after cancel ===`);
  const yesOpenAfter = await ecCtx.exchange.fetchOpenOrders(yes);
  const noOpenAfter = await ecCtx.exchange.fetchOpenOrders(no);
  console.log(`YES open orders remaining: ${yesOpenAfter.length}`);
  console.log(`NO open orders remaining: ${noOpenAfter.length}`);

  await shutdown(ecCtx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
