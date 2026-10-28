use anchor_lang::prelude::*;
pub const MAX_OPS: usize = 96;
pub const DAY: i64 = 86_400;
/// The longest session an owner can sign: 7 days, the 168 hours the server grants
/// (packages/core/src/solana.ts SOLANA_MAX_PERMISSION_MS). web-auth F4: the cap
/// holds on-chain too, so a create_session signed outside Merrymen cannot hand a
/// hot session key a longer life.
pub const MAX_SESSION: i64 = 7 * DAY;
/// How far past MAX_SESSION an expiry may sit. A duration is picked against the
/// owner's and the server's clocks, not the cluster's; the server allows 5 minutes
/// of skew (SOLANA_PERMISSION_CLOCK_SKEW_MS) and this leaves 10 more for a cluster
/// clock running behind.
pub const SESSION_CLOCK_ALLOWANCE: i64 = 15 * 60;
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Debit {
    pub timestamp: i64,
    /// USDG charged: the input of a buy, the cash proceeds of a sell.
    pub notional: u64,
    /// WSOL charged: the input of a sell, zero for a buy.
    pub wsol: u64,
}
/// Owner-signed session bounds. USDG caps bound buys and sell proceeds; the
/// WSOL caps bound what a sell may put in, whatever price it is quoted at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub per_trade: u64,
    pub daily: u64,
    pub per_trade_wsol: u64,
    pub daily_wsol: u64,
    pub max_ops: u16,
    pub expiry: i64,
}
#[derive(Debug, PartialEq, Eq)]
pub enum RiskError {
    InvalidLimits,
    Expired,
    ClockRegression,
    PerTrade,
    Daily,
    WsolPerTrade,
    WsolDaily,
    Operations,
    Overflow,
    SessionTooLong,
}
pub fn limits(l: &Limits, now: i64) -> std::result::Result<(), RiskError> {
    if l.per_trade == 0
        || l.per_trade > l.daily
        || l.per_trade_wsol == 0
        || l.per_trade_wsol > l.daily_wsol
        || l.max_ops == 0
        || l.max_ops as usize > MAX_OPS
    {
        return Err(RiskError::InvalidLimits);
    }
    if now < 0 || l.expiry <= now {
        return Err(RiskError::Expired);
    }
    Ok(())
}
/// The bounds create_session accepts: valid limits, and an expiry no later than
/// MAX_SESSION plus SESSION_CLOCK_ALLOWANCE after the cluster clock. Only a new
/// session is held to the cap; a running session is judged by `limits` alone.
pub fn session(l: &Limits, now: i64) -> std::result::Result<(), RiskError> {
    limits(l, now)?;
    let latest = now
        .checked_add(MAX_SESSION + SESSION_CLOCK_ALLOWANCE)
        .ok_or(RiskError::Overflow)?;
    if l.expiry > latest {
        return Err(RiskError::SessionTooLong);
    }
    Ok(())
}
pub fn record(
    debits: &[Debit],
    notional: u64,
    wsol: u64,
    l: &Limits,
    now: i64,
) -> std::result::Result<Vec<Debit>, RiskError> {
    limits(l, now)?;
    if notional == 0 || notional > l.per_trade {
        return Err(RiskError::PerTrade);
    }
    if wsol > l.per_trade_wsol {
        return Err(RiskError::WsolPerTrade);
    }
    let cutoff = now.checked_sub(DAY).ok_or(RiskError::Overflow)?;
    if debits.len() > MAX_OPS || debits.iter().any(|d| d.timestamp > now || d.timestamp < 0) {
        return Err(RiskError::ClockRegression);
    }
    let mut kept: Vec<_> = debits
        .iter()
        .filter(|d| d.timestamp > cutoff)
        .cloned()
        .collect();
    if kept.len() >= l.max_ops as usize {
        return Err(RiskError::Operations);
    }
    let total = kept.iter().try_fold(notional, |sum, d| {
        sum.checked_add(d.notional).ok_or(RiskError::Overflow)
    })?;
    if total > l.daily {
        return Err(RiskError::Daily);
    }
    let total_wsol = kept.iter().try_fold(wsol, |sum, d| {
        sum.checked_add(d.wsol).ok_or(RiskError::Overflow)
    })?;
    if total_wsol > l.daily_wsol {
        return Err(RiskError::WsolDaily);
    }
    kept.push(Debit {
        timestamp: now,
        notional,
        wsol,
    });
    Ok(kept)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn caps(per_trade: u64, daily: u64, max_ops: u16, expiry: i64) -> Limits {
        Limits {
            per_trade,
            daily,
            per_trade_wsol: 1_000,
            daily_wsol: 10_000,
            max_ops,
            expiry,
        }
    }
    fn debit(timestamp: i64, notional: u64) -> Debit {
        Debit {
            timestamp,
            notional,
            wsol: 0,
        }
    }
    #[test]
    fn rolling_exact_boundary() {
        let ds = vec![debit(100, 40), debit(101, 30)];
        let l = caps(100, 100, 4, 100000);
        assert_eq!(record(&ds, 70, 0, &l, 86500).unwrap().len(), 2);
        assert_eq!(record(&ds, 71, 0, &l, 86500), Err(RiskError::Daily));
    }
    #[test]
    fn no_clock_rollback() {
        assert_eq!(
            record(&[debit(101, 1)], 1, 0, &caps(100, 100, 4, 1000), 100),
            Err(RiskError::ClockRegression)
        );
    }
    #[test]
    fn ops_and_expiry() {
        assert_eq!(
            record(&[debit(1, 1)], 1, 0, &caps(5, 100, 1, 1000), 2),
            Err(RiskError::Operations)
        );
        assert_eq!(
            record(&[], 1, 0, &caps(5, 100, 1, 2), 2),
            Err(RiskError::Expired)
        );
    }
    #[test]
    fn limits_and_overflow() {
        assert_eq!(
            record(&[], 6, 0, &caps(5, 100, 1, 1000), 2),
            Err(RiskError::PerTrade)
        );
        assert_eq!(
            limits(&caps(10, 5, 1, 1000), 2),
            Err(RiskError::InvalidLimits)
        );
        assert_eq!(
            record(&[debit(1, u64::MAX)], 1, 0, &caps(5, u64::MAX, 2, 1000), 2),
            Err(RiskError::Overflow)
        );
    }
    #[test]
    fn replacement_never_erases_history() {
        let old = record(&[], 60, 0, &caps(60, 100, 10, 1000), 10).unwrap();
        assert_eq!(
            record(&old, 50, 0, &caps(60, 100, 10, 2000), 11),
            Err(RiskError::Daily)
        );
    }
    #[test]
    fn a_new_session_ends_within_seven_days_and_the_clock_allowance() {
        let now = 1_800_000_000;
        let latest = now + 7 * 86_400 + 15 * 60;
        assert_eq!(session(&caps(5, 100, 1, latest), now), Ok(()));
        assert_eq!(session(&caps(5, 100, 1, now + 1), now), Ok(()));
        for expiry in [latest + 1, now + 30 * 86_400, 4_000_000_000, i64::MAX] {
            assert_eq!(
                session(&caps(5, 100, 1, expiry), now),
                Err(RiskError::SessionTooLong),
                "expiry {expiry}"
            );
        }
        // The cap is measured from the cluster clock when the session is created.
        assert_eq!(session(&caps(5, 100, 1, latest + 1), now + 1), Ok(()));
        // The ordinary limits still apply first: an expired or invalid session is refused as before.
        assert_eq!(session(&caps(5, 100, 1, now), now), Err(RiskError::Expired));
        assert_eq!(session(&caps(10, 5, 1, now + 1), now), Err(RiskError::InvalidLimits));
        // A clock near i64::MAX cannot overflow its way past the cap.
        assert_eq!(
            session(&caps(5, 100, 1, i64::MAX), i64::MAX - 1),
            Err(RiskError::Overflow)
        );
    }
    #[test]
    fn a_running_session_is_not_held_to_the_creation_cap() {
        // record judges trades by the signed limits only; the cap is create_session's.
        let l = caps(100, 100, 4, 4_000_000_000);
        assert_eq!(record(&[], 1, 0, &l, 2).unwrap().len(), 1);
    }
    #[test]
    fn a_session_without_a_wsol_input_bound_is_refused() {
        for (per_trade_wsol, daily_wsol) in [(0, 0), (0, 10), (11, 10)] {
            let l = Limits {
                per_trade_wsol,
                daily_wsol,
                ..caps(5, 100, 1, 1000)
            };
            assert_eq!(limits(&l, 2), Err(RiskError::InvalidLimits));
        }
    }
    #[test]
    fn sells_are_bounded_on_input_however_little_cash_they_return() {
        let l = caps(100, 150, 10, 1000);
        // A dust-priced full exit costs 1 micro-USDG but puts 5000 lamports in.
        assert_eq!(record(&[], 1, 5_000, &l, 2), Err(RiskError::WsolPerTrade));
        let first = record(&[], 1, 1_000, &l, 2).unwrap();
        assert_eq!(first[0].wsol, 1_000);
        // Rolling WSOL input accumulates independently of cash proceeds.
        let mut ds = first;
        for t in 3..12 {
            ds = record(&ds, 1, 1_000, &caps(100, 150, 96, 1000), t).unwrap();
        }
        assert_eq!(
            record(&ds, 1, 1, &caps(100, 150, 96, 1000), 12),
            Err(RiskError::WsolDaily)
        );
        // The window rolls: a day later the same input fits again.
        assert!(record(&ds, 1, 1_000, &caps(100, 150, 96, 100_000), 86_403).is_ok());
    }
    #[test]
    fn buys_charge_no_wsol_and_keep_the_cash_caps() {
        let l = caps(100, 150, 10, 1000);
        let ds = record(&[], 100, 0, &l, 2).unwrap();
        assert_eq!(ds[0].wsol, 0);
        assert_eq!(record(&ds, 51, 0, &l, 3), Err(RiskError::Daily));
    }
    #[test]
    fn replacing_the_session_never_resets_the_wsol_budget() {
        let old = record(
            &[],
            1,
            9_000,
            &Limits {
                per_trade_wsol: 9_000,
                ..caps(10, 100, 10, 1000)
            },
            10,
        )
        .unwrap();
        let replaced = Limits {
            per_trade_wsol: 9_000,
            ..caps(10, 100, 10, 2000)
        };
        assert_eq!(
            record(&old, 1, 1_001, &replaced, 11),
            Err(RiskError::WsolDaily)
        );
    }
}
