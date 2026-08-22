import { useEffect, useState } from "react";
import type { LucidContext } from "@dreamdex-bot-kit/lucid-core";
import type { MarketOnchain } from "@somnia-chain/markets-sdk";
import { resolveOnchainById } from "../lib/portfolio";

interface Status {
  loading: boolean;
  onchain: MarketOnchain | null;
  error: string | null;
}

/**
 * Shown whenever the market the user has open is no longer on the live
 * board: it may have expired, be near its own expiry and refreshing out of
 * the board's ttlSec window, or a single-cycle resolve may have failed
 * transiently (useBoard.ts drops one market from that cycle's rows rather
 * than take the whole board down). The open view never silently
 * substitutes a different market for this one, selection.ts's own
 * resolveSelectedRow guarantees that; this component's only job is to say
 * so honestly and keep every trading action gated until the market is
 * confirmed live again, rather than showing stale trade/close buttons
 * against a market nobody can currently confirm is still open.
 *
 * If a direct resolve finds the market has actually finalized, routes into
 * the existing resolved-market view instead of showing a bare
 * "unavailable" message, since that is the more honest, more useful thing
 * to show once it is known.
 */
export function MarketUnavailable({
  symbol,
  marketId,
  ctx,
  onBack,
  onResolved,
}: {
  symbol: string;
  marketId: string | null;
  ctx: LucidContext;
  onBack: () => void;
  onResolved: (marketId: string) => void;
}) {
  const [status, setStatus] = useState<Status>({ loading: true, onchain: null, error: null });

  useEffect(() => {
    if (!marketId) {
      setStatus({ loading: false, onchain: null, error: null });
      return;
    }
    let cancelled = false;
    setStatus({ loading: true, onchain: null, error: null });
    resolveOnchainById(ctx, marketId)
      .then((onchain) => {
        if (cancelled) return;
        if (onchain.isResolved || onchain.isVoided) {
          onResolved(marketId);
          return;
        }
        setStatus({ loading: false, onchain, error: null });
      })
      .catch((e) => {
        if (!cancelled) setStatus({ loading: false, onchain: null, error: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, marketId, onResolved]);

  return (
    <div className="market-detail" data-testid="market-unavailable">
      <div className="detail-header">
        <div>
          <button className="btn" onClick={onBack} data-testid="unavailable-back">
            ← back to the live board
          </button>
          <div className="detail-question resolved-detail-question">{symbol}</div>
        </div>
      </div>
      <div className="panel">
        {status.loading && <div className="empty-state">checking this market's current status…</div>}
        {!status.loading && status.error && <div className="gate-banner error">{status.error}</div>}
        {!status.loading && !status.error && (
          <div className="empty-state" data-testid="unavailable-message">
            this market is not on the live board right now, it may be near expiry or a status read failed this cycle.
            trading is disabled here until it is confirmed live again.
          </div>
        )}
      </div>
    </div>
  );
}
