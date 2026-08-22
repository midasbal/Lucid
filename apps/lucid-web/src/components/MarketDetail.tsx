import { useState } from "react";
import { useAccount } from "wagmi";
import type { LucidContext } from "@dreamdex-bot-kit/lucid-core";
import type { BoardRow } from "../lib/useBoard";
import { useCandles } from "../lib/useCandles";
import { usePosition } from "../lib/usePosition";
import { PriceChart } from "./PriceChart";
import { OrderBook } from "./OrderBook";
import { TradePanel } from "./TradePanel";
import { PositionPanel } from "./PositionPanel";
import { AutoRedeemPanel } from "./AutoRedeemPanel";
import { OracleTrustPanel } from "./OracleTrustPanel";

function fmtTtl(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)}m`;
  return `${(min / 60).toFixed(1)}h`;
}

export function MarketDetail({ row, ctx }: { row: BoardRow; ctx: LucidContext }) {
  const { address } = useAccount();
  const candleState = useCandles(ctx.config.indexerUrl, row.marketId);
  const [refreshKey, setRefreshKey] = useState(0);
  const { position, costBasis, loading: positionLoading, error: positionError } = usePosition(ctx, row.onchain, row.marketId, address, refreshKey);

  const ttlSec = Number(row.onchain.expiry) - Date.now() / 1000;

  return (
    <div className="market-detail" data-testid="market-detail">
      <div className="detail-header">
        <div>
          <div className="detail-symbol">{row.symbol}</div>
          <div className="detail-question">{row.market.info.marketType === "BINARY" ? row.market.info.question : ""}</div>
        </div>
        <div className="detail-header-stats">
          <div className="stat">
            <div className="stat-label">fair (model)</div>
            <div className="stat-value fair-value detail-fair">{row.fv.fairYes.toFixed(3)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">ttl</div>
            <div className={`stat-value${ttlSec < 300 ? " ttl-tight" : ""}`}>{fmtTtl(ttlSec)}</div>
          </div>
        </div>
      </div>

      <PriceChart
        symbol={row.symbol}
        candles={candleState.candles}
        interval={candleState.interval}
        loading={candleState.loading}
        error={candleState.error}
      />

      <div className="detail-grid">
        <OrderBook book={row.fv.book} />
        <div>
          <TradePanel row={row} onFilled={() => setRefreshKey((k) => k + 1)} />
        </div>
      </div>

      <div className="detail-grid">
        <PositionPanel position={position} costBasis={costBasis} fairYes={row.fv.fairYes} loading={positionLoading} error={positionError} />
        <AutoRedeemPanel row={row} ctx={ctx} position={position} />
      </div>

      <OracleTrustPanel
        oracleQuestionId={row.market.info.marketType === "BINARY" ? (row.market.info.oracleQuestionId ?? null) : null}
        framing="pending"
        marketAsset={row.asset}
      />
    </div>
  );
}
