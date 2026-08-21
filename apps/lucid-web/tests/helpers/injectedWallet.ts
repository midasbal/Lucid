import type { Page } from "@playwright/test";
import { createWalletClient, createPublicClient, http, publicActions, type PublicClient, type WalletClient, type LocalAccount } from "viem";
import { somniaShannon } from "../../src/lib/chain";

/**
 * Wires a real funded viem local account up as window.ethereum, so the
 * app's own wagmi injected() connector, the same code path a real MetaMask
 * extension uses, picks it up with zero test-only branching in the app.
 * The Node-side client does the actual signing and broadcasting against
 * real testnet; the browser-side stub is a thin pass-through.
 */
export async function installInjectedWallet(page: Page, account: LocalAccount): Promise<{ walletClient: WalletClient; publicClient: PublicClient }> {
  const walletClient = createWalletClient({ account, chain: somniaShannon, transport: http() }).extend(publicActions) as unknown as WalletClient;
  const publicClient = createPublicClient({ chain: somniaShannon, transport: http() });

  await page.exposeFunction("__lucidTestAccounts", () => [account.address]);
  await page.exposeFunction("__lucidTestChainId", () => `0x${somniaShannon.id.toString(16)}`);
  await page.exposeFunction("__lucidTestSendTransaction", async (params: Record<string, string>) => {
    return walletClient.sendTransaction({
      to: params.to as `0x${string}`,
      data: params.data as `0x${string}` | undefined,
      value: params.value ? BigInt(params.value) : undefined,
      gas: params.gas ? BigInt(params.gas) : undefined,
      chain: somniaShannon,
      account,
    });
  });
  // enrollAutoRedeem signs an EIP-712 RedeemAuthorization, which goes over
  // eth_signTypedData_v4, a wallet-only method, never a chain RPC call
  // (found live: forwarding it to the public RPC's own request() the way
  // every other unrecognized method is handled here returned "method not
  // found" from the node itself). The typed-data payload arrives as
  // [address, JSON string]; EIP712Domain is a key in the JSON's own types
  // map but viem's signTypedData derives that from `domain` itself and
  // rejects it if also present in `types`, so it is stripped here.
  await page.exposeFunction("__lucidTestSignTypedData", async (payload: string) => {
    const parsed = JSON.parse(payload) as {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    };
    const { EIP712Domain: _domain, ...types } = parsed.types;
    return walletClient.signTypedData({
      account,
      domain: parsed.domain,
      types,
      primaryType: parsed.primaryType,
      message: parsed.message,
    } as Parameters<typeof walletClient.signTypedData>[0]);
  });
  await page.exposeFunction("__lucidTestRpc", async (method: string, params: unknown[]) => {
    return publicClient.request({ method, params } as Parameters<typeof publicClient.request>[0]);
  });

  await page.addInitScript(() => {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    (window as unknown as { ethereum: unknown }).ethereum = {
      isMetaMask: true,
      on(event: string, cb: (...a: unknown[]) => void) {
        (listeners[event] ??= []).push(cb);
      },
      removeListener(event: string, cb: (...a: unknown[]) => void) {
        listeners[event] = (listeners[event] ?? []).filter((f) => f !== cb);
      },
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const w = window as unknown as {
          __lucidTestAccounts: () => Promise<string[]>;
          __lucidTestChainId: () => Promise<string>;
          __lucidTestSendTransaction: (p: Record<string, string>) => Promise<string>;
          __lucidTestSignTypedData: (payload: string) => Promise<string>;
          __lucidTestRpc: (m: string, p: unknown[]) => Promise<unknown>;
        };
        if (method === "eth_requestAccounts" || method === "eth_accounts") return w.__lucidTestAccounts();
        if (method === "eth_chainId") return w.__lucidTestChainId();
        if (method === "eth_sendTransaction") return w.__lucidTestSendTransaction((params as Record<string, string>[])[0]!);
        if (method === "eth_signTypedData_v4") return w.__lucidTestSignTypedData((params as string[])[1]!);
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        return w.__lucidTestRpc(method, params ?? []);
      },
    };
  });

  return { walletClient, publicClient };
}
