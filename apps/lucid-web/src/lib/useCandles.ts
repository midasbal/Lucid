import { useEffect, useState } from "react";
import { fetchCandles, type Candle } from "./indexer";

const CANDLE_INTERVALS = [60, 300, 900, 3600];
const REFRESH_MS = 20_000;

/**
 * Candles for one market, trying progressively coarser buckets until one
 * actually has rows (a market seconds old has no 60s candle yet but may
 * already have a 900s one from its own opening tick). Refetches on an
 * interval so the chart moves while the market is live.
 */
export function useCandles(indexerUrl: string, marketId: string | null): { candles: Candle[]; interval: number | null; loading: boolean; error: string | null } {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [interval, setInterval_] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!marketId) return;
    let cancelled = false;
    setLoading(true);

    async function tick() {
      try {
        for (const sec of CANDLE_INTERVALS) {
          const rows = await fetchCandles(indexerUrl, marketId!, sec);
          if (rows.length > 0) {
            if (!cancelled) {
              setCandles(rows);
              setInterval_(sec);
              setError(null);
              setLoading(false);
            }
            return;
          }
        }
        if (!cancelled) {
          setCandles([]);
          setInterval_(null);
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
    const id = window.setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [indexerUrl, marketId]);

  return { candles, interval, loading, error };
}
