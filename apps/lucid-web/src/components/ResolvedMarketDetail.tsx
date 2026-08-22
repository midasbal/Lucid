import { useEffect, useState } from "react";
import type { LucidContext } from "@dreamdex-bot-kit/lucid-core";
import { fetchMarketResolution, type MarketResolution } from "../lib/indexer";
import { OracleTrustPanel } from "./OracleTrustPanel";

interface State {
  loading: boolean;
  resolution: MarketResolution | null;
  error: string | null;
}

/**
 * Detail surface for a market that already finalized: no live book, no
 * trade panel, just how it resolved and the oracle's own trust detail
 * behind that resolution. Reached from the portfolio's own settled
 * positions, which the trading-only MarketDetail view has no path back to
 * (that view is keyed off a live board row, per useBoard.ts, and a
 * resolved market has long since dropped off the board).
 */
export function ResolvedMarketDetail({ marketId, ctx, onBack }: { marketId: string; ctx: LucidContext; onBack: () => void }) {
  const [state, setState] = useState<State>({ loading: true, resolution: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, resolution: null, error: null });
    fetchMarketResolution(ctx.config.indexerUrl, marketId)
      .then((resolution) => {
        if (!cancelled) setState({ loading: false, resolution, error: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ loading: false, resolution: null, error: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, marketId]);

  const r = state.resolution;
  const outcomeLabel = r ? (r.voided ? "voided" : r.outcomeIdx === 0 ? "YES" : "NO") : null;

  return (
    <div className="market-detail" data-testid="resolved-market-detail">
      <div className="detail-header">
        <div>
          <button className="btn" onClick={onBack} data-testid="resolved-back">
            ← back
          </button>
          <div className="detail-question resolved-detail-question">
            {r ? r.question : state.loading ? "loading…" : "resolution not found"}
          </div>
        </div>
        {r && (
          <div className="detail-header-stats">
            <div className="stat">
              <div className="stat-label">asset</div>
              <div className="stat-value">{r.asset}</div>
            </div>
            <div className="stat">
              <div className="stat-label">outcome</div>
              <div className={`stat-value ${r.voided ? "" : r.outcomeIdx === 0 ? "edge-pos" : "edge-neg"}`} data-testid="resolved-outcome">
                {outcomeLabel}
              </div>
            </div>
          </div>
        )}
      </div>

      {state.error && <div className="gate-banner error">{state.error}</div>}

      {!state.error && !state.loading && !r && (
        <div className="panel">
          <div className="empty-state">
            no on-chain resolution record found for this market on this venue, it may belong to a different venue or predate this
            indexer's retention
          </div>
        </div>
      )}

      {r && <OracleTrustPanel oracleQuestionId={r.oracleQuestionId} framing="resolved" marketAsset={r.asset} />}
    </div>
  );
}
