// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Trade} from "./interfaces/IPonsCurve.sol";

interface ITrencherV3Factory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}
interface ITrencherV3Router {
    struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256);
}

/// Holds discovered tokens so selling never needs a new account approval.
/// The owner is the smart account. Its session policy grants buy/sell only;
/// recovery is an owner-key operation. Pools and volume are not guarantees of value.
contract TrencherVault {
    uint256 public constant VERSION = 1;
    uint256 public constant PER_BUY = 5_000_000;
    uint256 public constant DAILY_BUYS = 25_000_000;
    address public immutable owner;
    address public immutable cash;
    address public immutable bridge;
    address public immutable router;
    address public immutable poolFactory;
    uint256 public spent;
    uint256 public windowStart;
    bool private entered;
    address[] private heldTokens;
    mapping(address => uint256) private heldIndex;
    mapping(address => uint256) public entryAt;
    mapping(address => uint256) public cost;

    error Unauthorized();
    error InvalidRoute();
    error InvalidAmount();
    error Expired();
    error BudgetExceeded();
    error TokenFailure();
    error InvalidFill();
    error Reentrant();
    event Bought(address indexed token, uint256 cashIn, uint256 tokensOut);
    event Sold(address indexed token, uint256 tokensIn, uint256 cashOut);
    event Recovered(address indexed token, uint256 amount);

    constructor(address owner_, address cash_, address bridge_, address router_, address factory_) {
        if (owner_ == address(0) || cash_ == bridge_ || cash_.code.length == 0 ||
            bridge_.code.length == 0 || router_.code.length == 0 || factory_.code.length == 0) revert InvalidRoute();
        owner = owner_; cash = cash_; bridge = bridge_; router = router_; poolFactory = factory_;
    }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }
    modifier guarded() { if (entered) revert Reentrant(); entered = true; _; entered = false; }

    // fee2=0 selects cash/token directly; otherwise cash/bridge/token.
    function buy(address token, uint24 fee1, uint24 fee2, uint256 cashIn, uint256 minOut, uint256 deadline)
        external onlyOwner guarded returns (uint256 received)
    {
        if (block.timestamp > deadline) revert Expired();
        if (cashIn == 0 || cashIn > PER_BUY || minOut == 0) revert InvalidAmount();
        bytes memory path = _path(token, fee1, fee2, true);
        if (block.timestamp >= windowStart + 1 days) { windowStart = block.timestamp; spent = 0; }
        if (spent + cashIn > DAILY_BUYS) revert BudgetExceeded();
        spent += cashIn;
        uint256 cashBefore = IERC20Trade(cash).balanceOf(address(this));
        uint256 beforeBalance = IERC20Trade(token).balanceOf(address(this));
        _call(cash, abi.encodeCall(IERC20Trade.transferFrom, (owner, address(this), cashIn)));
        if (IERC20Trade(cash).balanceOf(address(this)) != cashBefore + cashIn) revert InvalidFill();
        _approve(cash, cashIn);
        ITrencherV3Router(router).exactInput(ITrencherV3Router.ExactInputParams(path, address(this), cashIn, minOut));
        _approve(cash, 0);
        received = IERC20Trade(token).balanceOf(address(this)) - beforeBalance;
        if (received < minOut || IERC20Trade(cash).balanceOf(address(this)) != cashBefore) revert InvalidFill();
        if (heldIndex[token] == 0) { heldTokens.push(token); heldIndex[token] = heldTokens.length; }
        if (entryAt[token] == 0) entryAt[token] = block.timestamp;
        cost[token] += cashIn;
        emit Bought(token, cashIn, received);
    }

    // Selling is allowed even after the entry budget is exhausted.
    function sell(address token, uint24 fee1, uint24 fee2, uint256 tokensIn, uint256 minOut, uint256 deadline)
        external onlyOwner guarded returns (uint256 received)
    {
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0 || minOut == 0) revert InvalidAmount();
        bytes memory path = _path(token, fee1, fee2, false);
        uint256 cashBefore = IERC20Trade(cash).balanceOf(address(this));
        uint256 tokenBefore = IERC20Trade(token).balanceOf(address(this));
        _approve(token, tokensIn);
        ITrencherV3Router(router).exactInput(ITrencherV3Router.ExactInputParams(path, address(this), tokensIn, minOut));
        _approve(token, 0);
        received = IERC20Trade(cash).balanceOf(address(this)) - cashBefore;
        if (received < minOut || IERC20Trade(token).balanceOf(address(this)) != tokenBefore - tokensIn) revert InvalidFill();
        _call(cash, abi.encodeCall(IERC20Trade.transfer, (owner, received)));
        cost[token] -= cost[token] * tokensIn / tokenBefore;
        if (IERC20Trade(token).balanceOf(address(this)) == 0) _remove(token);
        emit Sold(token, tokensIn, received);
    }

    // Never included in a session-key permission. No recipient can be supplied.
    function recover(address token) external onlyOwner guarded {
        uint256 amount = IERC20Trade(token).balanceOf(address(this));
        _call(token, abi.encodeCall(IERC20Trade.transfer, (owner, amount)));
        _remove(token);
        emit Recovered(token, amount);
    }

    function tokens() external view returns (address[] memory) { return heldTokens; }
    function _remove(address token) private {
        uint256 i = heldIndex[token];
        if (i == 0) return;
        address last = heldTokens[heldTokens.length - 1];
        heldTokens[i - 1] = last; heldIndex[last] = i;
        heldTokens.pop(); delete heldIndex[token];
        delete entryAt[token]; delete cost[token];
    }

    function _path(address token, uint24 a, uint24 b, bool buying) private view returns (bytes memory) {
        if (token == cash || token == bridge || token.code.length == 0) revert InvalidRoute();
        address mid = b == 0 ? token : bridge;
        if (ITrencherV3Factory(poolFactory).getPool(cash, mid, a).code.length == 0) revert InvalidRoute();
        if (b != 0 && ITrencherV3Factory(poolFactory).getPool(bridge, token, b).code.length == 0) revert InvalidRoute();
        if (b == 0) return buying ? abi.encodePacked(cash, a, token) : abi.encodePacked(token, a, cash);
        return buying ? abi.encodePacked(cash, a, bridge, b, token) : abi.encodePacked(token, b, bridge, a, cash);
    }
    function _approve(address token, uint256 amount) private {
        _call(token, abi.encodeCall(IERC20Trade.approve, (router, 0)));
        if (amount != 0) _call(token, abi.encodeCall(IERC20Trade.approve, (router, amount)));
    }
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory result) = token.call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) revert TokenFailure();
    }
}

contract TrencherVaultFactory {
    address public immutable cash;
    address public immutable bridge;
    address public immutable router;
    address public immutable poolFactory;
    event Deployed(address indexed owner, address vault);
    constructor(address cash_, address bridge_, address router_, address factory_) {
        require(cash_ != bridge_ && cash_.code.length > 0 && bridge_.code.length > 0 && router_.code.length > 0 && factory_.code.length > 0, "invalid infrastructure");
        cash = cash_; bridge = bridge_; router = router_; poolFactory = factory_;
    }
    function vaultFor(address owner) public view returns (address) {
        bytes32 codeHash = keccak256(abi.encodePacked(type(TrencherVault).creationCode, abi.encode(owner, cash, bridge, router, poolFactory)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(uint160(owner))), codeHash)))));
    }
    function deploy(address owner) external returns (address vault) {
        vault = vaultFor(owner);
        if (vault.code.length == 0) {
            vault = address(new TrencherVault{salt: bytes32(uint256(uint160(owner)))}(owner, cash, bridge, router, poolFactory));
            emit Deployed(owner, vault);
        }
    }
}
