import type { PortfolioSummary as Summary } from "../lib/portfolio";

function pnlClass(v: number): string {
  return v >= 0 ? "edge-pos" : "edge-neg";
}

export function PortfolioSummaryStrip({ summary }: { summary: Summary }) {
  return (
    <div className="panel portfolio-summary" data-testid="portfolio-summary">
      <div className="stat">
        <div className="stat-label">open exposure (model)</div>
        <div className="stat-value fair-value">{summary.openExposure.toFixed(3)}</div>
      </div>
      <div className="stat">
        <div className="stat-label">unrealized pnl (model)</div>
        <div className={`stat-value ${pnlClass(summary.unrealizedPnl)}`} data-testid="summary-unrealized">
          {summary.unrealizedPnl >= 0 ? "+" : ""}
          {summary.unrealizedPnl.toFixed(3)}
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">realized pnl (settled)</div>
        <div className={`stat-value ${pnlClass(summary.realizedPnl)}`} data-testid="summary-realized">
          {summary.realizedPnl >= 0 ? "+" : ""}
          {summary.realizedPnl.toFixed(3)}
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">positions</div>
        <div className="stat-value">{summary.openCount}</div>
      </div>
      <div className="stat">
        <div className="stat-label">auto-redeem</div>
        <div className="stat-value">
          {summary.armedCount} armed{summary.unarmedCount > 0 ? `, ${summary.unarmedCount} not` : ""}
        </div>
      </div>
    </div>
  );
}
