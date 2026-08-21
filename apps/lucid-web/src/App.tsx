import { useState } from "react";
import { useBoard } from "./lib/useBoard";
import { LiveBoard } from "./components/LiveBoard";
import { MarketDetail } from "./components/MarketDetail";
import { WalletBar } from "./components/WalletBar";

export default function App() {
  const board = useBoard();
  const [selected, setSelected] = useState<string | null>(null);

  const selectedRow = board.rows.find((r) => r.symbol === selected) ?? board.rows[0] ?? null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Lucid</span>
          <span className="brand-tag">event contracts on Somnia</span>
        </div>
        <WalletBar />
      </header>

      <div className={`gate-banner${board.error ? " error" : ""}`} data-testid="gate-status">
        gate: {board.error ? "error" : board.loading && board.rows.length === 0 ? "loading" : "ok"}
        {board.rows.length > 0 && <span data-testid="gate-count"> · markets: {board.rows.length}</span>}
        {board.refreshedAt && ` · updated ${new Date(board.refreshedAt).toLocaleTimeString()}`}
        {board.error && <span data-testid="gate-error"> · {board.error}</span>}
      </div>

      <div className="grid-main">
        <LiveBoard
          rows={board.rows}
          loading={board.loading}
          error={board.error}
          selected={selectedRow?.symbol ?? null}
          onSelect={setSelected}
        />

        {selectedRow ? (
          <MarketDetail row={selectedRow} ctx={board.ctx} />
        ) : (
          <div className="panel">
            <div className="empty-state">select a market on the board</div>
          </div>
        )}
      </div>
    </div>
  );
}
