import type { OpenPosition } from "../lib/portfolio";

function pnlClass(v: number | undefined): string {
  if (v === undefined) return "";
  return v >= 0 ? "edge-pos" : "edge-neg";
}

export function OpenPositionsList({
  positions,
  loading,
  error,
  onOpenMarket,
}: {
  positions: OpenPosition[];
  loading: boolean;
  error: string | null;
  /** Routes into the existing market detail and auto-redeem flow, this view
   *  never re-implements arming, it only surfaces status and a way in. */
  onOpenMarket: (symbol: string) => void;
}) {
  const hasStaleUnarmed = positions.some((p) => p.status === "settled" && p.armed === false);

  return (
    <div className="panel">
      <h2 className="section-title">Open positions</h2>

      {error && <div className="gate-banner error">{error}</div>}

      {!error && loading && positions.length === 0 && <div className="empty-state">loading positions…</div>}

      {!error && !loading && positions.length === 0 && <div className="empty-state">no open positions on any market</div>}

      {positions.length > 0 && (
        <ul className="board-list" data-testid="open-positions-list">
          {positions.map((p) => {
            const label = p.outcomeIdx === 0 ? "YES" : "NO";
            return (
              <li key={`${p.marketId}-${p.outcomeIdx}`}>
                <div className="portfolio-row" data-testid="open-position-row" data-market-id={p.marketId} data-outcome-idx={p.outcomeIdx}>
                  <div className="portfolio-row-top">
                    <div>
                      <span className={`side-tag ${label.toLowerCase()}`}>{label}</span>
                      <span className="portfolio-question">{p.question}</span>
                      <div className="board-asset">
                        {p.asset} · {p.status === "trading" ? "trading" : "resolved, not yet redeemed"}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">balance</div>
                      <div className="stat-value">{p.balance.toFixed(3)}</div>
                    </div>
                  </div>
                  <div className="portfolio-row-bottom">
                    <div className="stat">
                      <div className="stat-label">avg entry</div>
                      <div className="stat-value">{p.costBasis.avgEntryPrice !== undefined ? p.costBasis.avgEntryPrice.toFixed(3) : "-"}</div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">{p.status === "trading" ? "mark (model)" : "mark (settled)"}</div>
                      <div className="stat-value fair-value" data-testid="position-mark">
                        {Number.isFinite(p.markPrice) ? p.markPrice.toFixed(3) : "-"}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">value</div>
                      <div className="stat-value">{Number.isFinite(p.markValue) ? p.markValue.toFixed(3) : "-"}</div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">unrealized pnl</div>
                      <div className={`stat-value ${pnlClass(p.unrealizedPnl)}`} data-testid="position-pnl">
                        {p.unrealizedPnl !== undefined ? (p.unrealizedPnl >= 0 ? "+" : "") + p.unrealizedPnl.toFixed(3) : "-"}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">auto-redeem</div>
                      <div className="stat-value" data-testid="position-armed">
                        {p.armed === true && <span className="armed-badge">armed</span>}
                        {p.armed === false && <span className="not-armed-badge">not armed{p.status === "settled" ? "*" : ""}</span>}
                        {p.armed === null && <span className="not-armed-badge">unknown</span>}
                      </div>
                    </div>
                    {p.symbol && (
                      <button className="btn" data-testid="open-position-goto" onClick={() => onOpenMarket(p.symbol!)}>
                        {p.status === "trading" && p.armed === false ? "arm" : "open"}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {hasStaleUnarmed && (
        <p className="disclaimer">
          * these positions already finalized before an auto-redeem authorization existed for them. Arming now would
          register correctly but the reactive handler only fires on a future finalization, not retroactively, so it
          would never trigger. These need a direct redeem instead, not built into this view yet.
        </p>
      )}
    </div>
  );
}
