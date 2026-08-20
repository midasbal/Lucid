// Step 2: pick the live binary market with the soonest expiry, read its book,
// and compute a model-fair YES probability against the opening price so the
// entry in step 3 is informed. Read-only, no orders.
import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { createExchange, loadConfig, resolveVenue, activeMarkets, marketOnchain, outcomeSymbols, MARKET_STATUS, shutdown } from "@dreamdex-bot-kit/ec-core";
import { getOpeningPrices } from "@somnia-chain/markets-sdk";
import { fairYesProbability } from "@dreamdex-bot-kit/ec-pricing";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function inferScale(rawNumericValue: number, referencePrice: number): number {
  const ratio = referencePrice / rawNumericValue;
  const exponent = Math.round(Math.log10(ratio));
  return 10 ** exponent;
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const cfg = loadConfig();
  const ecCtx = createExchange({ withSigner: false });
  await ecCtx.exchange.loadMarkets(true);
  await resolveVenue(ecCtx);

  const markets = await activeMarkets(ecCtx, { max: 1e6 });
  let soonest: { market: (typeof markets)[number]; onchain: Awaited<ReturnType<typeof marketOnchain>> } | null = null;

  for (const m of markets) {
    if (m.info.marketType !== "BINARY") continue;
    const onchain = await marketOnchain(ecCtx, m);
    if (!onchain || onchain.status !== MARKET_STATUS.Trading) continue;
    if (!soonest || !soonest.onchain || onchain.expiry < soonest.onchain.expiry) {
      soonest = { market: m, onchain };
    }
  }
  if (!soonest || !soonest.onchain) throw new Error("no live Trading market found");

  const { market, onchain } = soonest;
  const nowSec = Date.now() / 1000;
  const ttlSec = Number(onchain.expiry) - nowSec;

  console.log(`market   : ${market.symbol}`);
  console.log(`marketId : ${market.info.marketType === "BINARY" ? market.info.marketId : ""}`);
  console.log(`asset    : ${market.info.marketType === "BINARY" ? market.info.asset : ""}`);
  console.log(`ttl      : ${(ttlSec / 60).toFixed(2)} min`);

  const { yes, no } = outcomeSymbols(market);
  const book = await ecCtx.exchange.fetchOrderBook(yes, 5);
  console.log(`\nYES book (${yes}):`);
  console.log(`  bids: ${JSON.stringify(book.bids)}`);
  console.log(`  asks: ${JSON.stringify(book.asks)}`);

  const asset = market.info.marketType === "BINARY" ? market.info.asset : undefined;
  if (!asset) throw new Error("no asset field");

  const marketId = market.info.marketType === "BINARY" ? market.info.marketId : "";
  const openings = await getOpeningPrices([marketId], cfg.indexerUrl);
  const rawOpening = openings[marketId.toLowerCase()];
  if (rawOpening === null || rawOpening === undefined) throw new Error("no opening price answer yet for this market");

  const price = await ecCtx.exchange.fetchPrice(asset);
  if (!price) throw new Error(`fetchPrice(${asset}) returned null`);
  const spot = price.price;

  const scale = inferScale(Number(rawOpening), spot);
  const openingPrice = Number(rawOpening) * scale;

  console.log(`\nopening price (decoded, scale inferred x${scale}): ${openingPrice.toFixed(2)}`);
  console.log(`current spot (${asset})                        : ${spot.toFixed(2)}`);

  const timeToExpiryYears = ttlSec / (MS_PER_YEAR / 1000);
  const ASSUMED_VOL = 0.6; // annualized, documented placeholder per ec-pricing's realizedVol limitations
  const modelYes = fairYesProbability({ spot, openingPrice, timeToExpiryYears, volatility: ASSUMED_VOL });

  const yesBid = book.bids[0]?.[0];
  const yesAsk = book.asks[0]?.[0];
  const yesMid = yesBid !== undefined && yesAsk !== undefined ? (yesBid + yesAsk) / 2 : undefined;

  console.log(`\nmodel-fair YES (vol=${ASSUMED_VOL} placeholder): ${modelYes.toFixed(4)}`);
  if (yesMid !== undefined) {
    const edgeYes = modelYes - yesMid;
    console.log(`YES mid: ${yesMid.toFixed(4)}, edge (model - mid): ${edgeYes.toFixed(4)}`);
    console.log(`edge favors: ${edgeYes > 0 ? "YES (model thinks YES underpriced)" : "NO (model thinks YES overpriced, so NO underpriced)"}`);
  } else {
    console.log("book has no two-sided quote to compute a mid edge against.");
  }

  console.log(`\nNO outcome symbol: ${no}`);

  await shutdown(ecCtx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
