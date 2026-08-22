import type { HistoryEntry } from "../lib/portfolio";
import { somniaShannon } from "../lib/chain";

function outcomeBadgeClass(outcome: HistoryEntry["outcome"]): string {
  if (outcome === "won") return "armed-badge";
  if (outcome === "lost") return "not-armed-badge";
  return "arming-badge";
}

export function HistoryList({ history, loading, error }: { history: HistoryEntry[]; loading: boolean; error: string | null }) {
  return (
    <div className="panel">
      <h2 className="section-title">History, settled</h2>

      {error && <div className="gate-banner error">{error}</div>}

      {!error && loading && history.length === 0 && <div className="empty-state">loading history…</div>}

      {!error && !loading && history.length === 0 && <div className="empty-state">no redemptions yet</div>}

      {history.length > 0 && (
        <ul className="board-list" data-testid="history-list">
          {history.map((h) => {
            const label = h.outcomeIdx === 0 ? "YES" : "NO";
            return (
              <li key={h.id}>
                <div className="portfolio-row" data-testid="history-row" data-market-id={h.marketId} data-outcome-idx={h.outcomeIdx}>
                  <div className="portfolio-row-top">
                    <div>
                      <span className={`side-tag ${label.toLowerCase()}`}>{label}</span>
                      <span className="portfolio-question">{h.question}</span>
                      <div className="board-asset">{h.asset}</div>
                    </div>
                    <span className={outcomeBadgeClass(h.outcome)} data-testid="history-outcome">
                      {h.outcome}
                    </span>
                  </div>
                  <div className="portfolio-row-bottom">
                    <div className="stat">
                      <div className="stat-label">redeemed</div>
                      <div className="stat-value">{h.amountBurned.toFixed(3)}</div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">cost basis</div>
                      <div className="stat-value">{h.costBasis !== undefined ? h.costBasis.toFixed(3) : "-"}</div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">collateral out</div>
                      <div className="stat-value fair-value">{h.collateralOut.toFixed(3)}</div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">realized pnl</div>
                      <div className={`stat-value ${h.realizedPnl !== undefined ? (h.realizedPnl >= 0 ? "edge-pos" : "edge-neg") : ""}`} data-testid="history-pnl">
                        {h.realizedPnl !== undefined ? (h.realizedPnl >= 0 ? "+" : "") + h.realizedPnl.toFixed(3) : "-"}
                      </div>
                    </div>
                    <a
                      className="tx-link"
                      href={`${somniaShannon.blockExplorers?.default.url}/tx/${h.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="history-tx"
                    >
                      {h.txHash.slice(0, 10)}…
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="disclaimer">
        Realized pnl is real: collateral actually paid out minus this account's own weighted-average entry cost from
        its fill history. This is settled, not a model estimate.
      </p>
    </div>
  );
}
