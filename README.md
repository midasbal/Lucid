# Lucid

Lucid is a client library, a market maker, and a non-custodial settlement layer for DreamDEX event contracts on Somnia: short-dated binary (YES/NO) markets on asset prices.

## At a glance

- **A full non-custodial cash-out loop.** A position pays itself out automatically on resolution via on-chain reactivity (no relayer, no keeper), and a holder who never armed it can still claim directly, an armed-but-unpaid position has a fallback claim, and a still-trading position can be sold to close early. Every path signs from the holder's own wallet; Lucid never touches the funds.
- **Oracle transparency, not a black box.** A resolved market's own resolution detail, every source that answered, its raw value and pass/fail, the agreement threshold, the posted answer, and the oracle's own quality rating, is independently readable from the app, joined by the same id the settlement contract itself resolved against.
- **A real portfolio, not just an open trade.** Every market a connected account has ever held a balance on, still trading or long finalized, with cost basis, history, and a mark that is explicitly labeled model-implied or settlement-deterministic depending on which one actually applies.
- **A model-implied fair value**, computed from live spot, opening price, time to expiry, and volatility, shown next to the real book. Decision support, not a claimed trading edge.
- **A market maker that quotes from its own capital**, both off-chain (single-market and multi-market) and as a fully on-chain reactive contract that rests and cancels itself with no relayer in the loop.
- **One shared, non-custodial client library** driving the whole app through a connected wallet's own signature, proven with a second, independent wallet.

## The problem

DreamDEX event contracts are short-dated, expiry-driven binary markets. A market opens, trades for minutes to a few hours, and settles automatically against an oracle-posted reference price. Two things make them hard to use in practice:

- **They are opaque to price.** There is no standard model for what a binary market's fair YES probability should be given the underlying's spot price, the market's opening reference price, time to expiry, and volatility. A trader is left eyeballing a thin order book with no independent reference point.
- **They are thin to trade and settle manually.** Liquidity on a given market can be light, especially away from the touch, and after a market resolves the winning side has to actively call a redeem function to collect its payout. Nothing does that automatically, and the naive way to automate it (a bot holding the user's funds or private key) reintroduces custody risk that a non-custodial market should not need.

Lucid's goal is to make these markets legible (a live, model-implied fair value next to the real book, and full visibility into how a resolution actually happened), liquid (a market maker that quotes both sides around that fair value from its own capital), and effortless to settle (a position can pay itself out the instant a market finalizes without the holder doing anything, and every other way to close or collect it is one wallet signature away, with Lucid never touching the funds at any point).

## What exists today

Each piece below is proven live against Somnia's Shannon testnet, not just implemented.

### Reactive non-custodial auto-redeem

A deployed `AutoRedeemHandler` contract subscribes to `BinarySettlement.MarketFinalized` events through Somnia's on-chain reactivity precompile at address `0x0100`. A position holder signs an EIP-712 `RedeemAuthorization` once, off-chain, over a market, an outcome side, and an amount, and registers it with the handler. When that market finalizes, the reactivity precompile calls the handler's `onEvent` directly, with no relayer, no keeper, and no off-chain trigger of any kind, and the handler calls `BinaryMarketsModule.redeemFor` on the holder's behalf.

The payout is pinned to the signing owner inside the settlement contract itself, not to whichever address happened to submit the transaction. Registering an authorization only grants gas sponsorship, never a claim on the funds; the handler cannot redirect a payout even if it wanted to. This was proven live: a signed relayer call and a live reactive callback both paid the signing owner and only the owner, and gas for the reactive callback was measured on-chain (1,141,992 for a warm redeem, 2,886,851 for the cold case measured separately) so a subscription's gas limit can be budgeted against the worst case rather than guessed.

### Closing out without the handler: direct claim, fallback claim, and sell-to-close

Auto-redeem covers the case where a holder armed a position before it resolved. Three more paths close the rest of the loop, all non-custodial, all signing straight from the connected wallet:

- **Direct claim**, for a resolved position that was never armed: a plain self-redeem through the holder's own wallet, no EIP-712 signature, no operator grant, nothing standing between the click and the payout. Proven live on real won positions, with the app's own pre-claim payout estimate matching the actual on-chain collateral delta exactly.
- **Armed-position fallback claim**, for a position that was armed but the reactive handler has not paid it (for example, an authorization registered after the market had already resolved, which a handler subscription can never retroactively catch). The same direct-claim path works regardless of arming status; the app surfaces this explicitly on an armed-but-unpaid row rather than leaving the holder assuming the handler will eventually act. Proven live against a real armed, unpaid position, set up specifically to exercise this exact state, with the same exact-match reconciliation as a plain claim.
- **Sell-to-close**, for a position still trading: a taker IOC sell against the live book, capped at the account's actual sellable size, priced off the live bid on the side being sold (a NO order's price is the complement of the live YES side). Proven live on both YES and NO positions, with the resulting balance and collateral deltas reconciled against the indexer's own record of the fill.

Every one of these routes through the same underlying settlement math the deployed contracts use (fee-aware payout estimation, tick and lot snapping, order expiry handling), never a separately hand-rolled formula that could quietly drift from what actually pays out.

### Oracle trust panel

A resolution/trust view, joined from a market to the oracle's own separate GraphQL and REST services (`prd.oracle.somnia.host`), independent of the markets indexer. It shows every source that answered the question backing a market's resolution, each one's own raw reported value and a pass/fail indicator, the agreement threshold and how many sources actually met it, the final posted answer, and the oracle's own caliber quality rating with its named criteria when the rating is available.

This is framed as how a market resolved, not a pre-trade signal: the oracle's own resolution id on a still-live market was found to be unreliable before the market actually finalizes (it can carry a stale value from a previous, unrelated question), so the panel treats a resolved market's own resolution record as the trustworthy join and guards against showing a mismatched setup on a still-trading one. Proven live end to end, source rows, agreement count, and posted answer all reconciled against an independent read of the oracle's own GraphQL, including a real case where one of six sources had genuinely failed to answer and was shown as failed rather than silently dropped. The quality-rating badge itself is coded and wired to a real endpoint confirmed (server-side) to return ratings like `AAA` with a full breakdown; inside the browser that endpoint currently has no CORS headers, so the in-app panel shows a graceful "unavailable" state for that one section rather than blocking the rest of the panel, which still renders in full.

### Portfolio and PnL

A view answering "what do I hold and how am I doing," across every market a connected account has ever touched, not just whatever is on the live board. Discovery comes from the indexer's own outcome-balance records, since lucid-core's own market resolution only covers currently active markets; a market that already finalized is resolved directly by id instead.

Every open position is marked one of two honestly distinct ways: still-trading positions to `ec-pricing`'s live fair value, already-resolved-but-unredeemed positions to the deterministic settlement payout instead, since there is nothing left for a model to estimate once the oracle has already answered. Cost basis and realized PnL come from the account's own real fill and redemption history, never a model estimate. History shows every real redemption with its outcome (won, lost, or voided) and realized PnL. A summary strip folds both into open exposure, unrealized PnL, realized PnL, and armed/unarmed counts. Proven live against a real account's actual multi-session state, every number in the view reconciled against an independent indexer read, not trusted from the app's own display.

### ec-pricing: model-implied fair value

A cash-or-nothing binary pricer for these markets, computing model-fair YES probability from the underlying's spot price, the market's opening reference price, time to expiry, and volatility (either supplied or estimated from realized returns). The opening price plays the role of a strike; a driftless (zero risk-free rate) Black-Scholes-style assumption is deliberate and appropriate for the short windows these markets run on, and explicitly documented as not appropriate to reuse unmodified for long-dated instruments.

This is decision support, not a claimed trading edge. It gives a trader or a market maker an independent reference point to compare against the live book; it does not assert that trading against that reference is profitable.

### The maker: a fair-value market maker, off-chain and on-chain

A market maker that quotes both sides of a market around `ec-pricing`'s model-fair YES, skewed by its own net position so it leans toward flattening rather than accumulating risk, with configurable half-spread, per-side notional, and hard position and notional caps. It only requotes when the planned price has drifted past a threshold or a side's active state has changed, so it does not cancel and repost on every tick of noise. It trades from its own capital only; there is no operator-delegated trading in this version, since that path was tested and found non-functional on the current contracts. A dry-run mode computes and logs every intended quote against the live book with no wallet required. A multi-market variant (`lucid-maker-v2`) quotes several markets at once, sharing notional capacity across whatever is currently quoted rather than splitting it statically, and widens or pauses a side under a measured trend guard when the underlying is moving fast.

Alongside the off-chain makers, a deployed on-chain reactive maker contract rests both sides of a quote and cancels the other side itself the instant one fills, driven directly by Somnia's reactivity precompile, no relayer, no polling, and no off-chain process in that loop at all. Proven live, same block, for a single market, together with a continuous agent loop on top of it that recomputes fair value every cycle and requotes whichever side has drifted or gone quiet after a reactive cancel.

### lucid-core: the shared client library

A typed TypeScript library that both the maker and the app import, so order placement, funding checks, tick and lot snapping, and redemption signing exist in exactly one place. It covers live market discovery and full market definitions, live order books and account positions, `ec-pricing`'s fair value wired to live inputs, order building and submission, and auto-redeem enrollment.

Its central finding: the market SDK's client accepts a signer three ways, a local private key, a prebuilt account, or an external `viem` `WalletClient`. That third form is what lets an app drive every trade, every redeem, and every redeem enrollment with a connected browser wallet's own signature, with the library never holding or seeing that wallet's private key. This was proven live with a second, independent wallet trading and enrolling a real position purely through that external-signer path.

## How it works, in brief

A market's fair value is computed from four live inputs (spot, opening price, time to expiry, realized volatility) and shown alongside the live order book. The maker uses that same fair value to plan and place resting orders from its own capital, requoting only when the market has moved enough to matter. Once a trader holds a position, they can either sign a redeem authorization once and register it with the deployed handler, after which redemption is fully automatic, or close it out at any point through a direct claim, an armed-fallback claim, or a sell-to-close, whichever fits the position's actual state. Once a market has resolved, its own oracle trust panel shows exactly which sources answered and how the posted answer was reached, and the portfolio view shows every position across every market ever held, marked honestly to a model or to the real settlement payout depending on which applies. No path requires custody of the holder's funds by Lucid at any point.

## Packages

| Path | What it is |
| --- | --- |
| [`packages/lucid-core`](packages/lucid-core) | The shared client library: market data, fair-value pricing, order building and submission, auto-redeem enrollment. |
| [`packages/ec-pricing`](packages/ec-pricing) | The binary pricer and realized-volatility estimator `lucid-core` and the maker both build on. |
| [`packages/ec-core`](packages/ec-core) | Part of the provided DreamDEX bot kit, not authored here. Lower-level live market resolution, order placement, cancellation, settlement, and position helpers that `lucid-core` and the app reuse rather than reimplement. |
| [`strategies/lucid-maker`](strategies/lucid-maker) | The single-capital fair-value market maker. |
| [`strategies/lucid-maker-v2`](strategies/lucid-maker-v2) | The multi-market fair-value maker, shared notional capacity and a trend guard. |
| [`advanced/ec-reactivity-proof`](advanced/ec-reactivity-proof) | `AutoRedeemHandler` and the on-chain reactive maker (`ReactiveMaker`), plus the scripts that proved both, end to end, on live testnet. |
| [`apps/lucid-web`](apps/lucid-web) | The browser app: a live board, real charts, non-custodial trading, the oracle trust panel, portfolio and PnL, and the full cash-out loop (auto-redeem, direct claim, fallback claim, sell-to-close). |

The remaining packages, strategies, and examples in this repository (`packages/core`, `packages/ec-core`, the spot-market strategies, `examples/`) are the starting point this project was built on top of; see Credits.

## Network and stack

Somnia Shannon testnet, chain id 50312. `@somnia-chain/markets-sdk` (pinned to `0.25.0`) for market discovery, order books, and order placement. `@somnia-chain/reactivity-contracts` for the on-chain reactivity subscription the auto-redeem handler and the reactive maker both run on. `viem` for all signing and contract calls, supporting both a local private key and an external wallet client. TypeScript throughout, Node.js 20+.

## Status

Live and proven on Shannon testnet, each backed by a real transaction history: the deployed `AutoRedeemHandler` and its reactive subscription; `ec-pricing`'s model and its wiring to live inputs; `lucid-core`, with a headless verification script that exercises every module against live testnet and prints real transaction hashes, including both signing paths (local key and external wallet); the single-capital maker, run in both dry-run and live-order modes; and a multi-market maker (`lucid-maker-v2`) that quotes several markets at once, shares notional capacity across whatever is currently quoted rather than splitting it statically, and widens or pauses a side under a measured trend guard when the underlying is moving fast.

An on-chain reactive execution layer exists alongside the off-chain makers: a deployed contract that rests both sides of a quote and cancels the other side itself the instant one fills, no relayer, no polling, and no off-chain process in that loop at all, driven directly by Somnia's reactivity precompile. This was proven live, same block, for a single market, together with a continuous agent loop on top of it that recomputes fair value every cycle and requotes whichever side has drifted or gone quiet after a reactive cancel.

A user-facing app exists as well, `apps/lucid-web`: wallet connection via wagmi and viem, every open market shown with its own model-implied fair value next to the real order book, a price chart rendered straight from live data, non-custodial trading, and the full settlement surface a holder needs: arming auto-redeem in one signature so a position pays out automatically with no further action, a direct claim for a resolved position that was never armed, a fallback claim for an armed position the handler has not yet paid, and a sell-to-close for a still-trading position on either side. Alongside that, an oracle trust panel shows exactly how a resolved market's answer was reached, and a portfolio view shows open positions and history, cost basis, and PnL across every market the connected account has ever held. Every one of these is proven live on Shannon testnet with a real funded account, both headless and by hand, each reconciled against an independent read of the chain or the indexer rather than trusted from the app's own display.

Not yet built: the on-chain reactive execution layer still runs one market at a time. The app also does not expose the maker or the reactive agent themselves as an in-app view; that is intentional, both are demonstrated separately rather than folded into the holder-facing app, which is scoped to the trading and settlement surface a holder actually needs.

## Running the key pieces

Install dependencies from the repository root:

```bash
npm install
```

Run the app (see [`apps/lucid-web`](apps/lucid-web) for the full account, including the browser-compatibility work it took to get lucid-core running client-side):

```bash
npm run dev -w @dreamdex-bot-kit/lucid-web
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
