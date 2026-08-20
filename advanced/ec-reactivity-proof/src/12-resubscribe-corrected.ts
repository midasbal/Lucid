// Corrects the MarketFinalized subscription: unsubscribes the wrong-topic0
// subscription created in 03-subscribe.ts, then subscribes again with the
// topic0 confirmed live against on-chain BinarySettlement bytecode in
// 09-verify-marketfinalized-topic.ts / 11-decode-mystery.ts.
import "dotenv/config";
import { decodeEventLog } from "viem";
import { createChainContext } from "@dreamdex-bot-kit/core";
import { loadConfig } from "@dreamdex-bot-kit/ec-core";
import { Reactivity, SomniaReactivityPrecompileABI, defaultSubscriptionOptions } from "@somnia-chain/reactivity";

const WRONG_SUBSCRIPTION_ID = 13090851n;
const CORRECTED_TOPIC0 = "0xb1884334e955f8d8727678d4fa52dd9fc7140ff5e4ad38d358453bd400ada178" as const;
const CORRECTED_SIGNATURE = "MarketFinalized(uint256,address,uint64,address,uint256,bool,uint256[])";

async function main(): Promise<void> {
  const handlerAddress = process.env.HANDLER_ADDRESS as `0x${string}`;
  const ctx = createChainContext();
  const cfg = loadConfig();
  const binarySettlement = cfg.addresses.binarySettlement as `0x${string}`;

  const reactivity = new Reactivity({ public: ctx.publicClient, wallet: ctx.walletClient });

  console.log(`unsubscribing wrong-topic0 subscription ${WRONG_SUBSCRIPTION_ID}...`);
  const unsubResult = await reactivity.unsubscribe(WRONG_SUBSCRIPTION_ID);
  if (unsubResult instanceof Error) {
    console.error("unsubscribe failed:", unsubResult);
  } else {
    console.log(`unsubscribe tx: ${unsubResult}`);
    await ctx.publicClient.waitForTransactionReceipt({ hash: unsubResult });
  }

  console.log(`\nsubscribing with corrected topic0 ${CORRECTED_TOPIC0}`);
  console.log(`signature: ${CORRECTED_SIGNATURE}`);

  const result = await reactivity.subscribe({
    handlerContractAddress: handlerAddress,
    filter: { eventTopics: [CORRECTED_TOPIC0], emitter: binarySettlement },
    options: defaultSubscriptionOptions,
  });

  if (result instanceof Error) {
    console.error("subscribe failed:", result);
    process.exit(1);
  }

  console.log(`subscribe tx: ${result}`);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: result });
  console.log(`status: ${receipt.status}, gas used: ${receipt.gasUsed}`);

  let subscriptionId: bigint | null = null;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: SomniaReactivityPrecompileABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "SubscriptionCreated") {
        subscriptionId = (decoded.args as { subscriptionId: bigint }).subscriptionId;
        break;
      }
    } catch {
      continue;
    }
  }

  console.log(`\ncorrected subscriptionId: ${subscriptionId}`);
  console.log(`corrected topic0: ${CORRECTED_TOPIC0}`);
  console.log(`corrected signature: ${CORRECTED_SIGNATURE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
