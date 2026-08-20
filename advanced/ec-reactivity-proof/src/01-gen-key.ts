// Step 1: generate a fresh deployer/subscription-owner key for this proof.
// Prints the address only. The private key is written to .env (gitignored)
// for the later steps to read, never printed to the terminal.
//
//   npx tsx src/01-gen-key.ts

import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env");

if (existsSync(envPath)) {
  console.log(`.env already exists at ${envPath} - refusing to overwrite an existing key.`);
  console.log("Delete it first if you want to generate a new one.");
  process.exit(1);
}

const privateKey = generatePrivateKey();
const address = privateKeyToAccount(privateKey).address;

writeFileSync(envPath, `PRIVATE_KEY=${privateKey}\nNETWORK=testnet\n`, { mode: 0o600 });

console.log(`Deployer / subscription-owner address: ${address}`);
console.log("");
console.log("Fund this address on Shannon testnet (chain 50312) with STT covering:");
console.log("  - the 32 SOMI reactive-subscription-owner floor");
console.log("  - deployment gas for ReactiveHitHandler");
console.log("  - the ~210,000 gas subscribe() call on the 0x0100 precompile");
console.log("");
console.log("Faucets:");
console.log("  https://testnet.somnia.network/");
console.log("  https://cloud.google.com/web3/faucet?network=somnia");
console.log("");
console.log("STOP HERE. Confirm funding before running 02-deploy.ts.");
