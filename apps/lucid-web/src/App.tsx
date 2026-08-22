import { useEffect, useState } from "react";
import { useBoard } from "./lib/useBoard";
import { resolveSelectedRow } from "./lib/selection";
import { LiveBoard } from "./components/LiveBoard";
import { MarketDetail } from "./components/MarketDetail";
import { MarketUnavailable } from "./components/MarketUnavailable";
import { ResolvedMarketDetail } from "./components/ResolvedMarketDetail";
import { Portfolio } from "./components/Portfolio";
import { WalletBar } from "./components/WalletBar";

type View = "markets" | "portfolio";

export default function App() {
  const [view, setView] = useState<View>("markets");
  // Polling costs a full indexer/RPC/oracle sweep every cycle; do not keep
  // paying it while the user is looking at the portfolio tab instead.
  const board = useBoard(view === "markets");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedMarketId, setSelectedMarketId] = useState<string | null>(null);
  const [resolvedMarketId, setResolvedMarketId] = useState<string | null>(null);

  // Never falls back to board.rows[0]: a market that drops off the live
  // board is shown as explicitly unavailable, below, not silently swapped
  // for a different one.
  const selectedRow = resolveSelectedRow(board.rows, selected);

  // Remember the marketId for the currently selected symbol so it can still
  // be resolved directly (MarketUnavailable) once it is no longer on the
  // board and selectedRow itself goes null.
  useEffect(() => {
    if (selectedRow) setSelectedMarketId(selectedRow.marketId);
  }, [selectedRow]);

  function openMarket(symbol: string) {
    setSelected(symbol);
    setSelectedMarketId(null);
    setResolvedMarketId(null);
    setView("markets");
  }

  function backToBoard() {
    setSelected(null);
    setSelectedMarketId(null);
    setResolvedMarketId(null);
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
            <ResolvedMarketDetail marketId={resolvedMarketId} ctx={board.ctx} onBack={backToBoard} />
          ) : selectedRow ? (
            <MarketDetail row={selectedRow} ctx={board.ctx} />
          ) : selected ? (
            <MarketUnavailable symbol={selected} marketId={selectedMarketId} ctx={board.ctx} onBack={backToBoard} onResolved={viewResolution} />
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
