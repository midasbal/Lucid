import { erc6909Abi } from "@somnia-chain/markets-sdk";
import { parseAbi, type PublicClient } from "viem";

// Matches lucid-core's own HANDLER_ABI (packages/lucid-core/src/redeem.ts)
// exactly, for the read side only, registration itself always goes through
// lucid-core's enrollAutoRedeem, never a hand-rolled write here.
export const HANDLER_READ_ABI = parseAbi([
  "function auths(uint256, uint256) view returns (address owner, uint256 amount, uint256 deadline, uint256 nonce, bytes sig, uint32 operatorId, bytes32 venueId, bytes32 marketId, bool redeemed)",
]);

/** True when this owner has a live, unredeemed authorization registered for
 *  this exact market and outcome side, read straight from the handler's own
 *  storage, not trusted from any local state. */
export async function readArmedStatus(
  publicClient: PublicClient,
  handlerAddress: `0x${string}`,
  marketKeyValue: bigint,
  outcomeIdx: 0 | 1,
  owner: `0x${string}`,
): Promise<boolean> {
  const stored = await publicClient.readContract({
    address: handlerAddress,
    abi: HANDLER_READ_ABI,
    functionName: "auths",
    args: [marketKeyValue, BigInt(outcomeIdx)],
  });
  const [storedOwner, , , , , , , , redeemed] = stored;
  return storedOwner.toLowerCase() === owner.toLowerCase() && !redeemed;
}

/** Whether `spender` (BinaryMarketsModule) already holds standing ERC-6909
 *  operator approval over `owner`'s outcome tokens. redeemFor needs this to
 *  move the owner's balance when it fires, it is not implied by the signed
 *  RedeemAuthorization itself, which only proves intent, not token access. */
export async function readIsOperator(
  publicClient: PublicClient,
  outcomeToken: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
): Promise<boolean> {
  return publicClient.readContract({
    address: outcomeToken,
    abi: erc6909Abi,
    functionName: "isOperator",
    args: [owner, spender],
  });
}
