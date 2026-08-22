import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { LucidContext } from "@dreamdex-bot-kit/lucid-core";
import type { MarketOnchain } from "@somnia-chain/markets-sdk";
import { fetchMarketResolution, type MarketResolution } from "../lib/indexer";
import { resolveOnchainById } from "../lib/portfolio";
import { findClaimable, type ClaimableSide } from "../lib/claim";
import { OracleTrustPanel } from "./OracleTrustPanel";
import { ClaimAction } from "./ClaimAction";

interface State {
  loading: boolean;
  resolution: MarketResolution | null;
  error: string | null;
}

interface ClaimState {
  onchain: MarketOnchain | null;
  claimable: ClaimableSide[];
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
  const { address } = useAccount();
  const [state, setState] = useState<State>({ loading: true, resolution: null, error: null });
  const [claim, setClaim] = useState<ClaimState>({ onchain: null, claimable: [] });
  const [claimRefresh, setClaimRefresh] = useState(0);

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

  useEffect(() => {
    if (!address) {
      setClaim({ onchain: null, claimable: [] });
      return;
    }
    let cancelled = false;
    resolveOnchainById(ctx, marketId)
      .then(async (onchain) => {
        const claimable = await findClaimable(ctx, marketId, onchain, address);
        if (!cancelled) setClaim({ onchain, claimable });
      })
      .catch(() => {
        if (!cancelled) setClaim({ onchain: null, claimable: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, marketId, address, claimRefresh]);

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

      {claim.onchain && claim.claimable.length > 0 && (() => {
        const onchain = claim.onchain;
        return (
          <div className="panel" data-testid="resolved-claim-panel">
            <h2 className="section-title">Your position</h2>
            <div className="claim-list">
              {claim.claimable.map((c) => {
                const decimals = onchain.decimals;
                const label = c.outcomeIdx === 0 ? "YES" : "NO";
                return (
                  <ClaimAction
                    key={c.outcomeIdx}
                    marketId={marketId}
                    symbol={null}
                    onchain={onchain}
                    outcomeIdx={c.outcomeIdx}
                    label={label}
                    estimatedPayout={Number(c.payout) / 10 ** decimals}
                    onClaimed={() => setClaimRefresh((k) => k + 1)}
                  />
                );
              })}
            </div>
          </div>
        );
      })()}

      {r && <OracleTrustPanel oracleQuestionId={r.oracleQuestionId} framing="resolved" marketAsset={r.asset} />}
    </div>
  );
}
