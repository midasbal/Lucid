import "dotenv/config";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";

const POOL = "0x89CdE134c94201205799e3A5b82b6FD33a92C509" as `0x${string}`;
const ABI = parseAbi([
  "function getBinaryPoolParams() view returns ((address collateralToken, address market, address outcomeToken, uint256 yesId, uint256 noId, uint256 oneCollateral, uint256 setBacking, address feeRecipient, uint256 makerFeeBpsTimes1k, uint256 takerFeeBpsTimes1k, uint256 maxBuilderFeeBpsTimes1k, uint256 settlementFeeBpsTimes1k, address settlement, uint64 marketNonce, bool finalized))",
]);

const ctx = createChainContext();
const params = await ctx.publicClient.readContract({ address: POOL, abi: ABI, functionName: "getBinaryPoolParams" });
console.log(JSON.stringify(params, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
