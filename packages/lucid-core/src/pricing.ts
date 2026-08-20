// Live model-fair value, wired to ec-pricing's pure pricer plus live spot,
// live opening price, live time-to-expiry, and a live realized-vol estimate.
// Returned side by side with the live book so a caller sees fair value and
// market price in one call, exactly what the maker's requote decision needs.

import { fairYesProbability, estimateRealizedVol, type PriceSample } from "@dreamdex-bot-kit/ec-pricing";
import type { UnifiedMarket } from "@somnia-chain/markets-sdk";
import type { LucidContext } from "./context.js";
import { getMarketDefinition, getOrderBook, type LiveBook, type MarketDefinition } from "./market.js";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export interface FairValueResult {
  definition: MarketDefinition;
  book: LiveBook;
  spot: number;
  volatility: number;
  volatilitySource: "estimated" | "fallback";
  fairYes: number;
  /** fairYes minus the book's own mid, when the book is two-sided. */
  edgeVsMid?: number;
}

export interface FairValueOptions {
  /** Used when the realized-vol estimator declines to answer (too few samples for this short a window). */
  fallbackVolatility?: number;
}

/**
 * Model-fair YES for one market, plus the live book alongside it. Every
 * input, spot, opening price, ttl, vol, is resolved live this call; nothing
 * here is cached across calls.
 */
export async function getFairValueWithBook(ctx: LucidContext, market: UnifiedMarket, opts: FairValueOptions = {}): Promise<FairValueResult> {
  if (market.info.marketType !== "BINARY") throw new Error("not a binary market");
  const asset = market.info.asset;
  if (!asset) throw new Error("market has no asset field");

  const definition = await getMarketDefinition(ctx, market);
  if (definition.openingPrice === null) throw new Error(`${market.symbol}: no opening price answer yet`);

  const book = await getOrderBook(ctx, market);

  const price = await ctx.exchange.fetchPrice(asset);
  if (!price) throw new Error(`fetchPrice(${asset}) returned null`);
  const spot = price.price;

  const ohlcv = await ctx.exchange.fetchPriceOHLCV(asset, "1m", Date.now() - 2 * 60 * 60 * 1000, 500);
  const samples: PriceSample[] = ohlcv.map(([ms, , , , close]) => ({ price: close, timestampMs: ms }));
  const estimated = estimateRealizedVol(samples);
  const fallbackVol = opts.fallbackVolatility ?? 0.6;
  const volatility = estimated ?? fallbackVol;

  const ttlSec = Number(definition.expiry) - Date.now() / 1000;
  const timeToExpiryYears = Math.max(ttlSec, 1) / (MS_PER_YEAR / 1000);

  const fairYes = fairYesProbability({ spot, openingPrice: definition.openingPrice, timeToExpiryYears, volatility });

  const mid = book.bestBid !== undefined && book.bestAsk !== undefined ? (book.bestBid + book.bestAsk) / 2 : undefined;

  return {
    definition,
    book,
    spot,
    volatility,
    volatilitySource: estimated !== null ? "estimated" : "fallback",
    fairYes,
    edgeVsMid: mid !== undefined ? fairYes - mid : undefined,
  };
}
