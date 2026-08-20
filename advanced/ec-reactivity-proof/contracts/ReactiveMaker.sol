// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IBinaryPool {
    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);

    function cancelOrder(uint128 orderId) external;
}

/// The reactive agent's core mechanic: a two-sided quote that cancels its
/// other side the instant one side fills, driven entirely on-chain by the
/// 0x0100 precompile delivering OrderFilled, no process in the loop.
///
/// Holds tUSDC directly, approves the pool once at construction. Owner-only
/// placeQuote records which of its two resting orders is the bid and which
/// is the ask. Every expiry is caller-supplied: this contract computes
/// nothing itself, unlike ContractOrderGate's hardcoded one-year horizon,
/// which CONTRACT-ORDER-GATE.md confirmed as the actual cause of every
/// 0xd3dea628 revert this project hit, not a caller-type restriction.
///
/// OrderFilled(uint128 indexed takerOrderId, uint128 indexed makerOrderId,
/// uint256 quantityFilled, uint256 takerRemainingQuantity, uint256
/// makerRemainingQuantity, uint256 fillPrice) is shared by SpotPool and
/// BinaryPool (the OrderBook base). makerOrderId is eventTopics[2]: topic0
/// is the signature hash, topic1 is takerOrderId, topic2 is makerOrderId.
contract ReactiveMaker is SomniaEventHandler {
    address public immutable owner;
    IBinaryPool public immutable pool;

    uint128 public bidOrderId;
    uint128 public askOrderId;

    event QuotePlaced(bool isBid, uint128 orderId);
    event Reacted(uint128 filledOrderId, uint128 cancelledOrderId);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address pool_, address collateral_) {
        owner = msg.sender;
        pool = IBinaryPool(pool_);
        IERC20(collateral_).approve(pool_, type(uint256).max);
    }

    /// kind: 0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO. expireTimestampNs
    /// must satisfy 0 < expireTimestampNs <= the market's own expiry; the
    /// caller is responsible for that, this contract does not compute or
    /// clamp it.
    function placeQuote(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, bool isBid) external onlyOwner returns (uint128 orderId) {
        (bool success, uint128 id) = pool.placeBinaryOrder(kind, price, quantity, expireTimestampNs, 3, 0, address(0), 0, 0);
        require(success, "place failed");
        if (isBid) bidOrderId = id;
        else askOrderId = id;
        emit QuotePlaced(isBid, id);
        return id;
    }

    function cancelQuote(uint128 orderId) external onlyOwner {
        pool.cancelOrder(orderId);
    }

    function _onEvent(address, bytes32[] calldata eventTopics, bytes calldata) internal override {
        uint128 makerOrderId = uint128(uint256(eventTopics[2]));
        if (makerOrderId == bidOrderId && askOrderId != 0) {
            uint128 toCancel = askOrderId;
            askOrderId = 0;
            pool.cancelOrder(toCancel);
            emit Reacted(makerOrderId, toCancel);
        } else if (makerOrderId == askOrderId && bidOrderId != 0) {
            uint128 toCancel = bidOrderId;
            bidOrderId = 0;
            pool.cancelOrder(toCancel);
            emit Reacted(makerOrderId, toCancel);
        }
    }
}
