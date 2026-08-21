import { useEffect, useRef, useState } from "react";
import {
  createReadOnlyContext,
  listLiveMarkets,
  resolveMarket,
  getFairValueWithBook,
  type LucidContext,
  type FairValueResult,
} from "@dreamdex-bot-kit/lucid-core";
import type { MarketOnchain, UnifiedMarket } from "@somnia-chain/markets-sdk";

export interface BoardRow {
  symbol: string;
  asset: string;
  marketId: string;
  market: UnifiedMarket;
  onchain: MarketOnchain;
  fv: FairValueResult;
}

export interface BoardState {
  rows: BoardRow[];
  loading: boolean;
  error: string | null;
  refreshedAt: number | null;
  ctx: LucidContext;
}

const REFRESH_MS = 25_000;

/**
 * Every live market's fair value next to its live book, refreshed on an
 * interval. Every read here is lucid-core's own: listLiveMarkets,
 * resolveMarket, getFairValueWithBook, nothing hand-rolled. Markets churn
 * (short-dated, 15 minutes to a few hours), so each cycle re-lists rather
 * than trusting a stale symbol set.
 */
export function useBoard(): BoardState {
  const ctxRef = useRef<LucidContext | null>(null);
  if (!ctxRef.current) ctxRef.current = createReadOnlyContext();

  const [rows, setRows] = useState<BoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctx = ctxRef.current!;

    async function tick() {
      try {
        const summaries = await listLiveMarkets(ctx);
        const withHeadroom = summaries.filter((m) => m.ttlSec > 30).sort((a, b) => a.ttlSec - b.ttlSec);

        const built: BoardRow[] = [];
        for (const s of withHeadroom) {
          try {
            const { market, onchain } = await resolveMarket(ctx, s.symbol);
            if (market.info.marketType !== "BINARY") continue;
            const fv = await getFairValueWithBook(ctx, market);
            built.push({ symbol: s.symbol, asset: market.info.asset, marketId: market.info.marketId, market, onchain, fv });
          } catch {
            // One market's fair value can fail to resolve (no opening price
            // yet on a freshly listed market, most commonly) without taking
            // the rest of the board down with it.
            continue;
          }
        }

        if (!cancelled) {
          setRows(built);
          setError(null);
          setRefreshedAt(Date.now());
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    }

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { rows, loading, error, refreshedAt, ctx: ctxRef.current };
}
