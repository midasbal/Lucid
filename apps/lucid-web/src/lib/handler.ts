// The canonical AutoRedeemHandler this app enrolls positions against.
//
// Checked live before wiring this in (APP-CORE.md has the full account):
// the existing deployed handler's own subscription is still correctly
// configured, emitter is BinarySettlement, topic is the corrected
// MarketFinalized signature HERO.md and PROOF.md establish, handler
// address matches. Its subscription owner's balance has since drifted to
// ~31.29 STT, just under the nominal 32 STT floor a brand new subscribe()
// call would require. That floor is checked once, at subscription
// creation, never re-verified per block (CONTRACT-ORDER-GATE.md, HERO.md),
// so this does not deauthorize the existing, already-firing subscription.
// Funding a fresh subscription-owner above 32 STT would need an
// interactive faucet claim (wallet-connect or a Google-account sign-in,
// neither completable headlessly), so this app points at the proven,
// still-live existing handler rather than deploying an untested new one
// on the strength of a balance dip alone.
export const AUTO_REDEEM_HANDLER = "0x0fb364ecb91e5e4e8c5aa623b28df723387b54d1" as `0x${string}`;
