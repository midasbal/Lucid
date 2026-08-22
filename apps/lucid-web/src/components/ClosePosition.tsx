import { useEffect, useState } from "react";
import { useWalletClient } from "wagmi";
import { createLucidContext, submitOrder } from "@dreamdex-bot-kit/lucid-core";
import { sellableSize, type EcContext } from "@dreamdex-bot-kit/ec-core";
import type { AccountPosition } from "@dreamdex-bot-kit/lucid-core";
import type { BoardRow } from "../lib/useBoard";
import { somniaShannon } from "../lib/chain";

type Phase = "idle" | "submitting" | "done" | "error";

function clampProb(p: number): number {
  return Math.min(0.99, Math.max(0.01, p));
}

/**
 * A taker IOC sell of a held outcome against the live book, the only exit a
 * still-trading position has today besides waiting for resolution. No
 * resting order, no price input, no open-orders list, that is a separate,
 * deferred feature. Routes through the same lucid-core submitOrder path the
 * buy side already uses, side "sell" instead of "buy", so it inherits the
 * same expiry cap (min(now+300s, market expiry), avoids the unnamed
 * 0xd3dea628 OrderExpiryBeyondMarket revert CONTRACT-ORDER-GATE.md tracked
 * down) and the same venue health-check-and-retry discipline. Capped at
 * sellableSize(), the same helper the maker's own asks already rely on
 * (MAKER.md bug 3), so this can never try to sell more than is actually
 * held.
 */
function CloseRow({
  row,
  outcome,
  balance,
  crossPrice,
  onFilled,
}: {
  row: BoardRow;
  outcome: "YES" | "NO";
  balance: number;
  /** Price that crosses the live book on this side, in the outcome's own
   *  terms. Null when that side of the book has no depth to sell into. */
  crossPrice: number | null;
  onFilled?: () => void;
}) {
  const { data: walletClient } = useWalletClient();
  const [size, setSize] = useState(balance);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);

  // Keep the default in step with the live balance until the holder edits
  // it themselves, the same "default to full position" behavior a partial
  // close still needs a starting point for.
  useEffect(() => {
    setSize((s) => (s === 0 || Math.abs(s - balance) < 1e-9 ? balance : s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balance]);

  const proceeds = crossPrice !== null ? Math.min(size, balance) * crossPrice : null;
  const explorerBase = somniaShannon.blockExplorers?.default.url;

  async function close() {
    if (!walletClient || crossPrice === null) return;
    setPhase("submitting");
    setMessage(null);
    setHash(null);
    try {
      const ctx = createLucidContext({ walletClient });
      const capped = await sellableSize(ctx as unknown as EcContext, row.onchain, outcome, Math.min(size, balance));
      if (capped <= 0) {
        setPhase("error");
        setMessage("nothing sellable, position may have already changed");
        return;
      }
      const result = await submitOrder(ctx, {
        market: row.market,
        onchain: row.onchain,
        outcome,
        side: "sell",
        price: crossPrice,
        size: capped,
        type: "ioc",
      });
      setPhase("done");
      setHash(result.hash ?? null);
      if (result.filled <= 0) {
        setMessage("sent, no fill, the book moved before this order landed");
      } else {
        const unsold = result.size - result.filled;
        setMessage(unsold > 0.0005 ? `sold ${result.filled.toFixed(3)} of ${result.size.toFixed(3)} requested, ${unsold.toFixed(3)} unsold` : `sold ${result.filled.toFixed(3)}`);
        onFilled?.();
      }
    } catch (e) {
      setPhase("error");
      setMessage((e as Error).message);
    }
  }

  return (
    <div className="close-row" data-testid={`close-row-${outcome.toLowerCase()}`}>
      <span className={`side-tag ${outcome.toLowerCase()}`}>{outcome}</span>
      <span className="redeem-balance">{balance.toFixed(3)} held</span>
      <input
        data-testid={`close-size-${outcome.toLowerCase()}`}
        type="number"
        min={0}
        max={balance}
        step={Math.max(balance / 100, 0.001)}
        value={size}
        onChange={(e) => setSize(Number(e.target.value))}
      />
      <button
        className="btn"
        data-testid={`close-button-${outcome.toLowerCase()}`}
        disabled={phase === "submitting" || crossPrice === null || size <= 0}
        onClick={close}
      >
        {phase === "submitting" ? "closing…" : `close at ~${crossPrice !== null ? crossPrice.toFixed(3) : "-"}`}
      </button>
      {crossPrice !== null && proceeds !== null && phase === "idle" && (
        <span className="close-preview" data-testid={`close-preview-${outcome.toLowerCase()}`}>
          ~{proceeds.toFixed(3)} proceeds, thin or wide books can fill worse than this
        </span>
      )}
      {crossPrice === null && <span className="close-preview">no {outcome === "YES" ? "bid" : "ask"} to sell into right now</span>}
      {phase === "done" && (
        <span className="close-preview" data-testid={`close-result-${outcome.toLowerCase()}`}>
          {message}
          {hash && (
            <>
              {" "}
              tx:{" "}
              <a className="tx-link" href={`${explorerBase}/tx/${hash}`} target="_blank" rel="noreferrer" data-testid={`close-tx-${outcome.toLowerCase()}`}>
                {hash.slice(0, 10)}…
              </a>
            </>
          )}
        </span>
      )}
      {phase === "error" && (
        <span className="close-preview error-text" data-testid={`close-error-${outcome.toLowerCase()}`}>
          {message}
        </span>
      )}
    </div>
  );
}

export function ClosePosition({ row, position, onFilled }: { row: BoardRow; position: AccountPosition | null; onFilled?: () => void }) {
  // Closing the full balance of a side triggers onFilled, which bumps the
  // parent's refresh key and re-fetches the live position. That fetch can
  // land before the holder ever sees the result: once the fresh balance
  // reads 0, a naive "only show a row while its balance is positive" guard
  // unmounts the row, taking its own just-shown success message and tx link
  // down with it. Found live building the NO-side proof for this pass: the
  // sell itself was real and correct, but the confirmation vanished before
  // the page could be read. Fixed by remembering which side just closed in
  // this session and keeping that row mounted (still holding its own
  // "done" state) even after its balance drops to zero, until the holder
  // navigates away.
  const [closed, setClosed] = useState<{ YES: boolean; NO: boolean }>({ YES: false, NO: false });

  const yesBalance = position?.yesBalance ?? 0;
  const noBalance = position?.noBalance ?? 0;
  const showYes = yesBalance > 0 || closed.YES;
  const showNo = noBalance > 0 || closed.NO;
  if (!showYes && !showNo) return null;

  const bidYes = row.fv.book.bestBid;
  const askYes = row.fv.book.bestAsk;
  // Selling YES takes the YES bid; selling NO takes the NO bid, the
  // complement of the YES ask (a NO order's price is always the complement
  // of the YES price, MAKER-GATE.md's own finding, load-bearing here too).
  const yesCross = bidYes !== undefined ? clampProb(bidYes - 0.015) : null;
  const noCross = askYes !== undefined ? clampProb(1 - askYes - 0.015) : null;

  return (
    <div className="close-position">
      <h3 className="section-title">Close position</h3>
      {showYes && (
        <CloseRow
          row={row}
          outcome="YES"
          balance={yesBalance}
          crossPrice={yesCross}
          onFilled={() => {
            setClosed((c) => ({ ...c, YES: true }));
            onFilled?.();
          }}
        />
      )}
      {showNo && (
        <CloseRow
          row={row}
          outcome="NO"
          balance={noBalance}
          crossPrice={noCross}
          onFilled={() => {
            setClosed((c) => ({ ...c, NO: true }));
            onFilled?.();
          }}
        />
      )}
    </div>
  );
}
