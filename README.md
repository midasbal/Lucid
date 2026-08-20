# Lucid

Lucid is a client library, a market maker, and a non-custodial settlement layer for DreamDEX event contracts on Somnia: short-dated binary (YES/NO) markets on asset prices.

## The problem

DreamDEX event contracts are short-dated, expiry-driven binary markets. A market opens, trades for minutes to a few hours, and settles automatically against an oracle-posted reference price. Two things make them hard to use in practice:

- **They are opaque to price.** There is no standard model for what a binary market's fair YES probability should be given the underlying's spot price, the market's opening reference price, time to expiry, and volatility. A trader is left eyeballing a thin order book with no independent reference point.
- **They are thin to trade and settle manually.** Liquidity on a given market can be light, especially away from the touch, and after a market resolves the winning side has to actively call a redeem function to collect its payout. Nothing does that automatically, and the naive way to automate it (a bot holding the user's funds or private key) reintroduces custody risk that a non-custodial market should not need.

Lucid's goal is to make these markets legible (a live, model-implied fair value next to the real book), liquid (a market maker that quotes both sides around that fair value from its own capital), and effortless to settle (positions redeem themselves the instant a market finalizes, without the holder doing anything and without Lucid ever touching their funds).

## What exists today

Four pieces, each proven live against Somnia's Shannon testnet.

### Reactive non-custodial auto-redeem

A deployed `AutoRedeemHandler` contract subscribes to `BinarySettlement.MarketFinalized` events through Somnia's on-chain reactivity precompile at address `0x0100`. A position holder signs an EIP-712 `RedeemAuthorization` once, off-chain, over a market, an outcome side, and an amount, and registers it with the handler. When that market finalizes, the reactivity precompile calls the handler's `onEvent` directly, with no relayer, no keeper, and no off-chain trigger of any kind, and the handler calls `BinaryMarketsModule.redeemFor` on the holder's behalf.

The payout is pinned to the signing owner inside the settlement contract itself, not to whichever address happened to submit the transaction. Registering an authorization only grants gas sponsorship, never a claim on the funds; the handler cannot redirect a payout even if it wanted to. This was proven live: a signed relayer call and a live reactive callback both paid the signing owner and only the owner, and gas for the reactive callback was measured on-chain (1,141,992 for a warm redeem, 2,886,851 for the cold case measured separately) so a subscription's gas limit can be budgeted against the worst case rather than guessed.

### ec-pricing: model-implied fair value

A cash-or-nothing binary pricer for these markets, computing model-fair YES probability from the underlying's spot price, the market's opening reference price, time to expiry, and volatility (either supplied or estimated from realized returns). The opening price plays the role of a strike; a driftless (zero risk-free rate) Black-Scholes-style assumption is deliberate and appropriate for the short windows these markets run on, and explicitly documented as not appropriate to reuse unmodified for long-dated instruments.

This is decision support, not a claimed trading edge. It gives a trader or a market maker an independent reference point to compare against the live book; it does not assert that trading against that reference is profitable.

### The maker: a single-capital fair-value market maker

A market maker that quotes both sides of one market at a time around `ec-pricing`'s model-fair YES, skewed by its own net position so it leans toward flattening rather than accumulating risk, with configurable half-spread, per-side notional, and hard position and notional caps. It only requotes when the planned price has drifted past a threshold or a side's active state has changed, so it does not cancel and repost on every tick of noise. It trades from its own capital only; there is no operator-delegated trading in this version, since that path was tested and found non-functional on the current contracts. A dry-run mode computes and logs every intended quote against the live book with no wallet required.

### lucid-core: the shared client library

A typed TypeScript library that both the maker and the eventual app import, so order placement, funding checks, tick and lot snapping, and redemption signing exist in exactly one place. It covers live market discovery and full market definitions, live order books and account positions, `ec-pricing`'s fair value wired to live inputs, order building and submission, and auto-redeem enrollment.

Its central finding: the market SDK's client accepts a signer three ways, a local private key, a prebuilt account, or an external `viem` `WalletClient`. That third form is what lets an app drive every trade and every redeem enrollment with a connected browser wallet's own signature, with the library never holding or seeing that wallet's private key. This was proven live with a second, independent wallet trading and enrolling a real position purely through that external-signer path.

## How it works, in brief

A market's fair value is computed from four live inputs (spot, opening price, time to expiry, realized volatility) and shown alongside the live order book. The maker uses that same fair value to plan and place resting orders from its own capital, requoting only when the market has moved enough to matter. Once a trader holds a position, they can sign a redeem authorization once and register it with the deployed handler; from that point on, redemption is fully automatic and requires no further action, no relayer they have to trust, and no custody of their funds by Lucid at any point.

## Packages

| Path | What it is |
| --- | --- |
| [`packages/lucid-core`](packages/lucid-core) | The shared client library: market data, fair-value pricing, order building and submission, auto-redeem enrollment. |
| [`packages/ec-pricing`](packages/ec-pricing) | The binary pricer and realized-volatility estimator `lucid-core` and the maker both build on. |
| [`packages/ec-core`](packages/ec-core) | Lower-level live market resolution, order placement, cancellation, and position helpers that `lucid-core` reuses rather than reimplements. |
| [`strategies/lucid-maker`](strategies/lucid-maker) | The single-capital fair-value market maker. |
| [`advanced/ec-reactivity-proof`](advanced/ec-reactivity-proof) | The `AutoRedeemHandler` contract and the scripts that proved it, end to end, on live testnet. |

The remaining packages, strategies, and examples in this repository (`packages/core`, the spot-market strategies, `examples/`) are the starting point this project was built on top of; see Credits.

## Network and stack

Somnia Shannon testnet, chain id 50312. `@somnia-chain/markets-sdk` (pinned to `0.25.0`) for market discovery, order books, and order placement. `@somnia-chain/reactivity-contracts` for the on-chain reactivity subscription the auto-redeem handler runs on. `viem` for all signing and contract calls, supporting both a local private key and an external wallet client. TypeScript throughout, Node.js 20+.

## Status

Live and proven on Shannon testnet, each backed by a real transaction history: the deployed `AutoRedeemHandler` and its reactive subscription; `ec-pricing`'s model and its wiring to live inputs; the maker, run in both dry-run and live-order modes; `lucid-core`, with a headless verification script that exercises every module against live testnet and prints real transaction hashes, including both signing paths (local key and external wallet).

Not yet built: a user-facing app. Everything above is a library, a bot, and a settlement contract; there is no frontend or hosted service yet. The maker also currently trades a single market at a time from its own capital, with no operator-delegated or multi-market operation.

## Running the key pieces

Install dependencies from the repository root:

```bash
npm install
```

Run the maker's fair-value quoting logic, dry run by default (see [`strategies/lucid-maker`](strategies/lucid-maker) for full configuration):

```bash
cd strategies/lucid-maker && npm start
```

Run `lucid-core`'s live verification script (needs a funded testnet key; see [`packages/lucid-core`](packages/lucid-core) for setup):

```bash
npm run verify -w @dreamdex-bot-kit/lucid-core
```

Run `lucid-core`'s unit tests:

```bash
npm run test -w @dreamdex-bot-kit/lucid-core
```

## Credits

Built on top of the DreamDEX bot kit, provided as the hackathon's starting point: shared trading client, backtest engine, and example strategies for DreamDEX on Somnia. See [LICENSE](LICENSE) for the upstream MIT license, which this project keeps and credits.
