// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";

/// Minimal proof that the Somnia reactivity precompile can call back into a
/// contract we deployed. Does one observable thing per matched event: emits
/// ReactiveHit and increments hitCount. No other logic.
contract ReactiveHitHandler is SomniaEventHandler {
    event ReactiveHit(address emitter, bytes32 topic0, uint256 blockNumber);

    uint256 public hitCount;

    function _onEvent(address emitter, bytes32[] calldata eventTopics, bytes calldata) internal override {
        hitCount += 1;
        emit ReactiveHit(emitter, eventTopics[0], block.number);
    }
}
