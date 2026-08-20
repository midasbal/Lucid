// Non-custodial auto-redeem enrollment. Produces an EIP-712 RedeemAuthorization
// via markets-sdk's proven signRedeemAuth (the same path HERO.md validated for
// BinaryMarketsModule.redeemFor), then registers it with the deployed
// AutoRedeemHandler so the standing MarketFinalized subscription redeems the
// position automatically when it wins, with the payout landing back with the
// signing owner, never with this library, the handler contract, or whichever
// address happens to submit the enrollment transaction.
//
// registerAuth is deliberately permissionless on AutoRedeemHandler (HERO.md):
// anyone can submit a valid signed authorization on the owner's behalf. This
// module still asks the SAME walletClient to both sign the authorization and
// submit the registration, since that is the real app flow, a user's own
// wallet does both in one session, but the two are independent capabilities.

import { parseAbi, type WalletClient } from "viem";
import { marketKey } from "@somnia-chain/markets-sdk";
import type { MarketOnchain } from "@somnia-chain/markets-sdk";
import type { LucidContext } from "./context.js";

const HANDLER_ABI = parseAbi([
  "function registerAuth(uint256 marketKeyValue, bytes32 marketId, uint8 outcomeIdx, address owner, uint256 amount, uint256 deadline, uint256 nonce, bytes sig, uint32 operatorId, bytes32 venueId)",
  "function auths(uint256, uint256) view returns (address owner, uint256 amount, uint256 deadline, uint256 nonce, bytes sig, uint32 operatorId, bytes32 venueId, bytes32 marketId, bool redeemed)",
]);

export interface EnrollAutoRedeemParams {
  handlerAddress: `0x${string}`;
  marketId: `0x${string}`;
  onchain: MarketOnchain;
  /** 0 = YES, 1 = NO, the side the owner actually holds. */
  outcomeIdx: 0 | 1;
  /** Raw outcome-token units to authorize, typically the full held balance. */
  amount: bigint;
  /** Unix seconds. Defaults to four hours out, comfortably past a short-dated market's resolution. */
  deadlineSec?: bigint;
}

export interface EnrollAutoRedeemResult {
  marketKeyValue: bigint;
  nonce: bigint;
  deadline: bigint;
  signature: `0x${string}`;
  registerTxHash: `0x${string}`;
}

/**
 * Sign a RedeemAuthorization for the owner behind `walletClient`, then submit
 * registerAuth on AutoRedeemHandler with that same wallet. Reads back the
 * stored authorization afterward so the caller gets on-chain confirmation,
 * not just a trusted return value.
 */
export async function enrollAutoRedeem(ctx: LucidContext, walletClient: WalletClient, params: EnrollAutoRedeemParams): Promise<EnrollAutoRedeemResult> {
  if (!walletClient.account) throw new Error("enrollAutoRedeem: walletClient has no account");
  const owner = walletClient.account.address;
  await ctx.exchange.loadMarkets();

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deadline = params.deadlineSec ?? nowSec + 4n * 60n * 60n;
  const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

  const authorization = await ctx.exchange.trader.signRedeemAuth({
    marketId: params.marketId,
    outcomeIdx: params.outcomeIdx,
    amount: params.amount,
    nonce,
    deadline,
  });

  const marketKeyValue = marketKey(params.onchain.yesId);

  const publicClient = ctx.exchange.client.getViemClient();
  const registerTxHash = await walletClient.writeContract({
    address: params.handlerAddress,
    abi: HANDLER_ABI,
    functionName: "registerAuth",
    args: [
      marketKeyValue,
      params.marketId,
      params.outcomeIdx,
      authorization.owner,
      authorization.amount,
      authorization.deadline,
      authorization.nonce,
      authorization.signature,
      authorization.operatorId,
      authorization.venueId,
    ],
    account: walletClient.account,
    chain: walletClient.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: registerTxHash });

  // Confirm on-chain, not just from the return value of the write.
  const stored = await publicClient.readContract({
    address: params.handlerAddress,
    abi: HANDLER_ABI,
    functionName: "auths",
    args: [marketKeyValue, BigInt(params.outcomeIdx)],
  });
  if (stored[0].toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`enrollAutoRedeem: registered but stored owner ${stored[0]} does not match ${owner}`);
  }

  return { marketKeyValue, nonce: authorization.nonce, deadline: authorization.deadline, signature: authorization.signature, registerTxHash };
}
