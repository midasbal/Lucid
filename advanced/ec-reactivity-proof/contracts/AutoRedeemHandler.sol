// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";

/// Minimal interface for the one BinaryMarketsModule function this contract
/// calls. redeemFor recovers the signature to `owner` and pays `owner`
/// directly; the caller (this contract) pays gas only.
interface IBinaryMarketsModule {
    function redeemFor(
        address owner,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig,
        uint32 operatorId,
        bytes32 venueId,
        bytes32 marketId,
        uint8 outcomeIdx,
        uint256 amount
    ) external;
}

/// Non-custodial auto-redeem. Anyone can register a pre-signed
/// RedeemAuthorization for a market and outcome; on that market's
/// MarketFinalized, if the registered outcome won, this contract calls
/// redeemFor with the stored authorization. Payout always lands with the
/// signed owner, never with this contract or the reactivity subscription
/// owner who pays the callback gas.
///
/// Match key: BinarySettlement.MarketFinalized indexes marketKey, not the
/// bytes32 marketId a RedeemAuthorization is signed over. marketKey is
/// `(uint160(pool) << 64) | nonce` (markets-sdk's ids.ts), computable at
/// registration time from the same market a position was taken on, and it
/// is collision-free forever across pool recycling since it bakes in the
/// pool's per-market nonce. Keying storage by marketKey and separately
/// storing marketId (needed by redeemFor's own signature verification, not
/// derivable from marketKey) avoids the alternative of keying by pool
/// address, which would need extra guarding against a later, unrelated
/// market reusing the same recycled pool.
///
/// Two auth slots per market (index 0 = YES, 1 = NO) since a caller may
/// register both sides of one market before knowing which wins.
contract AutoRedeemHandler is SomniaEventHandler {
    struct Auth {
        address owner;
        uint256 amount;
        uint256 deadline;
        uint256 nonce;
        bytes sig;
        uint32 operatorId;
        bytes32 venueId;
        bytes32 marketId;
        bool redeemed;
    }

    IBinaryMarketsModule public immutable MODULE;

    mapping(uint256 => Auth[2]) public auths; // marketKey => [YES auth, NO auth]

    event AuthRegistered(uint256 indexed marketKey, uint8 outcomeIdx, address indexed owner, uint256 amount);
    event AutoRedeemed(uint256 indexed marketKey, uint8 outcomeIdx, address indexed owner, uint256 amount);

    constructor(address module) {
        MODULE = IBinaryMarketsModule(module);
    }

    function registerAuth(
        uint256 marketKeyValue,
        bytes32 marketId,
        uint8 outcomeIdx,
        address owner,
        uint256 amount,
        uint256 deadline,
        uint256 nonce,
        bytes calldata sig,
        uint32 operatorId,
        bytes32 venueId
    ) external {
        require(outcomeIdx < 2, "bad outcomeIdx");
        auths[marketKeyValue][outcomeIdx] = Auth({
            owner: owner,
            amount: amount,
            deadline: deadline,
            nonce: nonce,
            sig: sig,
            operatorId: operatorId,
            venueId: venueId,
            marketId: marketId,
            redeemed: false
        });
        emit AuthRegistered(marketKeyValue, outcomeIdx, owner, amount);
    }

    function _onEvent(address, bytes32[] calldata eventTopics, bytes calldata data) internal override {
        uint256 marketKeyValue = uint256(eventTopics[1]);
        (, , , , uint256[] memory payoutNumerators) = abi.decode(data, (uint64, address, uint256, bool, uint256[]));

        for (uint8 i = 0; i < 2 && i < payoutNumerators.length; i++) {
            Auth storage a = auths[marketKeyValue][i];
            if (a.owner == address(0)) continue;
            if (a.redeemed) continue;
            if (payoutNumerators[i] == 0) continue;

            a.redeemed = true;
            MODULE.redeemFor(a.owner, a.nonce, a.deadline, a.sig, a.operatorId, a.venueId, a.marketId, i, a.amount);
            emit AutoRedeemed(marketKeyValue, i, a.owner, a.amount);
        }
    }
}
