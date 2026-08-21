import type { AccountPosition } from "@dreamdex-bot-kit/lucid-core";
import type { CostBasis } from "../lib/costBasis";

function OutcomeRow({
  label,
  balance,
  cb,
  fairPrice,
}: {
  label: "YES" | "NO";
  balance: number;
  cb: { avgEntryPrice: number | undefined };
  fairPrice: number;
}) {
  const markValue = balance * fairPrice;
  const cost = cb.avgEntryPrice !== undefined ? cb.avgEntryPrice * balance : undefined;
  const pnl = cost !== undefined ? markValue - cost : undefined;

  return (
    <div className="position-row" data-testid={`position-row-${label.toLowerCase()}`}>
      <span className={`side-tag ${label.toLowerCase()}`}>{label}</span>
      <div className="position-figures">
        <div className="stat">
          <div className="stat-label">balance</div>
          <div className="stat-value">{balance.toFixed(3)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">avg entry</div>
          <div className="stat-value">{cb.avgEntryPrice !== undefined ? cb.avgEntryPrice.toFixed(3) : "-"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">mark (model)</div>
          <div className="stat-value fair-value">{markValue.toFixed(3)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">pnl (model)</div>
          <div className={`stat-value ${pnl !== undefined ? (pnl >= 0 ? "edge-pos" : "edge-neg") : ""}`}>
            {pnl !== undefined ? (pnl >= 0 ? "+" : "") + pnl.toFixed(3) : "-"}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PositionPanel({
  position,
  costBasis,
  fairYes,
  loading,
  error,
}: {
  position: AccountPosition | null;
  costBasis: CostBasis | null;
  fairYes: number;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="panel">
      <h2 className="section-title">Your position</h2>
      {error && <div className="gate-banner error">{error}</div>}
      {!error && loading && !position && <div className="empty-state">loading position…</div>}
      {!error && position && costBasis && (position.yesBalance > 0 || position.noBalance > 0) && (
        <div className="position-list">
          {position.yesBalance > 0 && <OutcomeRow label="YES" balance={position.yesBalance} cb={costBasis.yes} fairPrice={fairYes} />}
          {position.noBalance > 0 && <OutcomeRow label="NO" balance={position.noBalance} cb={costBasis.no} fairPrice={1 - fairYes} />}
        </div>
      )}
      {!error && position && (position.yesBalance <= 0 && position.noBalance <= 0) && <div className="empty-state">no position on this market</div>}
      {!error && !position && !loading && <div className="empty-state">connect a wallet to see your position</div>}
      <p className="disclaimer">Mark and pnl are mark-to-model, valued at ec-pricing's current fair value, not a settlement value.</p>
    </div>
  );
}
