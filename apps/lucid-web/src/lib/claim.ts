// Direct, non-custodial self-redeem for an already-resolved position, the
// path that exists independently of auto-redeem enrollment. Auto-redeem
// (autoRedeem.ts, AutoRedeemPanel.tsx) is for a position armed ahead of a
// future finalization, an EIP-712 authorization plus a standing ERC-6909
// operator grant so the deployed handler can move the owner's balance when
// it fires later. This module is simpler than that: the connected wallet
// redeems its own already-resolved position directly, right now, no
// authorization, no operator grant, nothing standing between the click and
// the payout landing in the same wallet that signed for it.
//
// Built entirely on ec-core's own settlement.ts, unchanged: claimableOutcomes,
// estimatePayout, redeemOutcome. None of this is hand-rolled. redeemOutcome
// goes through the raw trader (BinaryMarketsModule.redeem), the same
// module-routed, fee-aware, voided-aware call HERO.md and LIFECYCLE.md
// already proved live by hand.

import { claimableOutcomes, estimatePayout, redeemOutcome, settlementFeeBps, type EcContext } from "@dreamdex-bot-kit/ec-core";
import type { MarketOnchain, UnifiedMarket } from "@somnia-chain/markets-sdk";
import type { LucidContext } from "@dreamdex-bot-kit/lucid-core";

/**
 * The portfolio only ever has a marketId for a settled position, not a full
 * UnifiedMarket row (lucid-core's own market resolution, listLiveMarkets and
 * resolveMarket, is scoped to currently active markets only, the same gap
 * PORTFOLIO.md already found). This is the exact stub shape ec-core's own
 * claim.ts builds for the same reason (claim.ts:79-82): redeemOutcome only
 * ever reads market.info.marketId and market.info.marketType off it, and
 * market.symbol for its own log line.
 */
export function stubMarket(marketId: string, symbol?: string | null): UnifiedMarket {
  return { symbol: symbol ?? undefined, info: { marketType: "BINARY", marketId } } as unknown as UnifiedMarket;
}

/** The venue's settlement fee for this market, live, fee-bps units. */
export async function settlementFeeBpsFor(ctx: LucidContext, marketId: string, onchain: MarketOnchain): Promise<bigint> {
  return settlementFeeBps(ctx as unknown as EcContext, stubMarket(marketId), onchain);
}

/**
 * Fee-aware per-share settlement price for one outcome of an already
 * resolved (or voided) market: what one share actually redeems for, 0 to 1.
 * Goes through the same estimatePayout() a real claim pays out through, so
 * this number and the amount a claim actually receives can never diverge.
 * NaN if the market has not resolved or voided yet, nothing to price.
 */
export async function settlementMarkPrice(ctx: LucidContext, marketId: string, onchain: MarketOnchain, outcomeIdx: 0 | 1): Promise<number> {
  if (!onchain.isResolved && !onchain.isVoided) return NaN;
  const feeBps = await settlementFeeBpsFor(ctx, marketId, onchain);
  const one = 10n ** BigInt(onchain.decimals);
  const payout = estimatePayout({ onchain, outcome: outcomeIdx, amount: one, feeBps });
  return Number(payout) / Number(one);
}

export interface ClaimableSide {
  outcomeIdx: 0 | 1;
  /** Raw held units of this outcome. */
  amount: bigint;
  /** Raw collateral units this amount actually redeems for, fee applied. */
  payout: bigint;
}

/**
 * Whichever side(s) of this market the connected account can actually claim
 * something for right now: live balances, live fee, the same claimableOutcomes
 * ec-core's own claim sweep uses, so a lost position never shows a claim
 * action, only a won one or a voided market's held side(s).
 */
export async function findClaimable(ctx: LucidContext, marketId: string, onchain: MarketOnchain, account: `0x${string}`): Promise<ClaimableSide[]> {
  if (!onchain.isResolved && !onchain.isVoided) return [];
  const [yes, no] = await Promise.all([
    ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account, id: onchain.yesId }),
    ctx.exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account, id: onchain.noId }),
  ]);
  const outcomes = claimableOutcomes(onchain, { yes, no });
  if (outcomes.length === 0) return [];
  const feeBps = await settlementFeeBpsFor(ctx, marketId, onchain);
  return outcomes.map((outcomeIdx) => {
    const amount = outcomeIdx === 0 ? yes : no;
    const payout = estimatePayout({ onchain, outcome: outcomeIdx, amount, feeBps });
    return { outcomeIdx, amount, payout };
  });
}

/**
 * Redeem the connected account's held balance of one side of an already
 * resolved market. Non-custodial by construction: signs through whatever
 * signer the LucidContext holds, the connected wallet's own walletClient
 * for the app, the same load-bearing fact LUCID-CORE.md already proved for
 * every other write this app makes. No EIP-712 signature, no operator
 * grant, nothing standing between this call and the payout; those belong
 * only to the on-behalf redeemFor path the auto-redeem handler uses.
 */
export async function claimOutcome(
  ctx: LucidContext,
  marketId: string,
  symbol: string | null,
  onchain: MarketOnchain,
  outcomeIdx: 0 | 1,
  amount: bigint,
) {
  if (!ctx.canTrade) throw new Error("claimOutcome: context has no signer");
  await ctx.exchange.loadMarkets();
  const market = stubMarket(marketId, symbol);
  return redeemOutcome(ctx as unknown as EcContext, market, onchain, outcomeIdx, amount);
}
