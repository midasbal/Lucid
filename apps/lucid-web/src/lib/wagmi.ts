import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { somniaShannon } from "./chain";

// injected() targets window.ethereum, which is how MetaMask (and any other
// browser extension wallet) actually exposes itself, so this is "the normal
// MetaMask connector" without pulling in MetaMask's own SDK. It is also what
// lets a Playwright test wire up a fake window.ethereum backed by a real
// viem local account and have the app pick it up exactly like a real
// wallet, no special test-only code path in the app itself.
export const wagmiConfig = createConfig({
  chains: [somniaShannon],
  connectors: [injected()],
  transports: {
    [somniaShannon.id]: http(somniaShannon.rpcUrls.default.http[0]),
  },
});
