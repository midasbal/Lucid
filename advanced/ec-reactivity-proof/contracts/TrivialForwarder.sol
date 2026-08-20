// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

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

/// Even more trivial than ContractOrderGate: no expiry computation, no
/// return value handling, no require on the forwarded call's own success.
/// Exists only to rule out anything specific to ContractOrderGate's own
/// logic being the reason a contract-mediated order reverts.
contract TrivialForwarder {
    address public immutable owner;
    IBinaryPool public immutable pool;

    constructor(address pool_, address collateral_) {
        owner = msg.sender;
        pool = IBinaryPool(pool_);
        IERC20(collateral_).approve(pool_, type(uint256).max);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

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
    ) external onlyOwner {
        pool.placeBinaryOrder(kind, price, quantity, expireTimestampNs, orderType, selfMatchingOption, builder, builderFeeBpsTimes1k, userData);
    }

    function cancelOrder(uint128 orderId) external onlyOwner {
        pool.cancelOrder(orderId);
    }
}
