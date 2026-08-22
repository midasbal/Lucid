import { marketKey } from "@somnia-chain/markets-sdk";
import type { MarketOnchain } from "@somnia-chain/markets-sdk";
import {
  listLiveMarkets,
  resolveMarket,
  getFairValueWithBook,
  type LucidContext,
} from "@dreamdex-bot-kit/lucid-core";
import type { PublicClient } from "viem";
import { fetchAccountFills, fetchOpenBalances, fetchRedemptions } from "./indexer";
import { computeCostBasis, type OutcomeCostBasis } from "./costBasis";
import { readArmedStatus } from "./autoRedeem";
import { AUTO_REDEEM_HANDLER } from "./handler";
import { settlementMarkPrice } from "./claim";

export interface OpenPosition {
  marketId: string;
  asset: string;
  question: string;
  outcomeIdx: 0 | 1;
  balance: number;
  /** "trading": the market is still live, marked to ec-pricing's fair value.
   *  "settled": the oracle has already answered; marked to the fee-aware
   *  settlement payout (claim.ts's settlementMarkPrice, backed by ec-core's
   *  estimatePayout, the same function a real claim pays out through), not
   *  a model guess, since the outcome is already known. */
  status: "trading" | "settled";
  markPrice: number;
  markValue: number;
  costBasis: OutcomeCostBasis;
  unrealizedPnl: number | undefined;
  armed: boolean | null;
  /** True when this position has something to claim right now: a settled
   *  position on the winning side, or any held side of a voided market.
   *  A lost, non-voided position is never claimable. */
  claimable: boolean;
  onchain: MarketOnchain;
  /** Set only for "trading" positions, needed to route into the existing
   *  market detail / auto-redeem flow, which is keyed by symbol. */
  symbol: string | null;
}

export interface HistoryEntry {
  id: string;
  marketId: string;
  asset: string;
  question: string;
  outcomeIdx: 0 | 1;
  amountBurned: number;
  collateralOut: number;
  timestamp: number;
  txHash: string;
  outcome: "won" | "lost" | "voided";
  costBasis: number | undefined;
  realizedPnl: number | undefined;
}

/**
 * Resolve any market by its bytes32 id, active or long finalized, via the
 * SDK client's own getMarketOnchain, not lucid-core's resolveMarket. This is
 * a real gap in lucid-core found building this view: its market resolution
 * (listLiveMarkets / resolveMarket) is scoped to currently active markets
 * only, and a portfolio has to cover positions on markets that finalized
 * days ago and were never redeemed. ctx.exchange.client is the same
 * SomniaMarkets client ec-core's own marketOnchain() wraps, so this is a
 * direct SDK call, not a hand-rolled read.
 */
export async function resolveOnchainById(ctx: LucidContext, marketId: string): Promise<MarketOnchain> {
  return ctx.exchange.client.getMarketOnchain(marketId as `0x${string}`);
}

/**
 * Every market this account currently holds a nonzero balance on, resolved
 * and priced. Markets still trading are marked to ec-pricing's live fair
 * value; markets already resolved but not yet redeemed are marked to the
 * deterministic settlement payout instead, since there is nothing left for
 * a model to estimate once the oracle has answered.
 */
export async function loadOpenPositions(ctx: LucidContext, account: `0x${string}`, publicClient: PublicClient): Promise<OpenPosition[]> {
  const [balances, liveSummaries] = await Promise.all([fetchOpenBalances(ctx.config.indexerUrl, account), listLiveMarkets(ctx)]);
  const liveMarketIdToSymbol = new Map(liveSummaries.map((m) => [m.marketId.toLowerCase(), m.symbol]));

  // Every row's work (onchain resolve, fill history, mark pricing, armed
  // status) is independent of every other row's, so run them concurrently.
  // allSettled means one bad market (the same failure modes the old
  // sequential loop tolerated: a stale market that no longer resolves, a
  // fair-value read failing on a freshly listed market) still only drops
  // that one row, never the rest of the portfolio. Output order is
  // preserved by mapping the settled results back over `balances` in place,
  // not by push order, which concurrent completion would scramble.
  const settled = await Promise.allSettled(
    balances.map(async (row): Promise<OpenPosition> => {
      const outcomeIdx = row.outcomeIndex as 0 | 1;
      const onchain = await resolveOnchainById(ctx, row.marketId);
      const decimals = onchain.decimals;
      const balance = Number(row.balance) / 10 ** decimals;

      const fills = await fetchAccountFills(ctx.config.indexerUrl, row.marketId, account);
      const cb = computeCostBasis(fills, account, decimals);
      const costBasis = outcomeIdx === 0 ? cb.yes : cb.no;

      const resolved = onchain.isResolved || onchain.isVoided;
      let status: "trading" | "settled";
      let markPrice: number;
      let symbol: string | null = null;

      if (resolved) {
        status = "settled";
        markPrice = await settlementMarkPrice(ctx, row.marketId, onchain, outcomeIdx);
      } else {
        status = "trading";
        symbol = liveMarketIdToSymbol.get(row.marketId.toLowerCase()) ?? null;
        if (symbol) {
          const { market } = await resolveMarket(ctx, symbol);
          const fv = await getFairValueWithBook(ctx, market);
          markPrice = outcomeIdx === 0 ? fv.fairYes : 1 - fv.fairYes;
        } else {
          // Live per the module's own status, but this session's active-market
          // scan did not surface it (a book/opening-price read can fail on a
          // freshly listed market, useBoard.ts hits the same gap). Fair value
          // is unavailable this cycle; report it rather than guessing.
          markPrice = NaN;
        }
      }

      const markValue = Number.isFinite(markPrice) ? balance * markPrice : NaN;
      const unrealizedPnl = costBasis.avgEntryPrice !== undefined && Number.isFinite(markValue) ? markValue - costBasis.avgEntryPrice * balance : undefined;

      const marketKeyValue = marketKey(outcomeIdx === 0 ? onchain.yesId : onchain.noId);
      let armed: boolean | null = null;
      try {
        armed = await readArmedStatus(publicClient, AUTO_REDEEM_HANDLER, marketKeyValue, outcomeIdx, account);
      } catch {
        armed = null;
      }

      const claimable = status === "settled" && Number.isFinite(markPrice) && markPrice > 0 && balance > 0;

      return {
        marketId: row.marketId,
        asset: row.market.asset,
        question: row.market.question,
        outcomeIdx,
        balance,
        status,
        markPrice,
        markValue,
        costBasis,
        unrealizedPnl,
        armed,
        claimable,
        onchain,
        symbol,
      };
    }),
  );

  const positions: OpenPosition[] = [];
  for (const r of settled) {
    // One bad market should not take the whole portfolio down, the same
    // discipline useBoard.ts already applies per row.
    if (r.status === "fulfilled") positions.push(r.value);
  }
  return positions;
}

/**
 * Every redemption this account has made, with realized PnL derived from
 * the same cost-basis fill history open positions use, applied to the
 * redeemed amount. Real, settled numbers, not a model mark.
 */
export async function loadHistory(ctx: LucidContext, account: `0x${string}`): Promise<HistoryEntry[]> {
  const redemptions = await fetchRedemptions(ctx.config.indexerUrl, account);
  const decimals = ctx.config.decimals;
  const one = 10 ** decimals;

  // Distinct markets first, fetched concurrently, one fetch per market no
  // matter how many redemptions reference it, exactly what the cache below
  // already guaranteed sequentially. allSettled means one market's fill
  // history failing to load only drops that market's redemptions from the
  // fold below, never the rest.
  const marketIds = [...new Set(redemptions.map((r) => r.marketId))];
  const fillsSettled = await Promise.allSettled(
    marketIds.map(async (marketId) => {
      const fills = await fetchAccountFills(ctx.config.indexerUrl, marketId, account);
      return computeCostBasis(fills, account, decimals);
    }),
  );
  const fillsByMarket = new Map<string, ReturnType<typeof computeCostBasis>>();
  marketIds.forEach((marketId, i) => {
    const result = fillsSettled[i]!;
    if (result.status === "fulfilled") fillsByMarket.set(marketId, result.value);
  });

  const entries: HistoryEntry[] = [];

  for (const r of redemptions) {
    try {
      const cb = fillsByMarket.get(r.marketId);
      if (!cb) continue;
      const side = r.outcomeIdx === 0 ? cb.yes : cb.no;
      const amountBurned = Number(r.amountBurned) / one;
      const collateralOut = Number(r.collateralOut) / one;
      const costBasis = side.avgEntryPrice !== undefined ? side.avgEntryPrice * amountBurned : undefined;
      const realizedPnl = costBasis !== undefined ? collateralOut - costBasis : undefined;

      const outcome: HistoryEntry["outcome"] = r.market.voided ? "voided" : r.outcomeIdx === r.market.winningOutcome ? "won" : "lost";

      entries.push({
        id: r.id,
        marketId: r.marketId,
        asset: r.market.asset,
        question: r.market.question,
        outcomeIdx: r.outcomeIdx as 0 | 1,
        amountBurned,
        collateralOut,
        timestamp: Number(r.timestamp),
        txHash: r.txHash,
        outcome,
        costBasis,
        realizedPnl,
      });
    } catch {
      continue;
    }
  }

  return entries;
}

export interface PortfolioSummary {
  openExposure: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openCount: number;
  armedCount: number;
  unarmedCount: number;
}

/** Every summary-strip number, folded client-side over what was already
 *  fetched, exactly as DATA-RECON.md found necessary: the indexer exposes
 *  no server-side aggregate for any of this. */
export function summarizePortfolio(open: OpenPosition[], history: HistoryEntry[]): PortfolioSummary {
  let openExposure = 0;
  let unrealizedPnl = 0;
  let armedCount = 0;
  let unarmedCount = 0;
  for (const p of open) {
    if (Number.isFinite(p.markValue)) openExposure += p.markValue;
    if (p.unrealizedPnl !== undefined) unrealizedPnl += p.unrealizedPnl;
    if (p.armed === true) armedCount++;
    else if (p.armed === false) unarmedCount++;
  }
  let realizedPnl = 0;
  for (const h of history) {
    if (h.realizedPnl !== undefined) realizedPnl += h.realizedPnl;
  }
  return { openExposure, unrealizedPnl, realizedPnl, openCount: open.length, armedCount, unarmedCount };
}
