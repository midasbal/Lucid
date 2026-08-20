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

/// Decisive gate: can a deployed contract place and cancel a binary order on
/// an event-contract pool while holding its own collateral? This contract
/// holds tUSDC directly (fund it with a plain ERC20 transfer to its own
/// address), approves the pool once at construction, and exposes owner-only
/// place and cancel. No inventory management, no pricing, no safety beyond
/// owner-gating: it proves the call path, nothing else.
contract ContractOrderGate {
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

    /// kind: 0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO. price/quantity are
    /// raw 6-decimal units, already tick/lot aligned by the caller. Always
    /// post-only (orderType 3): rests only, never takes. Expiry is set here,
    /// one year out, since the pool rejects a 0 or past expiry.
    function placeOrder(uint8 kind, uint256 price, uint256 quantity) external onlyOwner returns (uint128 orderId) {
        uint64 expiry = uint64((block.timestamp + 365 days) * 1e9);
        (bool success, uint128 id) = pool.placeBinaryOrder(kind, price, quantity, expiry, 3, 0, address(0), 0, 0);
        require(success, "place failed");
        return id;
    }

    function cancelOrder(uint128 orderId) external onlyOwner {
        pool.cancelOrder(orderId);
    }
}
