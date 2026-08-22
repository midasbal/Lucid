import { useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { createLucidContext } from "@dreamdex-bot-kit/lucid-core";
import type { MarketOnchain } from "@somnia-chain/markets-sdk";
import { claimOutcome } from "../lib/claim";
import { somniaShannon } from "../lib/chain";

type Phase = "idle" | "claiming" | "done" | "error";

/**
 * Direct, non-custodial self-redeem for one side of an already-resolved
 * market, no auto-redeem enrollment involved. Reads a fresh on-chain
 * balance right before signing rather than trusting whatever the last
 * portfolio poll cached, since this is a real signed transaction, not just
 * a display number.
 */
export function ClaimAction({
  marketId,
  symbol,
  onchain,
  outcomeIdx,
  label,
  estimatedPayout,
  note,
  onClaimed,
}: {
  marketId: string;
  symbol: string | null;
  onchain: MarketOnchain;
  outcomeIdx: 0 | 1;
  label: "YES" | "NO";
  estimatedPayout: number;
  /** Extra line shown above the button, for a state the holder should
   *  understand before clicking, e.g. an armed position the handler has
   *  not actually paid (armed only means an authorization is registered,
   *  never a guarantee of payment, PROOF.md's own point about redeemFor's
   *  non-custodial design). */
  note?: string;
  onClaimed: () => void;
}) {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);

  const explorerBase = somniaShannon.blockExplorers?.default.url;

  async function claim() {
    if (!walletClient || !address) return;
    setPhase("claiming");
    setMessage(null);
    try {
      const ctx = createLucidContext({ walletClient });
      const id = outcomeIdx === 0 ? onchain.yesId : onchain.noId;
      const fresh = await ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: address, id });
      if (fresh <= 0n) {
        setPhase("error");
        setMessage("nothing left to claim, already redeemed");
        return;
      }
      const res = await claimOutcome(ctx, marketId, symbol, onchain, outcomeIdx, fresh);
      setPhase("done");
      setHash(res.hash ?? null);
      onClaimed();
    } catch (e) {
      setPhase("error");
      setMessage((e as Error).message);
    }
  }

  if (phase === "done") {
    return (
      <div className="claim-done" data-testid={`claim-done-${label.toLowerCase()}`}>
        <span className="armed-badge">claimed</span>
        {hash && (
          <a className="tx-link" href={`${explorerBase}/tx/${hash}`} target="_blank" rel="noreferrer" data-testid={`claim-tx-${label.toLowerCase()}`}>
            {hash.slice(0, 10)}…
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="claim-action">
      {note && (
        <p className="redeem-explain" data-testid={`claim-note-${label.toLowerCase()}`}>
          {note}
        </p>
      )}
      <button
        className="btn btn-accent"
        data-testid={`claim-button-${label.toLowerCase()}`}
        disabled={phase === "claiming" || !walletClient}
        onClick={claim}
      >
        {phase === "claiming" ? "claiming…" : `claim ~${estimatedPayout.toFixed(3)}`}
      </button>
      {phase === "error" && (
        <p className="redeem-explain error-text" data-testid={`claim-error-${label.toLowerCase()}`}>
          {message}
        </p>
      )}
    </div>
  );
}
