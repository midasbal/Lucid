import { useEffect, useRef, useState } from "react";
import { fetchCandles, type Candle } from "./indexer";
import { createLatestWinsGate } from "./latestWins";

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
  // The last interval that actually had rows, remembered across polls so a
  // repeat tick can try it directly instead of restarting the waterfall
  // from 60s every time. A ref, not state: it needs to be read and written
  // within the same tick() closure across polls without re-running the
  // effect (and its own market-change reset) on every successful fetch.
  const lastGoodInterval = useRef<number | null>(null);

  useEffect(() => {
    if (!marketId) return;
    let cancelled = false;
    const gate = createLatestWinsGate();
    setLoading(true);
    lastGoodInterval.current = null;

    async function tick() {
      const token = gate.start();
      // A stale tick must not win the cache either, not just the visible
      // state: otherwise a slow, out-of-order tick could still leave the
      // next poll trying the wrong "known good" interval first, even
      // though the visible candles themselves stayed correct.
      const commit = () => !cancelled && gate.isCurrent(token);

      try {
        const known = lastGoodInterval.current;
        if (known !== null) {
          const rows = await fetchCandles(indexerUrl, marketId!, known);
          if (rows.length > 0) {
            if (commit()) {
              setCandles(rows);
              setInterval_(known);
              setError(null);
              setLoading(false);
            }
            return;
          }
          // The previously-good interval came back empty this time (a real
          // change, not assumed permanent); fall through to the full
          // waterfall below exactly as a first load would.
        }

        for (const sec of CANDLE_INTERVALS) {
          const rows = await fetchCandles(indexerUrl, marketId!, sec);
          if (rows.length > 0) {
            if (commit()) {
              lastGoodInterval.current = sec;
              setCandles(rows);
              setInterval_(sec);
              setError(null);
              setLoading(false);
            }
            return;
          }
        }
        if (commit()) {
          lastGoodInterval.current = null;
          setCandles([]);
          setInterval_(null);
          setLoading(false);
        }
      } catch (e) {
        if (commit()) {
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
