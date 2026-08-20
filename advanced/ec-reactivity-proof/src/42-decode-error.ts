import { toFunctionSelector } from "viem";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { contractErrorsAbi } = require(path.resolve(__dirname, "../../../node_modules/@somnia-chain/markets-sdk/dist/contractErrorsAbi.js"));

const SELECTOR = "0xd48c4403";
console.log(`looking for selector: ${SELECTOR}`);

for (const item of contractErrorsAbi) {
  if (item.type !== "error") continue;
  const sig = `${item.name}(${item.inputs.map((i: { type: string }) => i.type).join(",")})`;
  const sel = toFunctionSelector(sig);
  if (sel === SELECTOR) console.log(`MATCH: ${sig}`);
}
