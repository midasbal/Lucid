import { useEffect, useState } from "react";
import type { LucidContext } from "@dreamdex-bot-kit/lucid-core";
import type { PublicClient } from "viem";
import { loadOpenPositions, loadHistory, summarizePortfolio, type OpenPosition, type HistoryEntry, type PortfolioSummary } from "./portfolio";
import { createLatestWinsGate } from "./latestWins";

export interface PortfolioState {
  open: OpenPosition[];
  history: HistoryEntry[];
  summary: PortfolioSummary;
  loading: boolean;
  error: string | null;
  refreshedAt: number | null;
}

const REFRESH_MS = 30_000;
const EMPTY_SUMMARY: PortfolioSummary = { openExposure: 0, unrealizedPnl: 0, realizedPnl: 0, openCount: 0, armedCount: 0, unarmedCount: 0 };

/** Everything the portfolio view shows, across every market the account has
 *  ever touched, not just whichever one is selected on the board. */
export function usePortfolio(ctx: LucidContext, account: string | undefined, publicClient: PublicClient | undefined, refreshKey: number = 0): PortfolioState {
  const [open, setOpen] = useState<OpenPosition[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!account || !publicClient) {
      setOpen([]);
      setHistory([]);
      return;
    }
    let cancelled = false;
    const gate = createLatestWinsGate();
    setLoading(true);

    async function tick() {
      const token = gate.start();
      try {
        const acc = account as `0x${string}`;
        const [openPositions, historyEntries] = await Promise.all([
          loadOpenPositions(ctx, acc, publicClient!),
          loadHistory(ctx, acc),
        ]);
        if (cancelled || !gate.isCurrent(token)) return;
        setOpen(openPositions);
        setHistory(historyEntries);
        setError(null);
        setRefreshedAt(Date.now());
        setLoading(false);
      } catch (e) {
        if (!cancelled && gate.isCurrent(token)) {
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
  }, [ctx, account, publicClient, refreshKey]);

  const summary = open.length || history.length ? summarizePortfolio(open, history) : EMPTY_SUMMARY;

  return { open, history, summary, loading, error, refreshedAt };
}
