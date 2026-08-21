// Somnia Shannon testnet, chain 50312, defined once and shared by wagmi and
// lucid-core alike so the app and the SDK never disagree about the network.
import { defineChain } from "viem";

export const somniaShannon = defineChain({
  id: 50312,
  name: "Somnia Shannon Testnet",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://dream-rpc.somnia.network"] },
  },
  blockExplorers: {
    default: { name: "Shannon Explorer", url: "https://shannon-explorer.somnia.network" },
  },
  testnet: true,
});
