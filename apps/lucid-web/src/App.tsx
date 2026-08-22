import { useState } from "react";
import { useBoard } from "./lib/useBoard";
import { LiveBoard } from "./components/LiveBoard";
import { MarketDetail } from "./components/MarketDetail";
import { ResolvedMarketDetail } from "./components/ResolvedMarketDetail";
import { Portfolio } from "./components/Portfolio";
import { WalletBar } from "./components/WalletBar";

type View = "markets" | "portfolio";

export default function App() {
  const board = useBoard();
  const [selected, setSelected] = useState<string | null>(null);
  const [resolvedMarketId, setResolvedMarketId] = useState<string | null>(null);
  const [view, setView] = useState<View>("markets");

  const selectedRow = board.rows.find((r) => r.symbol === selected) ?? board.rows[0] ?? null;

  function openMarket(symbol: string) {
    setSelected(symbol);
    setResolvedMarketId(null);
    setView("markets");
  }

  function viewResolution(marketId: string) {
    setResolvedMarketId(marketId);
    setView("markets");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <span className="brand-mark">Lucid</span>
            <span className="brand-tag">event contracts on Somnia</span>
          </div>
          <nav className="view-tabs">
            <button className={`tab-btn${view === "markets" ? " active" : ""}`} onClick={() => setView("markets")} data-testid="tab-markets">
              markets
            </button>
            <button className={`tab-btn${view === "portfolio" ? " active" : ""}`} onClick={() => setView("portfolio")} data-testid="tab-portfolio">
              portfolio
            </button>
          </nav>
        </div>
        <WalletBar />
      </header>

      <div className={`gate-banner${board.error ? " error" : ""}`} data-testid="gate-status">
        gate: {board.error ? "error" : board.loading && board.rows.length === 0 ? "loading" : "ok"}
        {board.rows.length > 0 && <span data-testid="gate-count"> · markets: {board.rows.length}</span>}
        {board.refreshedAt && ` · updated ${new Date(board.refreshedAt).toLocaleTimeString()}`}
        {board.error && <span data-testid="gate-error"> · {board.error}</span>}
      </div>

      {view === "markets" ? (
        <div className="grid-main">
          <LiveBoard
            rows={board.rows}
            loading={board.loading}
            error={board.error}
            selected={selectedRow?.symbol ?? null}
            onSelect={setSelected}
          />

          {resolvedMarketId ? (
            <ResolvedMarketDetail marketId={resolvedMarketId} ctx={board.ctx} onBack={() => setResolvedMarketId(null)} />
          ) : selectedRow ? (
            <MarketDetail row={selectedRow} ctx={board.ctx} />
          ) : (
            <div className="panel">
              <div className="empty-state">select a market on the board</div>
            </div>
          )}
        </div>
      ) : (
        <Portfolio ctx={board.ctx} onOpenMarket={openMarket} onViewResolution={viewResolution} />
      )}
    </div>
  );
}
