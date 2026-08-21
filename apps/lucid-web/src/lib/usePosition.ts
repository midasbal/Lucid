import { useEffect, useState } from "react";
import { getAccountPosition, type LucidContext, type AccountPosition } from "@dreamdex-bot-kit/lucid-core";
import type { MarketOnchain } from "@somnia-chain/markets-sdk";
import { fetchAccountFills } from "./indexer";
import { computeCostBasis, type CostBasis } from "./costBasis";

export interface PositionState {
  position: AccountPosition | null;
  costBasis: CostBasis | null;
  loading: boolean;
  error: string | null;
}

const REFRESH_MS = 15_000;

/** The connected account's live YES/NO balance on this market, plus cost
 *  basis derived from its own fill history. Both lucid-core's own read
 *  (getAccountPosition) and a direct indexer read (fetchAccountFills), the
 *  first for current chain state, the second for a number no chain read
 *  can answer. */
export function usePosition(
  ctx: LucidContext,
  onchain: MarketOnchain | null,
  marketId: string | null,
  account: string | undefined,
  refreshKey: number = 0,
): PositionState {
  const [position, setPosition] = useState<AccountPosition | null>(null);
  const [costBasis, setCostBasis] = useState<CostBasis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!onchain || !marketId || !account) {
      setPosition(null);
      setCostBasis(null);
      return;
    }
    let cancelled = false;
    setLoading(true);

    async function tick() {
      try {
        const [pos, fills] = await Promise.all([
          getAccountPosition(ctx, onchain!, account as `0x${string}`),
          fetchAccountFills(ctx.config.indexerUrl, marketId!, account!),
        ]);
        if (cancelled) return;
        setPosition(pos);
        setCostBasis(computeCostBasis(fills, account!, ctx.config.decimals));
        setError(null);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    }

    tick();
    const id = window.setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onchain?.pool, marketId, account, refreshKey]);

  return { position, costBasis, loading, error };
}
