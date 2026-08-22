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
import { createLatestWinsGate } from "./latestWins";

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
 *
 * `active` gates the polling itself, not just whether the board is
 * rendered: the indexer/RPC/oracle reads behind every row are real cost,
 * and a user parked on the portfolio tab should not keep paying full board
 * refresh cost for a view they cannot see. Toggling back to true ticks
 * immediately rather than waiting out the rest of the interval, so
 * returning to the board never shows stale-longer-than-necessary data; the
 * last-known rows stay on screen while that fresh tick is in flight.
 */
export function useBoard(active: boolean = true): BoardState {
  const ctxRef = useRef<LucidContext | null>(null);
  if (!ctxRef.current) ctxRef.current = createReadOnlyContext();

  const [rows, setRows] = useState<BoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const ctx = ctxRef.current!;
    const gate = createLatestWinsGate();

    async function tick() {
      const token = gate.start();
      try {
        const summaries = await listLiveMarkets(ctx);
        const withHeadroom = summaries.filter((m) => m.ttlSec > 30);

        // Each market's resolve+fair-value read is independent of every
        // other's, so run them concurrently rather than one at a time. A
        // single market's read failing (no opening price yet on a freshly
        // listed market, most commonly) still only drops that one row,
        // never the rest of the batch, exactly as the sequential version
        // did: allSettled means one rejection can't abort its siblings.
        const settled = await Promise.allSettled(
          withHeadroom.map(async (s): Promise<BoardRow | null> => {
            const { market, onchain } = await resolveMarket(ctx, s.symbol);
            if (market.info.marketType !== "BINARY") return null;
            const fv = await getFairValueWithBook(ctx, market);
            return { symbol: s.symbol, asset: market.info.asset, marketId: market.info.marketId, market, onchain, fv };
          }),
        );
        const built: BoardRow[] = settled
          .filter((r): r is PromiseFulfilledResult<BoardRow | null> => r.status === "fulfilled")
          .map((r) => r.value)
          .filter((row): row is BoardRow => row !== null)
          .sort((a, b) => Number(a.onchain.expiry - b.onchain.expiry));

        // A newer tick may have already started (and possibly already
        // committed) while this one was still fetching; a slower earlier
        // tick must never overwrite fresher state that already landed.
        if (!cancelled && gate.isCurrent(token)) {
          setRows(built);
          setError(null);
          setRefreshedAt(Date.now());
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled && gate.isCurrent(token)) {
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
  }, [active]);

  return { rows, loading, error, refreshedAt, ctx: ctxRef.current };
}
