// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title PonsMocks
 * @notice Test doubles for PonsSelfTrade. TEST-ONLY — never deployed anywhere.
 *
 * The real curve is a 10,229-byte contract with no published source, so this
 * reproduces only what the adapter actually depends on: the buy/sell/token/
 * pairToken/graduated surface, the fact that the curve pulls its input from ITS
 * CALLER by transferFrom, and the fact that it pays a caller-named `recipient`
 * directly. Those five behaviours were each confirmed against mainnet 4663 —
 * the selectors are present in a live curve's runtime code and a `buy` was
 * simulated through `eth_call` — and this file is not trying to be a faithful
 * bonding curve. The pricing is a fixed ratio, deliberately: what these tests
 * exist to prove is the half that is OURS.
 *
 * MockHostileCurve is the important one. The adapter cannot authenticate a
 * curve, so the security argument has to hold against a curve that lies, and
 * that argument is only worth as much as a test that actually lies.
 */

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/** A plain ERC-20 that returns true. */
contract PonsMockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/**
 * An ERC-20 that refuses a non-zero → non-zero allowance change, like USDT.
 *
 * Standalone rather than inheriting PonsMockERC20: marking the parent's approve
 * `virtual` purely so one test double could override it would put a keyword in
 * the shared mock for the benefit of a single subclass.
 */
contract PonsMockStickyApprovalERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(amount == 0 || allowance[msg.sender][spender] == 0, "approve from non-zero");
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/**
 * A Pons bonding curve, reduced to the surface the adapter uses.
 *
 * Pulls the input from ITS CALLER (the adapter) and pays `recipient` directly —
 * both verified behaviours of the real contract, and both load-bearing: the
 * first is why the adapter must hold the input for two opcodes, the second is
 * why it never touches the output at all.
 */
contract MockPonsCurve {
    address public token;
    address public pairToken;
    bool public graduated;
    /// @dev out = in * rateNum / rateDen. A fixed ratio, not a curve.
    uint256 public rateNum = 2;
    uint256 public rateDen = 1;
    /// @dev When set, the curve takes less than it was approved for.
    uint256 public takeFraction = 100;

    constructor(address _token, address _pairToken) {
        token = _token;
        pairToken = _pairToken;
    }

    function setGraduated(bool v) external { graduated = v; }
    function setRate(uint256 n, uint256 d) external { rateNum = n; rateDen = d; }
    function setTakeFraction(uint256 pct) external { takeFraction = pct; }

    function getReserves() external pure returns (uint256, uint256) {
        return (1.68e18, 1e27);
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256) {
        uint256 take = (quoteIn * takeFraction) / 100;
        IERC20Like(pairToken).transferFrom(msg.sender, address(this), take);
        uint256 out = (quoteIn * rateNum) / rateDen;
        require(out >= minTokensOut, "SlippageExceeded");
        IERC20Like(token).transfer(recipient, out);
        return out;
    }

    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256) {
        IERC20Like(token).transferFrom(msg.sender, address(this), tokensIn);
        uint256 out = (tokensIn * rateNum) / rateDen;
        require(out >= minQuoteOut, "SlippageExceeded");
        IERC20Like(pairToken).transfer(recipient, out);
        return out;
    }
}

/**
 * A curve that reports whatever it is told to and PAYS NOBODY.
 *
 * The adapter's threat model says a hostile curve can take the input and give
 * nothing back, bounded only by the standing allowance — and that the adapter's
 * own balance check is what turns that into a revert rather than a silent loss.
 * This is the contract that makes that claim testable instead of asserted.
 */
contract MockHostileCurve {
    address public token;
    address public pairToken;
    bool public graduated;

    constructor(address _token, address _pairToken) {
        token = _token;
        pairToken = _pairToken;
    }

    function getReserves() external pure returns (uint256, uint256) {
        return (1.68e18, 1e27);
    }

    /// @dev Basis points of the input actually paid out. 0 = pays nothing.
    uint256 public payBps;

    function setPayBps(uint256 v) external { payBps = v; }

    /// @dev Takes the money, IGNORES minOut entirely, returns a large number,
    /// and pays out whatever it feels like. The curve accepting a floor it has
    /// no intention of honouring is exactly why the adapter checks for itself.
    function buy(uint256 quoteIn, uint256, address recipient) external payable returns (uint256) {
        IERC20Like(pairToken).transferFrom(msg.sender, address(this), quoteIn);
        uint256 out = (quoteIn * payBps) / 10_000;
        if (out > 0) IERC20Like(token).transfer(recipient, out);
        return type(uint128).max;
    }

    function sell(uint256 tokensIn, uint256, address) external returns (uint256) {
        IERC20Like(token).transferFrom(msg.sender, address(this), tokensIn);
        return type(uint128).max;
    }
}

/** A curve that tries to re-enter the adapter while it holds the input. */
contract MockReentrantCurve {
    address public token;
    address public pairToken;
    bool public graduated;
    address public adapter;

    constructor(address _token, address _pairToken) {
        token = _token;
        pairToken = _pairToken;
    }

    function setAdapter(address a) external { adapter = a; }

    function getReserves() external pure returns (uint256, uint256) {
        return (1.68e18, 1e27);
    }

    function buy(uint256 quoteIn, uint256, address) external payable returns (uint256) {
        // Re-enter with the same shape. The guard must stop this.
        (bool ok, bytes memory ret) = adapter.call(
            abi.encodeWithSignature(
                "tradeExactIn(address,address,address,uint128,uint128,uint256)",
                address(this), pairToken, token, uint128(quoteIn), uint128(0), type(uint256).max
            )
        );
        // Bubble the adapter's revert so the test can name it.
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        return 0;
    }

    function sell(uint256, uint256, address) external pure returns (uint256) {
        return 0;
    }
}

/**
 * A NATIVE-QUOTED curve: `pairToken()` is the zero address and the quote side is
 * real ETH.
 *
 * The distinction that matters for PonsNativeTrade is that `sell` pays the
 * RECIPIENT in native ETH directly — which is the whole reason that adapter can
 * be non-payable, hold nothing, and need no `receive()`. This mock is what makes
 * that testable rather than argued.
 *
 * Like its sibling it is a fixed ratio, not a curve, and says so: it is not
 * trying to be a faithful bonding curve, only a faithful COUNTERPARTY.
 */
contract MockNativePonsCurve {
    address public token;
    address public pairToken; // stays address(0) — that is the point
    bool public graduated;
    uint256 public rateNum = 2;
    uint256 public rateDen = 1;

    constructor(address _token) {
        token = _token;
    }

    function setGraduated(bool v) external { graduated = v; }
    function setRate(uint256 n, uint256 d) external { rateNum = n; rateDen = d; }
    /// @dev Pay this PERCENT of what it claims. Models the curve grading its own
    /// homework: the slippage check below still passes on the CLAIMED figure
    /// while the transfer is short. Only a balance check on the caller catches it.
    uint256 public payPct = 100;
    function setPayPct(uint256 p) external { payPct = p; }

    function getReserves() external pure returns (uint256, uint256) {
        return (1.68e18, 1e27);
    }

    /// @dev Payable, and `msg.value` must equal `quoteIn` exactly — the real
    /// curve reverts NativeValueMismatch otherwise, takes no change, gives none.
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256)
    {
        require(msg.value == quoteIn, "NativeValueMismatch");
        uint256 out = (quoteIn * rateNum) / rateDen;
        require(out >= minTokensOut, "SlippageExceeded");
        // Same lie as the sell side: pass our own check on the CLAIMED figure,
        // then deliver less. Only the caller-balance read catches it.
        IERC20Like(token).transfer(recipient, (out * payPct) / 100);
        return out;
    }

    /// @dev Pulls tokens from its caller, pays the recipient in ETH DIRECTLY.
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
        external
        returns (uint256)
    {
        IERC20Like(token).transferFrom(msg.sender, address(this), tokensIn);
        uint256 out = (tokensIn * rateNum) / rateDen;
        require(out >= minQuoteOut, "SlippageExceeded");
        (bool ok, ) = recipient.call{value: (out * payPct) / 100}("");
        require(ok, "NativePayFailed");
        return out;
    }

    /// @dev So a test can fund the quote side.
    receive() external payable {}
}

/**
 * A native curve that takes the tokens and pays NO ETH.
 *
 * The adapter's guarantee is that it measures the CALLER's own balance change
 * rather than trusting the curve's return value. Without a counterparty willing
 * to lie, that claim is untestable — and on this launchpad the counterparty is
 * chosen by whoever launched the token.
 */
contract MockHostileNativeCurve {
    address public token;
    address public pairToken; // address(0)
    bool public graduated;

    constructor(address _token) {
        token = _token;
    }

    function getReserves() external pure returns (uint256, uint256) {
        return (1.68e18, 1e27);
    }

    function buy(uint256, uint256, address) external payable returns (uint256) {
        // Keeps the ETH, delivers nothing.
        return 0;
    }

    function sell(uint256 tokensIn, uint256, address) external returns (uint256) {
        // Takes the tokens, pays nobody, and claims it went fine.
        IERC20Like(token).transferFrom(msg.sender, address(this), tokensIn);
        return 999;
    }

    receive() external payable {}
}
