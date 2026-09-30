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
 * - arm() binds the CALLER's own account, so a breaker cannot be seized by a
 *   stranger front-running its owner (see the note on arm itself).
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
     * @notice RENAMED FROM arm(), and not only for clarity.
     *
     * The fix did not change this function's ABI: it was and still is
     * arm(address,address,uint16), so the selector is identical and only the
     * MEANING of the first parameter moved — from the account being armed to
     * the owner being named. A caller holding the old ABI would keep compiling,
     * keep succeeding, and quietly arm its own breaker while believing it had
     * armed somebody else's. A security fix that can be misapplied in
     * silence is half a fix, so the name changes and stale callers revert.
     *
     * @notice Bind a breaker to the CALLER's account, naming who may configure
     * it. `configOwner` of address(0) means the account owns its own.
     *
     * THE ACCOUNT ARMS ITSELF. This took `account` as a parameter and bound
     * `owner: msg.sender` behind nothing but an AlreadyArmed check — a guard
     * that protects whoever calls FIRST, not the account being armed. Anyone
     * could arm anyone: front-run an owner's own arm, take the configuration,
     * then `halt()` them. Every mutating function after that is
     * `onlyOwner(account)` keyed on that first caller, so the real owner could
     * neither `reset` nor re-`arm`, and their agent would be stopped for good
     * with no recovery path. Reported as #147 by Alex (Yonkoo11), from source
     * only, before any deployment existed — which is why this costs nothing to
     * change now and would have been unfixable later.
     *
     * Binding to `msg.sender` removes the race rather than policing it: an
     * attacker can only ever arm their own account. The documented intent that
     * an EOA own the configuration survives, because the account NAMES that
     * EOA — consent that a first-come rule could only assume.
     *
     * address(0) means self, and that is not only ergonomics: `owner` is the
     * not-armed sentinel everywhere else in this contract, so a zero owner
     * would arm a breaker that every other function reads as unarmed.
     */
    function armSelf(address configOwner, address keeper, uint16 maxDrawdownBps) external {
        address account = msg.sender;
        if (breakers[account].owner != address(0)) revert AlreadyArmed();
        if (maxDrawdownBps == 0 || maxDrawdownBps > 10_000) revert BadThreshold();
        address owner = configOwner == address(0) ? account : configOwner;
        breakers[account] = Breaker({
            owner: owner,
            keeper: keeper,
            maxDrawdownBps: maxDrawdownBps,
            tripped: false,
            lastReportAt: 0,
            hwmUsdg: 0,
            lastEquityUsdg: 0
        });
        emit Armed(account, owner, keeper, maxDrawdownBps);
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
