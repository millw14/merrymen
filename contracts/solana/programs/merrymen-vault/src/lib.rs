//! Owner custody with a bounded session and an isolated, single-sequence Jupiter signer.
//! This public program identity is for local tests; no deployment is supplied.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_option::COption,
};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{
        transfer_fee::TransferFeeConfig, transfer_hook::TransferHook, BaseStateWithExtensions,
        ExtensionType, StateWithExtensions,
    },
    state::Mint as RawMint,
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked},
};
pub mod risk;
use risk::{Debit, Limits};
declare_id!("EUzYVniKtgNNgFweMtRA9vciTWtE8MDTRfh6ai6VvXoU");
pub const USDG: Pubkey = pubkey!("2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH");
pub const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const JUPITER: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
pub const SHARED_ROUTE: [u8; 8] = [193, 32, 155, 51, 65, 214, 156, 129];
/// Layout 2 adds the owner-signed WSOL input caps; layout 1 vaults are refused.
pub const VERSION: u8 = 2;

#[program]
pub mod merrymen_vault {
    use super::*;
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.version = VERSION;
        v.bump = ctx.bumps.vault;
        v.owner = ctx.accounts.owner.key();
        v.session = Pubkey::default();
        v.session_epoch = 0;
        v.seq = 0;
        v.expires_at = 0;
        v.per_trade = 0;
        v.daily = 0;
        v.per_trade_wsol = 0;
        v.daily_wsol = 0;
        v.max_ops = 0;
        v.paused = false;
        v.debits = Vec::new();
        Ok(())
    }
    pub fn create_session(
        ctx: Context<OwnerAuthority>,
        session: Pubkey,
        per_trade: u64,
        daily: u64,
        per_trade_wsol: u64,
        daily_wsol: u64,
        max_ops: u16,
        expires_at: i64,
    ) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        let now = Clock::get()?.unix_timestamp;
        let limits = Limits {
            per_trade,
            daily,
            per_trade_wsol,
            daily_wsol,
            max_ops,
            expiry: expires_at,
        };
        // Valid limits and an expiry within risk::MAX_SESSION (plus the clock allowance) of now.
        require!(risk::session(&limits, now).is_ok(), VaultError::RiskLimit);
        require!(
            session != Pubkey::default() && session != v.owner && session != v.key(),
            VaultError::Authority
        );
        v.session_epoch = v.session_epoch.checked_add(1).ok_or(VaultError::Overflow)?;
        v.session = session;
        v.per_trade = per_trade;
        v.daily = daily;
        v.per_trade_wsol = per_trade_wsol;
        v.daily_wsol = daily_wsol;
        v.max_ops = max_ops;
        v.expires_at = expires_at;
        // Neither the monotonic sequence, rolling spend history nor sticky breaker resets here.
        Ok(())
    }
    pub fn revoke_all(ctx: Context<OwnerAuthority>) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        v.session_epoch = v.session_epoch.checked_add(1).ok_or(VaultError::Overflow)?;
        v.session = Pubkey::default();
        v.expires_at = 0;
        v.paused = true;
        Ok(())
    }
    pub fn set_breaker(ctx: Context<BreakerAuthority>, paused: bool) -> Result<()> {
        let v = &mut ctx.accounts.vault;
        let signer = ctx.accounts.authority.key();
        require!(
            signer == v.owner || (signer == v.session && paused),
            VaultError::Authority
        );
        v.paused = paused;
        Ok(())
    }
    /// Remaining accounts are a transfer hook's: when the mint's issuer sets a TransferHook
    /// program, Token-2022 calls it inside the transfer and it needs its program, its
    /// extra-account-metas validation account and the extra accounts that lists. They are
    /// forwarded to the transfer, so a hook can never lock custody in this immutable program.
    /// None of them may sign: the owner's signature never reaches a hook, and Token-2022
    /// passes the vault to the hook as a non-signer.
    pub fn withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, Withdraw<'info>>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, VaultError::Amount);
        require!(
            ctx.remaining_accounts.iter().all(|info| !info.is_signer),
            VaultError::Authority
        );
        let v = &ctx.accounts.vault;
        let bump = [v.bump];
        let seeds: &[&[u8]] = &[b"vault", v.owner.as_ref(), &bump];
        spl_token_2022::onchain::invoke_transfer_checked(
            ctx.accounts.token_program.key,
            ctx.accounts.vault_token.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.owner_token.to_account_info(),
            v.to_account_info(),
            ctx.remaining_accounts,
            amount,
            ctx.accounts.mint.decimals,
            &[seeds],
        )?;
        // Withdrawals remain available while expired/revoked/paused and invalidate prepared swaps.
        let seq = ctx.accounts.vault.seq;
        ctx.accounts.vault.seq = seq.checked_add(1).ok_or(VaultError::Overflow)?;
        emit!(OwnerWithdrawal {
            vault: ctx.accounts.vault.key(),
            owner: ctx.accounts.owner.key(),
            mint: ctx.accounts.mint.key(),
            amount,
            seq,
            timestamp: Clock::get()?.unix_timestamp
        });
        Ok(())
    }
    pub fn withdraw_sol(ctx: Context<OwnerNativeWithdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::Amount);
        let info = ctx.accounts.vault.to_account_info();
        let reserve = Rent::get()?.minimum_balance(info.data_len());
        let available = info
            .lamports()
            .checked_sub(reserve)
            .ok_or(VaultError::Amount)?;
        require!(amount <= available, VaultError::Amount);
        let destination = ctx.accounts.owner.to_account_info();
        let final_owner = destination
            .lamports()
            .checked_add(amount)
            .ok_or(VaultError::Overflow)?;
        **info.try_borrow_mut_lamports()? -= amount;
        **destination.try_borrow_mut_lamports()? = final_owner;
        let seq = ctx.accounts.vault.seq;
        ctx.accounts.vault.seq = seq.checked_add(1).ok_or(VaultError::Overflow)?;
        emit!(OwnerNativeWithdrawal {
            vault: ctx.accounts.vault.key(),
            owner: ctx.accounts.owner.key(),
            lamports: amount,
            seq,
            timestamp: Clock::get()?.unix_timestamp
        });
        Ok(())
    }
    pub fn execute_swap<'info>(
        mut ctx: Context<'_, '_, '_, 'info, ExecuteSwap<'info>>,
        expected_seq: u64,
        session_epoch: u64,
        amount_in: u64,
        min_out: u64,
        deadline: i64,
        slippage_bps: u16,
        route_data: Vec<u8>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &mut ctx.accounts;
        require!(
            a.vault.version == VERSION
                && a.vault.session == a.session_signer.key()
                && a.vault.session_epoch == session_epoch,
            VaultError::Authority
        );
        require!(a.vault.seq == expected_seq, VaultError::Sequence);
        require!(
            a.fee_payer.key() != a.session_signer.key()
                && a.fee_payer.key() != a.vault.owner
                && a.fee_payer.key() != a.vault.key(),
            VaultError::Authority
        );
        require!(
            amount_in > 0 && min_out > 0 && slippage_bps <= 100,
            VaultError::Amount
        );
        require!(
            now >= 0
                && now < deadline
                && deadline <= now.checked_add(30).ok_or(VaultError::Overflow)?,
            VaultError::Expired
        );
        let buy = a.input_mint.key() == USDG;
        require!(
            (buy && a.output_mint.key() == WSOL)
                || (!buy && a.input_mint.key() == WSOL && a.output_mint.key() == USDG),
            VaultError::Mint
        );
        require!(!buy || !a.vault.paused, VaultError::Paused);
        check_mint(&a.input_mint, &a.input_token_program)?;
        check_mint(&a.output_mint, &a.output_token_program)?;
        check_account(&a.vault_input)?;
        check_account(&a.vault_output)?;
        check_account(&a.temp_input)?;
        // Sells are bounded on input: the full WSOL amount made available is charged
        // against the owner's WSOL caps, so a dust quote cannot empty the position.
        // Their guaranteed cash output is preflighted here and actual output after.
        let limits = a.vault.limits();
        let (provisional, wsol) = if buy {
            (amount_in, 0)
        } else {
            (min_out, amount_in)
        };
        risk::record(&a.vault.debits, provisional, wsol, &limits, now)
            .map_err(|_| error!(VaultError::RiskLimit))?;
        check_route(&route_data, amount_in, min_out, slippage_bps)?;
        check_route_accounts(ctx.remaining_accounts, a)?;
        let vault_key = a.vault.key();
        let seq_bytes = expected_seq.to_le_bytes();
        let swap_bump = [ctx.bumps.swap_authority];
        let swap_seeds: &[&[u8]] = &[b"swap", vault_key.as_ref(), &seq_bytes, &swap_bump];
        let owner = a.vault.owner;
        let vault_bump = [a.vault.bump];
        let vault_seeds: &[&[u8]] = &[b"vault", owner.as_ref(), &vault_bump];
        // A public PDA can receive unsolicited tokens. Refund donations to the owner before funding so they
        // cannot deny service or enlarge the amount entrusted to the route. The owner's input ATA is needed
        // only then: an owner who closed it (unwrapping WSOL, reclaiming rent) must not block every swap.
        // A donation with no refund account fails closed rather than being counted as trade input.
        if a.temp_input.amount > 0 {
            let refund = a
                .owner_refund
                .as_ref()
                .ok_or(error!(VaultError::RefundAccount))?;
            transfer(
                &a.input_token_program,
                &a.temp_input,
                &a.input_mint,
                refund,
                a.swap_authority.to_account_info(),
                a.temp_input.amount,
                swap_seeds,
            )?;
            a.temp_input.reload()?;
        }
        require!(a.temp_input.amount == 0, VaultError::Amount);
        let input_before = a.vault_input.amount;
        let output_before = a.vault_output.amount;
        transfer(
            &a.input_token_program,
            &a.vault_input,
            &a.input_mint,
            &a.temp_input,
            a.vault.to_account_info(),
            amount_in,
            vault_seeds,
        )?;
        a.temp_input.reload()?;
        require!(a.temp_input.amount == amount_in, VaultError::Amount);
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|ai| AccountMeta {
                pubkey: ai.key(),
                is_signer: ai.key() == a.swap_authority.key(),
                is_writable: ai.is_writable,
            })
            .collect();
        let ix = Instruction {
            program_id: JUPITER,
            accounts: metas,
            data: route_data,
        };
        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(a.jupiter_program.to_account_info());
        invoke_signed(&ix, &infos, &[swap_seeds])?;
        a.temp_input.reload()?;
        check_account(&a.temp_input)?;
        if a.temp_input.amount > 0 {
            transfer(
                &a.input_token_program,
                &a.temp_input,
                &a.input_mint,
                &a.vault_input,
                a.swap_authority.to_account_info(),
                a.temp_input.amount,
                swap_seeds,
            )?;
        }
        token_interface::close_account(CpiContext::new_with_signer(
            a.input_token_program.to_account_info(),
            CloseAccount {
                account: a.temp_input.to_account_info(),
                destination: a.fee_payer.to_account_info(),
                authority: a.swap_authority.to_account_info(),
            },
            &[swap_seeds],
        ))?;
        a.vault_input.reload()?;
        a.vault_output.reload()?;
        let spent = input_before
            .checked_sub(a.vault_input.amount)
            .ok_or(VaultError::Amount)?;
        let received = a
            .vault_output
            .amount
            .checked_sub(output_before)
            .ok_or(VaultError::Amount)?;
        require!(
            spent > 0 && spent <= amount_in && received >= min_out,
            VaultError::Amount
        );
        // Budgets conservatively charge the full input made available, even if dust returns:
        // USDG for a buy, WSOL for a sell. A sell's cash proceeds stay charged to the USDG caps.
        let (notional, wsol) = if buy {
            (amount_in, 0)
        } else {
            (received, amount_in)
        };
        let debits = risk::record(&a.vault.debits, notional, wsol, &limits, now)
            .map_err(|_| error!(VaultError::RiskLimit))?;
        a.vault.debits = debits;
        a.vault.seq = expected_seq.checked_add(1).ok_or(VaultError::Overflow)?;
        emit!(SwapExecuted {
            vault: vault_key,
            owner,
            session: a.session_signer.key(),
            session_epoch,
            seq: expected_seq,
            input_mint: a.input_mint.key(),
            output_mint: a.output_mint.key(),
            amount_in: spent,
            amount_out: received,
            timestamp: now
        });
        Ok(())
    }
}

fn transfer<'info>(
    program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            program.to_account_info(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority,
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}
fn check_account(account: &InterfaceAccount<TokenAccount>) -> Result<()> {
    require!(
        account.delegate == COption::None
            && account.close_authority == COption::None
            && !account.is_frozen(),
        VaultError::TokenAccount
    );
    Ok(())
}
fn check_mint(mint: &InterfaceAccount<Mint>, program: &Interface<TokenInterface>) -> Result<()> {
    require!(mint.is_initialized, VaultError::Mint);
    if mint.key() == WSOL {
        require!(
            program.key() == anchor_spl::token::ID
                && mint.decimals == 9
                && mint.freeze_authority == COption::None,
            VaultError::Mint
        );
        return Ok(());
    }
    require!(
        mint.key() == USDG && program.key() == spl_token_2022::ID && mint.decimals == 6,
        VaultError::Mint
    );
    let info = mint.to_account_info();
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<RawMint>::unpack(&data)?;
    for extension in state.get_extension_types()? {
        match extension {
            ExtensionType::TransferFeeConfig => {
                let fee = state.get_extension::<TransferFeeConfig>()?;
                require!(
                    u16::from(fee.older_transfer_fee.transfer_fee_basis_points) == 0
                        && u16::from(fee.newer_transfer_fee.transfer_fee_basis_points) == 0,
                    VaultError::Mint
                );
            }
            // Swaps refuse a set hook: the route's transfers could not carry its accounts.
            // Withdrawals forward them (see withdraw), so a hook never locks custody.
            ExtensionType::TransferHook => {
                let hook = state.get_extension::<TransferHook>()?;
                require!(
                    Option::<Pubkey>::from(hook.program_id).is_none(),
                    VaultError::Mint
                );
            }
            // USDG is an issuer-controlled cash token. These known issuer/metadata extensions
            // do not debit extra tokens in an ordinary checked transfer; all others fail closed.
            ExtensionType::MintCloseAuthority
            | ExtensionType::ConfidentialTransferMint
            | ExtensionType::PermanentDelegate
            | ExtensionType::ConfidentialTransferFeeConfig
            | ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata => {}
            _ => return err!(VaultError::Mint),
        }
    }
    Ok(())
}
fn check_route(data: &[u8], amount: u64, min_out: u64, slippage: u16) -> Result<()> {
    require!(
        data.len() >= 32 && data.len() <= 2048 && data[..8] == SHARED_ROUTE,
        VaultError::Route
    );
    let n = data.len();
    let input = u64::from_le_bytes(data[n - 19..n - 11].try_into().unwrap());
    let quote = u64::from_le_bytes(data[n - 11..n - 3].try_into().unwrap());
    let bps = u16::from_le_bytes(data[n - 3..n - 1].try_into().unwrap());
    require!(
        input == amount && quote > 0 && bps == slippage && bps <= 100 && data[n - 1] == 0,
        VaultError::Route
    );
    let floor = (quote as u128) * (10000 - bps as u128) / 10000;
    require!(
        min_out as u128 >= floor && min_out <= quote,
        VaultError::Route
    );
    Ok(())
}
fn check_route_accounts(remaining: &[AccountInfo], a: &ExecuteSwap) -> Result<()> {
    require!(
        remaining.len() >= 11 && remaining.len() <= 64,
        VaultError::Route
    );
    let fixed = [
        (0, anchor_spl::token::ID),
        (2, a.swap_authority.key()),
        (3, a.temp_input.key()),
        (6, a.vault_output.key()),
        (7, a.input_mint.key()),
        (8, a.output_mint.key()),
        (9, JUPITER),
        (10, spl_token_2022::ID),
    ];
    for (index, key) in fixed {
        require_keys_eq!(remaining[index].key(), key, VaultError::Route);
    }
    for info in remaining {
        let key = info.key();
        require!(
            !info.is_signer
                && key != a.vault.key()
                && key != a.vault.owner
                && key != a.session_signer.key()
                && key != a.fee_payer.key()
                && key != a.vault_input.key()
                && a.owner_refund.as_ref().map_or(true, |r| key != r.key())
                && info.owner != &crate::ID,
            VaultError::Route
        );
        if info.owner == &anchor_spl::token::ID || info.owner == &spl_token_2022::ID {
            let data = info.try_borrow_data()?;
            // Token accounts have the same first 165 bytes in both supported programs.
            if data.len() >= 165 {
                let authority = Pubkey::new_from_array(data[32..64].try_into().unwrap());
                if authority == a.vault.key() {
                    require_keys_eq!(key, a.vault_output.key(), VaultError::Route);
                }
                // The owner's token accounts stay out of the route whether or not the
                // refund account was passed, so an omitted refund ATA is still excluded.
                require!(authority != a.vault.owner, VaultError::Route);
            }
        }
    }
    Ok(())
}

#[account]
pub struct Vault {
    pub version: u8,
    pub bump: u8,
    pub owner: Pubkey,
    pub session: Pubkey,
    pub session_epoch: u64,
    pub seq: u64,
    pub expires_at: i64,
    pub per_trade: u64,
    pub daily: u64,
    /// Lamports of WSOL one sell may put in, and over the rolling 24 hours.
    pub per_trade_wsol: u64,
    pub daily_wsol: u64,
    pub max_ops: u16,
    pub paused: bool,
    pub debits: Vec<Debit>,
}
impl Vault {
    pub const SPACE: usize = 8 + 2 + 64 + 56 + 2 + 1 + 4 + 96 * 24;
    pub fn limits(&self) -> Limits {
        Limits {
            per_trade: self.per_trade,
            daily: self.daily,
            per_trade_wsol: self.per_trade_wsol,
            daily_wsol: self.daily_wsol,
            max_ops: self.max_ops,
            expiry: self.expires_at,
        }
    }
}
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(init,payer=owner,space=Vault::SPACE,seeds=[b"vault",owner.key().as_ref()],bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct OwnerAuthority<'info> {
    #[account(mut,seeds=[b"vault",owner.key().as_ref()],bump=vault.bump,has_one=owner)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
}
#[derive(Accounts)]
pub struct OwnerNativeWithdraw<'info> {
    #[account(mut,seeds=[b"vault",owner.key().as_ref()],bump=vault.bump,has_one=owner)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub owner: Signer<'info>,
}
#[derive(Accounts)]
pub struct BreakerAuthority<'info> {
    #[account(mut,seeds=[b"vault",vault.owner.as_ref()],bump=vault.bump)]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut,seeds=[b"vault",owner.key().as_ref()],bump=vault.bump,has_one=owner)]
    pub vault: Account<'info, Vault>,
    pub owner: Signer<'info>,
    #[account(mint::token_program=token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=vault,associated_token::token_program=token_program)]
    pub vault_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=owner,associated_token::token_program=token_program)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}
#[derive(Accounts)]
#[instruction(expected_seq:u64)]
pub struct ExecuteSwap<'info> {
    #[account(mut,seeds=[b"vault",vault.owner.as_ref()],bump=vault.bump)]
    pub vault: Account<'info, Vault>,
    pub session_signer: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(mint::token_program=input_token_program)]
    pub input_mint: InterfaceAccount<'info, Mint>,
    #[account(mint::token_program=output_token_program)]
    pub output_mint: InterfaceAccount<'info, Mint>,
    #[account(mut,associated_token::mint=input_mint,associated_token::authority=vault,associated_token::token_program=input_token_program)]
    pub vault_input: InterfaceAccount<'info, TokenAccount>,
    #[account(mut,associated_token::mint=output_mint,associated_token::authority=vault,associated_token::token_program=output_token_program)]
    pub vault_output: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: An isolated PDA; only this PDA signs the Jupiter CPI.
    #[account(seeds=[b"swap",vault.key().as_ref(),&expected_seq.to_le_bytes()],bump)]
    pub swap_authority: UncheckedAccount<'info>,
    #[account(init_if_needed,payer=fee_payer,associated_token::mint=input_mint,associated_token::authority=swap_authority,associated_token::token_program=input_token_program)]
    pub temp_input: InterfaceAccount<'info, TokenAccount>,
    pub input_token_program: Interface<'info, TokenInterface>,
    pub output_token_program: Interface<'info, TokenInterface>,
    /// CHECK: Pinned Jupiter program, checked executable by Anchor.
    #[account(address=JUPITER,executable)]
    pub jupiter_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// The owner's canonical input ATA. Required only when `temp_input` already holds a
    /// donation; otherwise the client passes this program's ID to leave it out.
    #[account(mut,associated_token::mint=input_mint,associated_token::authority=vault.owner,associated_token::token_program=input_token_program)]
    pub owner_refund: Option<InterfaceAccount<'info, TokenAccount>>,
}
#[event]
pub struct SwapExecuted {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub session: Pubkey,
    pub session_epoch: u64,
    pub seq: u64,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub timestamp: i64,
}
#[event]
pub struct OwnerWithdrawal {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub seq: u64,
    pub timestamp: i64,
}
#[event]
pub struct OwnerNativeWithdrawal {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub lamports: u64,
    pub seq: u64,
    pub timestamp: i64,
}
#[error_code]
pub enum VaultError {
    #[msg("Unauthorized vault operation")]
    Authority,
    #[msg("Stale vault sequence")]
    Sequence,
    #[msg("Risk limit exceeded or expired")]
    RiskLimit,
    #[msg("Invalid swap amount")]
    Amount,
    #[msg("Swap expired")]
    Expired,
    #[msg("Unsupported or unsafe mint")]
    Mint,
    #[msg("Vault buys are paused")]
    Paused,
    #[msg("Unsafe token account")]
    TokenAccount,
    #[msg("Invalid Jupiter route")]
    Route,
    #[msg("Integer overflow")]
    Overflow,
    /// Appended so earlier codes keep their numbers: 6010.
    #[msg("A donation is waiting in the swap account and the owner's refund account is missing")]
    RefundAccount,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_layout_matches_typescript() {
        let v = Vault {
            version: VERSION,
            bump: 0,
            owner: Pubkey::default(),
            session: Pubkey::default(),
            session_epoch: 0,
            seq: 0,
            expires_at: 0,
            per_trade: 0,
            daily: 0,
            per_trade_wsol: 0,
            daily_wsol: 0,
            max_ops: 0,
            paused: false,
            debits: vec![
                Debit {
                    timestamp: 0,
                    notional: 0,
                    wsol: 0
                };
                96
            ],
        };
        let mut bytes = Vec::new();
        v.try_serialize(&mut bytes).unwrap();
        // packages/core/src/solana-live.ts SOLANA_VAULT_ACCOUNT_SIZE must match.
        assert_eq!(bytes.len(), 2441);
        assert_eq!(Vault::SPACE, 2441);
    }
    #[test]
    fn route_amounts_and_floor() {
        let mut d = vec![0u8; 32];
        d[..8].copy_from_slice(&SHARED_ROUTE);
        d[13..21].copy_from_slice(&10u64.to_le_bytes());
        d[21..29].copy_from_slice(&100u64.to_le_bytes());
        d[29..31].copy_from_slice(&100u16.to_le_bytes());
        assert!(check_route(&d, 10, 99, 100).is_ok());
        assert!(check_route(&d, 10, 98, 100).is_err());
        assert!(check_route(&d, 11, 99, 100).is_err());
        d[31] = 1;
        assert!(check_route(&d, 10, 99, 100).is_err());
    }
}
