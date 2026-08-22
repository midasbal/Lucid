import { useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import type { LucidContext } from "@dreamdex-bot-kit/lucid-core";
import { usePortfolio } from "../lib/usePortfolio";
import { PortfolioSummaryStrip } from "./PortfolioSummary";
import { OpenPositionsList } from "./OpenPositionsList";
import { HistoryList } from "./HistoryList";
import { somniaShannon } from "../lib/chain";

export function Portfolio({
  ctx,
  onOpenMarket,
  onViewResolution,
}: {
  ctx: LucidContext;
  onOpenMarket: (symbol: string) => void;
  onViewResolution: (marketId: string) => void;
}) {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: somniaShannon.id });
  const [refreshKey, setRefreshKey] = useState(0);
  const { open, history, summary, loading, error, refreshedAt } = usePortfolio(ctx, address, publicClient, refreshKey);

  if (!isConnected) {
    return (
      <div className="panel">
        <h2 className="section-title">Portfolio</h2>
        <div className="empty-state">connect a wallet to see your portfolio</div>
      </div>
    );
  }

  return (
    <div className="market-detail" data-testid="portfolio-view">
      <PortfolioSummaryStrip summary={summary} />
      {refreshedAt && <p className="disclaimer">updated {new Date(refreshedAt).toLocaleTimeString()}</p>}
      <OpenPositionsList
        positions={open}
        loading={loading}
        error={error}
        onOpenMarket={onOpenMarket}
        onViewResolution={onViewResolution}
        onClaimed={() => setRefreshKey((k) => k + 1)}
      />
      <HistoryList history={history} loading={loading} error={error} />
    </div>
  );
}
