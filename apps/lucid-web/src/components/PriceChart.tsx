import type { Candle } from "../lib/indexer";

const W = 640;
const H = 200;
const PAD = 24;

function raw(v: string): number {
  return Number(v) / 1e6;
}

export function PriceChart({
  symbol,
  candles,
  interval,
  loading,
  error,
}: {
  symbol: string | null;
  candles: Candle[];
  interval: number | null;
  loading: boolean;
  error: string | null;
}) {
  if (!symbol) {
    return (
      <div className="panel">
        <h2 className="section-title">Price history</h2>
        <div className="empty-state">select a market on the board</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel">
        <h2 className="section-title">Price history</h2>
        <div className="gate-banner error" data-testid="chart-error">
          {error}
        </div>
      </div>
    );
  }

  if (loading && candles.length === 0) {
    return (
      <div className="panel">
        <h2 className="section-title">Price history</h2>
        <div className="empty-state">loading candles…</div>
      </div>
    );
  }

  if (candles.length === 0) {
    return (
      <div className="panel">
        <h2 className="section-title">Price history</h2>
        <div className="empty-state">no fills on this market yet</div>
      </div>
    );
  }

  const closes = candles.map((c) => raw(c.closePrice));
  const highs = candles.map((c) => raw(c.high));
  const lows = candles.map((c) => raw(c.low));
  const lo = Math.min(...lows);
  const hi = Math.max(...highs);
  const span = Math.max(hi - lo, 0.01);

  const x = (i: number) => PAD + (i / Math.max(candles.length - 1, 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);

  const linePath = closes.map((c, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(c).toFixed(1)}`).join(" ");
  const bandPath =
    highs.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ") +
    " " +
    lows
      .map((v, i) => v)
      .reverse()
      .map((v, i) => `L ${x(lows.length - 1 - i).toFixed(1)} ${y(v).toFixed(1)}`)
      .join(" ") +
    " Z";

  const last = closes[closes.length - 1]!;
  const first = closes[0]!;
  const changed = last - first;
  const totalVolume = candles.reduce((s, c) => s + Number(c.quoteVolume) / 1e6, 0);
  const totalFills = candles.reduce((s, c) => s + c.tradeCount, 0);

  return (
    <div className="panel" data-testid="price-chart">
      <div className="chart-header">
        <span className="chart-market">{symbol}</span>
        <span className="chart-price" style={{ color: changed >= 0 ? "var(--yes)" : "var(--no)" }}>
          {last.toFixed(3)}
        </span>
      </div>
      <div className="chart-svg-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
          <path d={bandPath} fill="var(--accent)" opacity="0.08" stroke="none" />
          <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="1.6" />
        </svg>
      </div>
      <div className="chart-meta">
        <span>interval {interval}s</span>
        <span>{candles.length} bucket{candles.length === 1 ? "" : "s"}</span>
        <span>{totalFills} fill{totalFills === 1 ? "" : "s"}</span>
        <span>{totalVolume.toFixed(2)} tUSDC volume</span>
      </div>
    </div>
  );
}
