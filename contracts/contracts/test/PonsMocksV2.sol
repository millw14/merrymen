// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Mocks that exist only for PonsClassVaultV2's per-quote caps.
 *
 * A SEPARATE FILE FROM PonsMocks.sol ON PURPOSE. That file is the fixture set
 * v1's suite runs against, and v1's bytecode is frozen at a deployed address —
 * so its tests and their mocks stay byte-identical while a v1 vault still holds
 * a balance. Everything here is about a claim v1 could not make: that two quote
 * assets with different decimals each have their own ceiling, and that the
 * vault reads no price and no share multiplier to enforce either.
 */

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

interface IClassVaultV2Like {
    function buy(address curve, address quoteAsset, uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        returns (uint256);
}

/**
 * An ERC-20 that knows its own decimals.
 *
 * The vault never reads `decimals()` — that is the point of a raw cap — but a
 * test that seals 250_000_000 against a 6dp quote and 1e18 against an 18dp one
 * should be able to say which is which, or the reader cannot tell the
 * decimal-straddle case from two arbitrary numbers.
 */
contract PonsMockDecimalERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public immutable decimals;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

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
 * A quote asset that REVERTS on every question a price layer would ask it.
 *
 * `uiMultiplier()`, `tokenPaused()` and `latestRoundData()` are the three reads
 * the off-chain side makes of a stock quote — ERC-8056 share scaling, the
 * issuer's pause switch, and the Chainlink feed. The ruling says the vault must
 * not depend on any of them at execution time. Asserting that by reading the
 * source is weak; making every one of them revert and then completing a full
 * buy and sell against this token proves it from the bytecode.
 */
contract PonsMockStockQuoteERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public constant decimals = 18;

    error OracleNotAvailable();

    function uiMultiplier() external pure returns (uint256) {
        revert OracleNotAvailable();
    }

    function tokenPaused() external pure returns (bool) {
        revert OracleNotAvailable();
    }

    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert OracleNotAvailable();
    }

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
 * A quote token that re-enters the vault from inside `transferFrom`.
 *
 * THE HOSTILE-ISSUER CASE, and it is not hypothetical: a Stock Token is a
 * BeaconProxy whose issuer can upgrade every one of them in a single
 * transaction. If that issuer turned the quote asset against the vault, the
 * pull is the moment it would act — the window has been charged and the
 * contract is mid-trade. `only()`'s flag is what stops it, and this proves the
 * flag covers the token and not only the curve.
 */
contract PonsMockReentrantQuoteERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public vault;
    address public curve;
    bool public armed;

    function arm(address vault_, address curve_) external {
        vault = vault_;
        curve = curve_;
        armed = true;
    }

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
        if (armed) {
            armed = false;
            // Straight back into the contract that is mid-trade.
            IClassVaultV2Like(vault).buy(curve, address(this), amount, 0, type(uint256).max);
        }
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/**
 * A curve that re-enters the vault THROUGH THE OWNER, which is the only way in.
 *
 * A hostile curve calling the vault directly is stopped at `msg.sender != owner`
 * before the re-entrancy flag is ever consulted — a stronger refusal, and the
 * reason the direct-re-entry mock below reverts `NotOwner`. The flag exists for
 * the case that check cannot catch: a call that really does arrive from the
 * owner while a trade is in flight. This curve produces it by asking the account
 * (a `MockKernelBatch`) to call `buy` again from inside the first `buy`.
 */
contract MockOwnerReentrantCurve {
    address public token;
    address public pairToken;
    bool public graduated;
    address public account;
    address public vault;

    constructor(address _token, address _pairToken) {
        token = _token;
        pairToken = _pairToken;
    }

    function arm(address account_, address vault_) external {
        account = account_;
        vault = vault_;
    }

    function getReserves() external pure returns (uint256, uint256) {
        return (1.68e18, 1e27);
    }

    function buy(uint256 quoteIn, uint256, address) external payable returns (uint256) {
        IERC20Like(pairToken).transferFrom(msg.sender, address(this), quoteIn);
        IBatchRunner.Call[] memory calls = new IBatchRunner.Call[](1);
        calls[0] = IBatchRunner.Call({
            target: vault,
            value: 0,
            data: abi.encodeWithSelector(
                IClassVaultV2Like.buy.selector, address(this), pairToken, quoteIn, 0, type(uint256).max
            )
        });
        IBatchRunner(account).execute(calls);
        return 0;
    }

    function sell(uint256 tokensIn, uint256, address recipient) external returns (uint256) {
        IERC20Like(token).transferFrom(msg.sender, address(this), tokensIn);
        IERC20Like(pairToken).transfer(recipient, tokensIn);
        return tokensIn;
    }
}

interface IBatchRunner {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    function execute(Call[] calldata calls) external payable;
}

/** A curve that re-enters the VAULT's `buy` directly, as itself. */
contract MockReentrantClassCurve {
    address public token;
    address public pairToken;
    bool public graduated;
    address public vault;

    constructor(address _token, address _pairToken) {
        token = _token;
        pairToken = _pairToken;
    }

    function setVault(address v) external {
        vault = v;
    }

    function getReserves() external pure returns (uint256, uint256) {
        return (1.68e18, 1e27);
    }

    function buy(uint256 quoteIn, uint256, address) external payable returns (uint256) {
        IERC20Like(pairToken).transferFrom(msg.sender, address(this), quoteIn);
        IClassVaultV2Like(vault).buy(address(this), pairToken, quoteIn, 0, type(uint256).max);
        return 0;
    }

    function sell(uint256 tokensIn, uint256, address recipient) external returns (uint256) {
        IERC20Like(token).transferFrom(msg.sender, address(this), tokensIn);
        IERC20Like(pairToken).transfer(recipient, tokensIn);
        return tokensIn;
    }
}

/**
 * A Kernel v3.3 BATCH/DEFAULT executor, in miniature.
 *
 * WHY A MOCK WHEN THE REAL THING WAS MEASURED. The real behaviour — one
 * reverting inner call reverts the whole batch — was proved on chain 4663 at
 * block 64670932 by scripts/probe-kernel-batch-atomicity.mts, against the
 * deployed account. That proof cannot run in hardhat, and the property the
 * vault depends on is that `[deploy, approve, buy]` either all happens or none
 * of it does — including that a REFUSED buy leaves no vault behind. This runner
 * has no try/catch, which is exactly what EXEC_TYPE.DEFAULT means, so the two
 * halves of the claim can be tested here and on chain respectively.
 */
contract MockKernelBatch {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @dev Bubbles the first failure. No try, no catch, no continue — the
    /// difference between DEFAULT and TRY_EXEC, which is the whole question.
    function execute(Call[] calldata calls) external payable {
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}

/**
 * A token whose `transfer` returns true and moves less than it was asked to —
 * or nothing at all.
 *
 * ORDINARY, NOT EXOTIC. A soft honeypot and a maxTx-clamping memecoin both
 * behave this way, and the class vault exists precisely to hold tokens written
 * by whoever launched the curve. `_push` proves only that the call did not
 * revert and did not return false, so without a post-transfer measurement the
 * vault would emit a full-size `Swept` for tokens that never arrived — and the
 * off-chain fold sums those, telling an owner they took home capital that is
 * still sitting in the vault.
 */
contract PonsMockClampingERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public constant decimals = 18;

    /// @dev The most any one transfer will actually move. Zero means "move nothing".
    uint256 public clampTo;

    constructor(uint256 clampTo_) {
        clampTo = clampTo_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// @dev Reports success either way. That is the whole point.
    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 moved = amount > clampTo ? clampTo : amount;
        balanceOf[msg.sender] -= moved;
        balanceOf[to] += moved;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        uint256 moved = amount > clampTo ? clampTo : amount;
        balanceOf[from] -= moved;
        balanceOf[to] += moved;
        return true;
    }
}
