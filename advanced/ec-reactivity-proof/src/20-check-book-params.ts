import "dotenv/config";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";

const POOL = "0x354a1Cb845D9A2562b079023f614B1e93344A790" as `0x${string}`;

const ABI = parseAbi(["function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))"]);

const ctx = createChainContext();
const cfg = loadConfig();
console.log(`ec-core config.tick: ${cfg.tick}`);
console.log(`ec-core config.lot: ${cfg.lot}`);

const params = await ctx.publicClient.readContract({ address: POOL, abi: ABI, functionName: "getOrderBookParameters" });
console.log(`\nlive pool getOrderBookParameters(): ${JSON.stringify(params, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
