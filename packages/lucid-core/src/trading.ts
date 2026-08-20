// Order building and submission. Works identically whether the context was
// built with a local privateKey (how the maker runs) or an external
// WalletClient standing in for a browser wallet (how an app user trades
// non-custodially), because both produce the same LucidContext shape and
// this module never branches on signerKind: it hands the order straight to
// ec-core's placeLimit, which only ever calls ctx.exchange.trader.placeOrder
// and does not care how ctx.exchange got its signer.
//
// Reuses ec-core's placeLimit and cancelById unchanged: tick/lot snapping,
// the post-only/IOC order-type mapping, and the pre-flight funding check all
// come from there. No order-placement logic is duplicated in this package.

import { placeLimit, cancelById, type Outcome, type PlacedOrder, type EcContext } from "@dreamdex-bot-kit/ec-core";
import type { MarketOnchain, UnifiedMarket } from "@somnia-chain/markets-sdk";
import type { LucidContext } from "./context.js";

export interface BuildOrderParams {
  market: UnifiedMarket;
  onchain: MarketOnchain;
  outcome: Outcome;
  side: "buy" | "sell";
  /** YES-terms probability, will be tick-snapped. */
  price: number;
  /** Shares, will be lot-snapped. */
  size: number;
  /** post-only rests or is rejected, never takes. ioc takes what crosses, cancels the rest. */
  type: "post-only" | "ioc";
}

/**
 * Build and submit a binary order. Works two ways depending on how the
 * context was built (context.ts): a local privateKey signs and sends
 * directly, an external WalletClient prompts that wallet to sign, exactly
 * the non-custodial path an app needs. Either way this function is
 * identical; it is the context that differs, not the call.
 */
export async function submitOrder(ctx: LucidContext, params: BuildOrderParams): Promise<PlacedOrder> {
  if (!ctx.canTrade) throw new Error("submitOrder: context has no signer (privateKey, account, or walletClient required)");
  // A freshly built context's exchange has its own symbol registry, empty
  // until loadMarkets runs once. Idempotent: a no-op once already loaded.
  await ctx.exchange.loadMarkets();
  const ecCtx = ctx as unknown as EcContext;
  return placeLimit(ecCtx, {
    market: params.market,
    onchain: params.onchain,
    outcome: params.outcome,
    side: params.side,
    price: params.price,
    size: params.size,
    type: params.type,
  });
}

/**
 * Cancel a resting order by id. Expect this to revert if the order already
 * filled or was already cancelled, that is a normal outcome on this venue
 * (LIFECYCLE.md, HERO.md, MAKER.md all hit it), not a sign of a broken call.
 */
export async function cancelOrder(ctx: LucidContext, onchain: MarketOnchain, orderId: bigint | string) {
  if (!ctx.canTrade) throw new Error("cancelOrder: context has no signer");
  await ctx.exchange.loadMarkets();
  const ecCtx = ctx as unknown as EcContext;
  return cancelById(ecCtx, onchain, orderId);
}
