import { useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { createLucidContext, submitOrder, type LucidContext, type AccountPosition } from "@dreamdex-bot-kit/lucid-core";
import type { BoardRow } from "../lib/useBoard";
import { somniaShannon } from "../lib/chain";
import { ClosePosition } from "./ClosePosition";
import { isValidTradeSize, describeTradeResult } from "../lib/tradeMessage";

type Phase = "idle" | "submitting" | "done" | "error";

function clampProb(p: number): number {
  return Math.min(0.99, Math.max(0.01, p));
}

export function TradePanel({ row, position, onFilled }: { row: BoardRow | null; position?: AccountPosition | null; onFilled?: () => void }) {
  const { isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [size, setSize] = useState<number>(0.01);

  const minSize = row ? Math.max(Number(row.fv.definition.minQuantity) / 10 ** row.fv.definition.decimals, 0.001) : 0.001;

  const onChain = chainId === somniaShannon.id;
  const canTrade = isConnected && onChain && !!walletClient && !!row;

  const askYes = row?.fv.book.bestAsk;
  const bidYes = row?.fv.book.bestBid;
  const yesPrice = askYes !== undefined ? clampProb(askYes + 0.015) : row ? clampProb(row.fv.fairYes + 0.03) : null;
  const noPrice = bidYes !== undefined ? clampProb(1 - bidYes + 0.015) : row ? clampProb(1 - row.fv.fairYes + 0.03) : null;

  const explorerBase = somniaShannon.blockExplorers?.default.url;

  async function trade(outcome: "YES" | "NO") {
    if (!row || !walletClient) return;
    const price = outcome === "YES" ? yesPrice : noPrice;
    if (price === null) return;
    if (!isValidTradeSize(size)) {
      setPhase("error");
      setMessage("enter a size greater than zero");
      setHash(null);
      return;
    }

    setPhase("submitting");
    setMessage(null);
    setHash(null);
    try {
      const ctx: LucidContext = createLucidContext({ walletClient });
      const result = await submitOrder(ctx, {
        market: row.market,
        onchain: row.onchain,
        outcome,
        side: "buy",
        price,
        size,
        type: "ioc",
      });
      setPhase("done");
      setHash(result.hash ?? null);
      setMessage(describeTradeResult(outcome, price, result));
      if (result.filled > 0) onFilled?.();
    } catch (e) {
      setPhase("error");
      setMessage((e as Error).message);
    }
  }

  return (
    <div className="panel trade-panel">
      <h2 className="section-title">Trade, non-custodial</h2>

      {!row && <div className="empty-state">select a market to trade</div>}

      {row && !isConnected && <div className="empty-state">connect a wallet to trade</div>}

      {row && isConnected && !onChain && <div className="empty-state">switch to Somnia Shannon to trade</div>}

      {row && isConnected && onChain && (
        <>
          <div className="trade-sides">
            <button
              className="side-btn yes"
              data-testid="trade-yes"
              disabled={!canTrade || phase === "submitting" || yesPrice === null || !isValidTradeSize(size)}
              onClick={() => trade("YES")}
            >
              <span className="side-label">buy YES</span>
              <span className="side-price">~{yesPrice?.toFixed(3) ?? "-"}</span>
            </button>
            <button
              className="side-btn no"
              data-testid="trade-no"
              disabled={!canTrade || phase === "submitting" || noPrice === null || !isValidTradeSize(size)}
              onClick={() => trade("NO")}
            >
              <span className="side-label">buy NO</span>
              <span className="side-price">~{noPrice?.toFixed(3) ?? "-"}</span>
            </button>
          </div>

          <div className="trade-size-row">
            <label htmlFor="trade-size">size (shares)</label>
            <input
              id="trade-size"
              data-testid="trade-size"
              type="number"
              min={minSize}
              step={minSize}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
            />
          </div>

          {row && position && <ClosePosition row={row} position={position} onFilled={onFilled} />}
        </>
      )}

      {phase !== "idle" && (
        <div className={`trade-status ${phase === "done" ? "success" : phase === "error" ? "error" : ""}`} data-testid="trade-status">
          {phase === "submitting" && "signing and sending…"}
          {phase === "done" && (
            <>
              {message}
              <br />
              {hash && (
                <>
                  tx:{" "}
                  {explorerBase ? (
                    <a className="tx-link" href={`${explorerBase}/tx/${hash}`} target="_blank" rel="noreferrer" data-testid="trade-hash">
                      {hash}
                    </a>
                  ) : (
                    <span data-testid="trade-hash">{hash}</span>
                  )}
                </>
              )}
            </>
          )}
          {phase === "error" && message}
        </div>
      )}
    </div>
  );
}
