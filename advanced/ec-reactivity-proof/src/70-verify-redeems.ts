import "dotenv/config";
import { createChainContext } from "@dreamdex-bot-kit/core";
const ctx = createChainContext();
const hashes = [
  "0xb03a661f2ee9e62376c1b388e143bc0fcf8edc43fc212ea971abd86aea98e051",
  "0xfd95979e8c0e56c8e49136eb3cc517c902788e3409653455e57a26a185e9aefd",
  "0x252fb372b301aa56170c13ea10e5e5b5ff35595572c2ea9148b115c20172e5da",
  "0x0ae9faa09a688010bd44c8b942a03065b5597bbe0e37cbb2104bfd9f80ef6686",
];
for (const h of hashes) {
  const r = await ctx.publicClient.getTransactionReceipt({ hash: h as `0x${string}` });
  console.log(h, r.status);
}
process.exit(0);
