import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbi } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readEnvKey(file: string, varName: string): `0x${string}` {
  const content = readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const match = content.match(new RegExp(`${varName}=(0x[0-9a-fA-F]+)`));
  if (!match) throw new Error(`${varName} not found`);
  return match[1] as `0x${string}`;
}
const OWNER_KEY = readEnvKey(".env", "PRIVATE_KEY");
const ctx = createChainContext(OWNER_KEY);

const POOL = "0xC9CEaeb6aED73f678c5673617C0908aC650e13C6" as `0x${string}`;
const COLLATERAL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as `0x${string}`;
const ABI = parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]);

const allowance = await ctx.publicClient.readContract({ address: COLLATERAL, abi: ABI, functionName: "allowance", args: [ctx.account.address, POOL] });
console.log(`owner allowance for pool ${POOL}: ${allowance}`);
