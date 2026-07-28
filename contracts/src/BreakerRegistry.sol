// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title BreakerRegistry
 * @notice The drawdown circuit breaker that lives OUTSIDE the agent. Promise #2
 * of merrymen ("it cannot lose more than you allow") requires a halt mechanism
 * the agent cannot argue with, reason around, or forget: once an account's
 * drawdown from its high-water mark reaches the owner's threshold, the breaker
 * trips and the paired KernelBreakerPolicy fails every subsequent UserOp at
 * validation — the session key keeps signing, the chain keeps refusing.
 *
 * Threat model (Phase 2, documented honestly):
 * - Equity is REPORTED by a keeper (the worker) or the owner, not computed
 *   in-contract. A malicious keeper could under-report drawdown; the mitigation
 *   is that the keeper can only make the breaker MORE likely to trip (reports
 *   ratchet the HWM up and can trip, never untrip) and the owner can always
 *   trip manually. Untripping (reset) is owner-only.
 * - trip() is permissionless but only enforces already-reported numbers, so
 *   anyone can force the halt the data supports; nobody can halt on fantasy.
 * - The breaker fails CLOSED at the policy layer: no registry configured for a
 *   wallet → that policy id refuses every op.
 */
contract BreakerRegistry {
    struct Breaker {
        address owner;
        address keeper;
        uint16 maxDrawdownBps; // 10_000 = 100%
        bool tripped;
        uint64 lastReportAt;
        uint128 hwmUsdg; // USDG 6dp
        uint128 lastEquityUsdg; // USDG 6dp
    }

    mapping(address account => Breaker) private breakers;

    event Armed(address indexed account, address indexed owner, address keeper, uint16 maxDrawdownBps);
    event KeeperSet(address indexed account, address keeper);
    event ThresholdSet(address indexed account, uint16 maxDrawdownBps);
    event EquityReported(address indexed account, uint128 equityUsdg, uint128 hwmUsdg);
    event Tripped(address indexed account, uint128 equityUsdg, uint128 hwmUsdg, uint256 drawdownBps);
    event Reset(address indexed account, bool hwmRebased);

    error AlreadyArmed();
    error NotArmed();
    error NotOwner();
    error NotReporter();
    error BadThreshold();
    error DrawdownNotReached();

    modifier onlyOwner(address account) {
        if (breakers[account].owner != msg.sender) revert NotOwner();
        _;
    }

    /**
     * @notice Bind a breaker to `account`. First-come owner binding: callable
     * once per account, by the account itself (sudo call during grant setup)
     * or by the EOA that will own the configuration.
     */
    function arm(address account, address keeper, uint16 maxDrawdownBps) external {
        if (breakers[account].owner != address(0)) revert AlreadyArmed();
        if (maxDrawdownBps == 0 || maxDrawdownBps > 10_000) revert BadThreshold();
        breakers[account] = Breaker({
            owner: msg.sender,
            keeper: keeper,
            maxDrawdownBps: maxDrawdownBps,
            tripped: false,
            lastReportAt: 0,
            hwmUsdg: 0,
            lastEquityUsdg: 0
        });
        emit Armed(account, msg.sender, keeper, maxDrawdownBps);
    }

    function setKeeper(address account, address keeper) external onlyOwner(account) {
        breakers[account].keeper = keeper;
        emit KeeperSet(account, keeper);
    }

    function setThreshold(address account, uint16 maxDrawdownBps) external onlyOwner(account) {
        if (maxDrawdownBps == 0 || maxDrawdownBps > 10_000) revert BadThreshold();
        breakers[account].maxDrawdownBps = maxDrawdownBps;
        emit ThresholdSet(account, maxDrawdownBps);
    }

    /**
     * @notice Report the account's current equity (USDG 6dp). Keeper or owner.
     * Ratchets the HWM up on new highs and trips automatically the moment the
     * reported drawdown reaches the threshold. Reports can trip, never untrip.
     */
    function reportEquity(address account, uint128 equityUsdg) external {
        Breaker storage b = breakers[account];
        if (b.owner == address(0)) revert NotArmed();
        if (msg.sender != b.keeper && msg.sender != b.owner) revert NotReporter();

        b.lastEquityUsdg = equityUsdg;
        b.lastReportAt = uint64(block.timestamp);
        if (equityUsdg > b.hwmUsdg) b.hwmUsdg = equityUsdg;
        emit EquityReported(account, equityUsdg, b.hwmUsdg);

        _maybeTrip(account, b);
    }

    /**
     * @notice Permissionless enforcement: trip the breaker if the ALREADY
     * REPORTED numbers cross the threshold. Reverts otherwise.
     */
    function trip(address account) external {
        Breaker storage b = breakers[account];
        if (b.owner == address(0)) revert NotArmed();
        if (!_maybeTrip(account, b)) revert DrawdownNotReached();
    }

    /**
     * @notice Owner-only manual halt — no drawdown precondition. The owner can
     * always stop their agent.
     */
    function halt(address account) external onlyOwner(account) {
        Breaker storage b = breakers[account];
        if (!b.tripped) {
            b.tripped = true;
            emit Tripped(account, b.lastEquityUsdg, b.hwmUsdg, _drawdownBps(b));
        }
    }

    /**
     * @notice Owner-only reset after review. `rebaseHwm` restarts the peak at
     * the current equity so the same drawdown doesn't immediately re-trip.
     */
    function reset(address account, bool rebaseHwm) external onlyOwner(account) {
        Breaker storage b = breakers[account];
        b.tripped = false;
        if (rebaseHwm) b.hwmUsdg = b.lastEquityUsdg;
        emit Reset(account, rebaseHwm);
    }

    function isTripped(address account) external view returns (bool) {
        return breakers[account].tripped;
    }

    function get(address account) external view returns (Breaker memory) {
        return breakers[account];
    }

    function drawdownBps(address account) external view returns (uint256) {
        return _drawdownBps(breakers[account]);
    }

    function _drawdownBps(Breaker storage b) private view returns (uint256) {
        if (b.hwmUsdg == 0) return 0;
        if (b.lastEquityUsdg >= b.hwmUsdg) return 0;
        return (uint256(b.hwmUsdg - b.lastEquityUsdg) * 10_000) / b.hwmUsdg;
    }

    function _maybeTrip(address account, Breaker storage b) private returns (bool) {
        if (b.tripped) return true;
        uint256 dd = _drawdownBps(b);
        if (dd >= b.maxDrawdownBps) {
            b.tripped = true;
            emit Tripped(account, b.lastEquityUsdg, b.hwmUsdg, dd);
            return true;
        }
        return false;
    }
}
