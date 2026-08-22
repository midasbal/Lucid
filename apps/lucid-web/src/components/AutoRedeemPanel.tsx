import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { erc6909Abi, marketKey } from "@somnia-chain/markets-sdk";
import { createLucidContext, enrollAutoRedeem, type LucidContext } from "@dreamdex-bot-kit/lucid-core";
import type { BoardRow } from "../lib/useBoard";
import type { AccountPosition } from "@dreamdex-bot-kit/lucid-core";
import { readArmedStatus, readIsOperator } from "../lib/autoRedeem";
import { AUTO_REDEEM_HANDLER } from "../lib/handler";
import { somniaShannon } from "../lib/chain";

type ArmPhase = "checking" | "not-armed" | "approving" | "signing" | "armed" | "error";

interface SideState {
  phase: ArmPhase;
  message: string | null;
  txHashes: string[];
}

const IDLE: SideState = { phase: "checking", message: null, txHashes: [] };

function OutcomeArmRow({
  row,
  outcomeIdx,
  balance,
  ctx,
}: {
  row: BoardRow;
  outcomeIdx: 0 | 1;
  balance: number;
  ctx: LucidContext;
}) {
  const label = outcomeIdx === 0 ? "YES" : "NO";
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: somniaShannon.id });
  const [state, setState] = useState<SideState>(IDLE);

  const marketKeyValue = marketKey(outcomeIdx === 0 ? row.onchain.yesId : row.onchain.noId);

  useEffect(() => {
    if (!publicClient || !address) return;
    let cancelled = false;
    readArmedStatus(publicClient, AUTO_REDEEM_HANDLER, marketKeyValue, outcomeIdx, address)
      .then((armed) => {
        if (!cancelled) setState((s) => (s.phase === "approving" || s.phase === "signing" ? s : { ...IDLE, phase: armed ? "armed" : "not-armed" }));
      })
      .catch((e) => {
        if (!cancelled) setState({ phase: "error", message: (e as Error).message, txHashes: [] });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, address, row.marketId, outcomeIdx]);

  async function arm() {
    if (!walletClient || !publicClient || !address) return;
    // A market can resolve while this page is still open (the row's own
    // onchain snapshot goes stale). Arming an already-resolved position
    // registers a real authorization that can never pay, reactivity is not
    // retroactive (PROOF.md). Caught here rather than left to surface as a
    // silent, permanently-unpaid arm; a direct claim is the correct action
    // once a market has actually resolved.
    if (row.onchain.isResolved || row.onchain.isVoided) {
      setState({ phase: "error", message: "this market already resolved while this page was open. arming now would never pay out, claim it directly from the portfolio instead", txHashes: [] });
      return;
    }
    const hashes: string[] = [];
    try {
      const binaryModule = ctx.config.addresses.binaryModule as `0x${string}`;
      const alreadyOperator = await readIsOperator(publicClient, row.onchain.outcomeToken, address, binaryModule);
      if (!alreadyOperator) {
        setState({ phase: "approving", message: "approving BinaryMarketsModule to move this position, one-time", txHashes: hashes });
        const approveHash = await walletClient.writeContract({
          address: row.onchain.outcomeToken,
          abi: erc6909Abi,
          functionName: "setOperator",
          args: [binaryModule, true],
          account: walletClient.account!,
          chain: walletClient.chain,
        });
        hashes.push(approveHash);
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      setState({ phase: "signing", message: "signing the redeem authorization and registering it", txHashes: hashes });
      const lucidCtx = createLucidContext({ walletClient });
      const amount = BigInt(Math.round(balance * 10 ** ctx.config.decimals));
      const result = await enrollAutoRedeem(lucidCtx, walletClient, {
        handlerAddress: AUTO_REDEEM_HANDLER,
        marketId: row.marketId as `0x${string}`,
        onchain: row.onchain,
        outcomeIdx,
        amount,
      });
      hashes.push(result.registerTxHash);
      setState({ phase: "armed", message: null, txHashes: hashes });
    } catch (e) {
      setState({ phase: "error", message: (e as Error).message, txHashes: hashes });
    }
  }

  return (
    <div
      className="redeem-row"
      data-testid={`redeem-row-${label.toLowerCase()}`}
      data-market-key={marketKeyValue.toString()}
      data-outcome-token={row.onchain.outcomeToken}
      data-binary-module={ctx.config.addresses.binaryModule}
      data-market-id={row.marketId}
    >
      <div className="redeem-row-head">
        <span className={`side-tag ${label.toLowerCase()}`}>{label}</span>
        <span className="redeem-balance">{balance.toFixed(3)} shares held</span>
        {state.phase === "armed" && <span className="armed-badge" data-testid={`armed-badge-${label.toLowerCase()}`}>armed</span>}
        {state.phase === "not-armed" && <span className="not-armed-badge">not armed</span>}
        {(state.phase === "approving" || state.phase === "signing" || state.phase === "checking") && (
          <span className="arming-badge">{state.phase === "checking" ? "checking…" : "arming…"}</span>
        )}
      </div>

      {state.phase === "not-armed" && (
        <>
          <p className="redeem-explain">
            Arming signs a redeem authorization with your wallet, off-chain, over this exact market, this side, and this
            amount, and registers it with the deployed AutoRedeemHandler. When this market finalizes, Somnia's own
            reactivity precompile calls the handler directly, no relayer, no keeper, no further action from you, and the
            payout is paid to your address alone. The handler can never redirect it; that is enforced by the settlement
            contract itself, not by trust in the handler.
          </p>
          <button className="btn btn-accent" data-testid={`arm-button-${label.toLowerCase()}`} onClick={arm}>
            arm auto-redeem for {label}
          </button>
        </>
      )}

      {(state.phase === "approving" || state.phase === "signing") && <p className="redeem-explain">{state.message}</p>}

      {state.phase === "armed" && (
        <p className="redeem-explain">
          This {label} position redeems itself automatically the instant the market finalizes, if {label} wins. No
          action needed from you, and Lucid never holds or touches the payout.
        </p>
      )}

      {state.phase === "error" && (
        <p className="redeem-explain error-text" data-testid={`redeem-error-${label.toLowerCase()}`}>
          {state.message}
        </p>
      )}

      {state.txHashes.length > 0 && (
        <div className="redeem-tx-list" data-testid={`redeem-tx-${label.toLowerCase()}`}>
          {state.txHashes.map((h) => (
            <a key={h} className="tx-link" href={`${somniaShannon.blockExplorers?.default.url}/tx/${h}`} target="_blank" rel="noreferrer">
              {h}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function AutoRedeemPanel({ row, ctx, position }: { row: BoardRow; ctx: LucidContext; position: AccountPosition | null }) {
  const { isConnected } = useAccount();

  if (!isConnected) {
    return (
      <div className="panel">
        <h2 className="section-title">Auto-redeem</h2>
        <div className="empty-state">connect a wallet to see auto-redeem status</div>
      </div>
    );
  }

  if (!position || (position.yesBalance <= 0 && position.noBalance <= 0)) {
    return (
      <div className="panel">
        <h2 className="section-title">Auto-redeem</h2>
        <div className="empty-state">no position on this market yet</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2 className="section-title">Auto-redeem</h2>
      {position.yesBalance > 0 && <OutcomeArmRow row={row} outcomeIdx={0} balance={position.yesBalance} ctx={ctx} />}
      {position.noBalance > 0 && <OutcomeArmRow row={row} outcomeIdx={1} balance={position.noBalance} ctx={ctx} />}
    </div>
  );
}
