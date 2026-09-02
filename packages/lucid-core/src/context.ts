// Signer-agnostic context. Produces the exact shape ec-core's helpers
// (placeLimit, netPosition, sellableSize, marketOnchain, cancelById, ...)
// already expect, so this library never reimplements order placement,
// funding checks, or tick/lot snapping: it reuses the proven ec-core code
// unchanged, just with a wider choice of signer.
//
// ec-core's own createExchange() only ever builds a SomniaMarkets instance
// from a PRIVATE_KEY in .env. The SDK itself accepts more: SomniaMarketsConfig
// is `ClientConfig & Pick<TraderConfig, "privateKey" | "account" | "walletClient">`
// (markets-sdk/src/unified/exchange.ts), so a caller can hand it a viem
// WalletClient instead, the same shape a browser wallet (wagmi, injected
// provider) produces. That is the load-bearing fact this whole package's
// non-custodial story rests on: an app can drive every write in this library
// with the end user's own wallet, never a private key the app holds.

import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import type { WalletClient, Account, Address } from "viem";
import { loadConfig, loadEnv, makeChain, type EcConfig } from "@dreamdex-bot-kit/ec-core";

// The SDK's own default fee ceiling (config.ts's DEFAULT_FEES) is 60 gwei,
// sized for a base fee the SDK has never itself measured. Shannon's own
// base fee is flat and stable at 6 gwei (checked live across five
// consecutive blocks, matching eth_gasPrice exactly), so 60 gwei reserves
// roughly 10x more than any real write needs. 15 gwei keeps 2.5x headroom
// above the live base fee, comfortable margin for inclusion even if it
// ticks up, while cutting the fee side of every write's gas reservation by
// 4x. maxPriorityFeePerGas stays at the SDK's own default (0n): Somnia's
// BFT inclusion has never needed a tip here.
//
// gas (the 10,000,000 ceiling) cannot be lowered from here: it lives only
// on TraderConfig, not on SomniaMarketsConfig (ClientConfig & a signer-only
// Pick from TraderConfig), and the exchange constructor
// (@somnia-chain/markets-sdk's unified/exchange.js) destructures only
// { privateKey, account, walletClient } out of what's passed here, never
// forwarding gas to the trader it builds. Lowering it would mean reaching
// into the SDK itself, out of scope here.
const FEES = {
  maxFeePerGas: 15_000_000_000n,
  maxPriorityFeePerGas: 0n,
};

export interface LucidContext {
  exchange: SomniaMarkets;
  config: EcConfig;
  canTrade: boolean;
  /** How this context signs, for logging/diagnostics only. */
  signerKind: "privateKey" | "walletClient" | "none";
}

export interface LucidContextOptions {
  /** Local signing: the SDK holds the key and signs itself. How the maker runs. */
  privateKey?: `0x${string}`;
  /** A pre-built local account (viem's privateKeyToAccount), equivalent to privateKey. */
  account?: Account | Address;
  /**
   * External signing: a viem WalletClient the caller controls, standing in
   * for a browser wallet. How an app user trades non-custodially, this
   * library never sees or holds their key.
   */
  walletClient?: WalletClient;
}

/**
 * Build a LucidContext from any one signing source, or none (read-only).
 * Market data and pricing never need a signer; trading and enrollment do.
 */
export function createLucidContext(opts: LucidContextOptions = {}): LucidContext {
  loadEnv();
  const config = loadConfig();

  const exchange = new SomniaMarkets({
    indexerUrl: config.indexerUrl,
    chain: makeChain(config),
    wsRpcUrl: config.wsRpcUrl,
    addresses: config.addresses,
    priceFeed: config.priceFeed,
    fees: FEES,
    privateKey: opts.privateKey,
    account: opts.account,
    walletClient: opts.walletClient,
  });

  const signerKind: LucidContext["signerKind"] = opts.walletClient ? "walletClient" : opts.privateKey || opts.account ? "privateKey" : "none";

  return {
    exchange,
    config,
    canTrade: signerKind !== "none",
    signerKind,
  };
}

/** Read-only context: market data and pricing, no signer, no wallet needed. */
export function createReadOnlyContext(): LucidContext {
  return createLucidContext({});
}
