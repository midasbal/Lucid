// Live market data. Every function here reads Shannon testnet directly, no
// cached or synthetic values. Applies the gotchas this project already found
// the hard way: tick/lot must be read from the pool's own
// getOrderBookParameters(), never trusted from a config default (LIFECYCLE.md,
// MAKER.md); a NO order's book price is the complementary YES price
// (MAKER-GATE.md).

import { parseAbi } from "viem";
import { activeMarkets, marketOnchain, outcomeSymbols, netPosition, MARKET_STATUS, type EcContext } from "@dreamdex-bot-kit/ec-core";
import { getOpeningPrices, type UnifiedMarket, type MarketOnchain } from "@somnia-chain/markets-sdk";
import type { LucidContext } from "./context.js";
import { inferScale } from "./scale.js";

const BOOK_PARAMS_ABI = parseAbi(["function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))"]);

export interface LiveMarketSummary {
  symbol: string;
  marketId: `0x${string}`;
  asset: string;
  expiry: bigint;
  ttlSec: number;
}

/** Every live Trading binary market on the resolved venue, resolved live. */
export async function listLiveMarkets(ctx: LucidContext): Promise<LiveMarketSummary[]> {
  const ecCtx = ctx as unknown as EcContext;
  const markets = await activeMarkets(ecCtx, { max: 1e6 });
  const out: LiveMarketSummary[] = [];
  for (const m of markets) {
    if (m.info.marketType !== "BINARY") continue;
    const onchain = await marketOnchain(ecCtx, m);
    if (!onchain || onchain.status !== MARKET_STATUS.Trading) continue;
    out.push({
      symbol: m.symbol,
      marketId: m.info.marketId as `0x${string}`,
      asset: m.info.asset ?? "",
      expiry: onchain.expiry,
      ttlSec: Number(onchain.expiry) - Date.now() / 1000,
    });
  }
  return out;
}

/**
 * Resolve one market by symbol to the raw UnifiedMarket + MarketOnchain pair
 * that trading.ts and redeem.ts need. The rest of this module returns derived,
 * flattened data; this is the one function that hands back the SDK's own
 * objects, so a caller never has to reach past lucid-core into ec-core itself.
 */
export async function resolveMarket(ctx: LucidContext, symbol: string): Promise<{ market: UnifiedMarket; onchain: MarketOnchain }> {
  const ecCtx = ctx as unknown as EcContext;
  const markets = await activeMarkets(ecCtx, { max: 1e6 });
  const market = markets.find((m) => m.symbol === symbol);
  if (!market) throw new Error(`resolveMarket: ${symbol} not found among live markets`);
  const onchain = await marketOnchain(ecCtx, market);
  if (!onchain) throw new Error(`resolveMarket: no on-chain snapshot for ${symbol}`);
  return { market, onchain };
}

export interface MarketDefinition {
  symbol: string;
  marketId: `0x${string}`;
  asset: string;
  /** The oracle-posted opening price, scale inferred live against fetchPrice. Null if the reference answer has not landed yet. */
  openingPrice: number | null;
  expiry: bigint;
  pool: `0x${string}`;
  yesId: bigint;
  noId: bigint;
  outcomeToken: `0x${string}`;
  collateral: `0x${string}`;
  decimals: number;
  /** Live-read from the pool, never a cached default. */
  tickSize: bigint;
  minQuantity: bigint;
  lotSize: bigint;
  status: number;
  finalized: boolean;
}

/**
 * Full live definition of one market: on-chain snapshot plus the resolution
 * reference price. `openingPrice` is resolved via getOpeningPrices and scale
 * inferred at runtime against a fresh fetchPrice reading, since the oracle's
 * numericValue carries no documented decimals field (NOTES.md's Gate A).
 */
export async function getMarketDefinition(ctx: LucidContext, market: UnifiedMarket): Promise<MarketDefinition> {
  const ecCtx = ctx as unknown as EcContext;
  if (market.info.marketType !== "BINARY") throw new Error("not a binary market");

  const onchain = await marketOnchain(ecCtx, market);
  if (!onchain) throw new Error(`no on-chain snapshot for ${market.symbol}`);

  const params = await ctx.exchange.client.getViemClient().readContract({
    address: onchain.pool,
    abi: BOOK_PARAMS_ABI,
    functionName: "getOrderBookParameters",
  });

  let openingPrice: number | null = null;
  const openings = await getOpeningPrices([market.info.marketId], ctx.config.indexerUrl);
  const raw = openings[market.info.marketId.toLowerCase()];
  if (raw !== null && raw !== undefined && market.info.asset) {
    const price = await ctx.exchange.fetchPrice(market.info.asset);
    if (price) {
      const scale = inferScale(Number(raw), price.price);
      openingPrice = Number(raw) * scale;
    }
  }

  return {
    symbol: market.symbol,
    marketId: market.info.marketId as `0x${string}`,
    asset: market.info.asset ?? "",
    openingPrice,
    expiry: onchain.expiry,
    pool: onchain.pool,
    yesId: onchain.yesId,
    noId: onchain.noId,
    outcomeToken: onchain.outcomeToken,
    collateral: onchain.collateral,
    decimals: onchain.decimals,
    tickSize: params.tickSize,
    minQuantity: params.minQuantity,
    lotSize: params.lotSize,
    status: onchain.status,
    finalized: onchain.finalized,
  };
}

export interface BookLevel {
  price: number;
  quantity: number;
}

export interface LiveBook {
  /** Note: this is the YES outcome's own book. A NO order's raw on-chain
   *  price is the complementary YES price (MAKER-GATE.md); this book is
   *  already in YES terms and needs no adjustment when reading it directly. */
  yesBids: BookLevel[];
  yesAsks: BookLevel[];
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
}

/** Live order book for a market's YES side, depth levels each side. */
export async function getOrderBook(ctx: LucidContext, market: UnifiedMarket, depth = 5): Promise<LiveBook> {
  if (market.info.marketType !== "BINARY") throw new Error("not a binary market");
  const { yes } = outcomeSymbols(market);
  const ob = await ctx.exchange.fetchOrderBook(yes, depth);
  const yesBids = ob.bids.map(([price, quantity]) => ({ price, quantity }));
  const yesAsks = ob.asks.map(([price, quantity]) => ({ price, quantity }));
  const bestBid = yesBids[0]?.price;
  const bestAsk = yesAsks[0]?.price;
  return { yesBids, yesAsks, bestBid, bestAsk, spread: bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined };
}

export interface AccountPosition {
  address: `0x${string}`;
  yesBalance: number;
  noBalance: number;
  /** yes - no, ec-core's netPosition: the imbalance a complete-set holder actually carries risk on. */
  netPosition: number;
}

/** Live YES/NO balances and net position for any address on one market. */
export async function getAccountPosition(ctx: LucidContext, onchain: MarketOnchain, address: `0x${string}`): Promise<AccountPosition> {
  const one = 10n ** BigInt(ctx.config.decimals);
  const [yesRaw, noRaw] = await Promise.all([
    ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: address, id: onchain.yesId }),
    ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: address, id: onchain.noId }),
  ]);
  const yesBalance = Number(yesRaw) / Number(one);
  const noBalance = Number(noRaw) / Number(one);
  return { address, yesBalance, noBalance, netPosition: yesBalance - noBalance };
}

/** Net YES-NO position via ec-core's own helper, for the connected signer. */
export async function getNetPosition(ctx: LucidContext, onchain: MarketOnchain): Promise<number> {
  return netPosition(ctx as unknown as EcContext, onchain);
}
