import type { BoardRow } from "../lib/useBoard";

function fmtTtl(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)}m`;
  return `${(min / 60).toFixed(1)}h`;
}

function fmtProb(p: number | undefined): string {
  if (p === undefined || Number.isNaN(p)) return "-";
  return p.toFixed(3);
}

export function LiveBoard({
  rows,
  loading,
  error,
  selected,
  onSelect,
}: {
  rows: BoardRow[];
  loading: boolean;
  error: string | null;
  selected: string | null;
  onSelect: (symbol: string) => void;
}) {
  return (
    <div className="panel">
      <h2 className="section-title">Live board, model fair value vs the book</h2>

      {error && <div className="gate-banner error">{error}</div>}

      {!error && loading && rows.length === 0 && <div className="empty-state">loading live markets…</div>}

      {!error && !loading && rows.length === 0 && <div className="empty-state">no live markets with headroom right now</div>}

      {rows.length > 0 && (
        <ul className="board-list">
          {rows.map((r) => {
            const ttlSec = Number(r.onchain.expiry) - Date.now() / 1000;
            return (
              <li key={r.symbol}>
                <button
                  className={`board-row${selected === r.symbol ? " selected" : ""}`}
                  onClick={() => onSelect(r.symbol)}
                  data-testid="board-row"
                >
                  <div className="board-row-top">
                    <div>
                      <div className="board-symbol">{r.symbol}</div>
                      <div className="board-asset">{r.asset}</div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">fair</div>
                      <div className="stat-value fair-value" data-testid="board-fair">
                        {fmtProb(r.fv.fairYes)}
                      </div>
                    </div>
                  </div>
                  <div className="board-row-bottom">
                    <span>
                      book {r.fv.book.bestBid?.toFixed(3) ?? "-"} / {r.fv.book.bestAsk?.toFixed(3) ?? "-"}
                    </span>
                    <span className={ttlSec < 300 ? "ttl-tight" : ""}>ttl {fmtTtl(ttlSec)}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <p className="disclaimer">
        Fair value is a model-implied reference computed from spot, opening price, time to expiry and realized
        volatility (ec-pricing). It is decision support, shown next to the live book for comparison, not a claim that
        trading against it is profitable.
      </p>
    </div>
  );
}
