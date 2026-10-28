//! Runtime tests use ephemeral generated keys and synthetic pools, never network wallets.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint::ProgramResult, program_option::COption, program_pack::Pack,
};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::spl_associated_token_account::get_associated_token_address_with_program_id,
    token_2022::spl_token_2022::{
        self,
        extension::{
            default_account_state::DefaultAccountState,
            interest_bearing_mint::InterestBearingConfig, metadata_pointer::MetadataPointer,
            mint_close_authority::MintCloseAuthority, non_transferable::NonTransferable,
            pausable::PausableConfig, permanent_delegate::PermanentDelegate,
            transfer_fee::TransferFeeConfig,
            transfer_hook::{TransferHook, TransferHookAccount},
            BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
        },
    },
};
use base64::Engine;
use merrymen_vault::{self as vault, Vault, JUPITER, SHARED_ROUTE, USDG, WSOL};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::program::invoke_signed;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    signature::{Keypair, Signer},
    transaction::Transaction,
};

fn mock_jupiter(_program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    assert!(a[2].is_signer);
    assert!(!a.iter().any(|x| x.owner == &vault::ID));
    let requested = u64::from_le_bytes(data[data.len() - 19..data.len() - 11].try_into().unwrap());
    let input = if data[8] == 2 {
        requested - 10
    } else {
        requested
    };
    let output = match data[8] {
        1 => 1,
        3 => 100,
        4 => 101,
        _ => 200,
    };
    let buy = *a[7].key == USDG;
    let input_program = if buy { &a[10] } else { &a[0] };
    let output_program = if buy { &a[0] } else { &a[10] };
    let ix = spl_token_2022::instruction::transfer_checked(
        input_program.key,
        a[3].key,
        a[7].key,
        a[4].key,
        a[2].key,
        &[],
        input,
        if buy { 6 } else { 9 },
    )?;
    invoke_signed(
        &ix,
        &[
            a[3].clone(),
            a[7].clone(),
            a[4].clone(),
            a[2].clone(),
            input_program.clone(),
        ],
        &[],
    )?;
    let (_, bump) = Pubkey::find_program_address(&[b"authority", &[0]], &JUPITER);
    let ix = spl_token_2022::instruction::transfer_checked(
        output_program.key,
        a[5].key,
        a[8].key,
        a[6].key,
        a[1].key,
        &[],
        output,
        if buy { 9 } else { 6 },
    )?;
    invoke_signed(
        &ix,
        &[
            a[5].clone(),
            a[8].clone(),
            a[6].clone(),
            a[1].clone(),
            output_program.clone(),
        ],
        &[&[b"authority", &[0], &[bump]]],
    )
}
/// A transfer-hook program the USDG issuer could set: interface-style, it needs its
/// extra-account-metas validation account at index 4 and the two extra accounts that
/// list names (a fixed account and a PDA of the destination), and it is never handed a signer.
const HOOK: Pubkey = Pubkey::new_from_array([0x51; 32]);
const HOOK_FIXED: Pubkey = Pubkey::new_from_array([0x53; 32]);
fn hook_validation() -> Pubkey {
    Pubkey::find_program_address(&[b"extra-account-metas", USDG.as_ref()], &HOOK).0
}
fn hook_pda(destination: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"merrymen", destination.as_ref()], &HOOK).0
}
fn mock_hook(_program: &Pubkey, a: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    use anchor_lang::solana_program::program_error::ProgramError;
    if a.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if *a[4].key != hook_validation() || *a[5].key != HOOK_FIXED || *a[6].key != hook_pda(a[2].key)
    {
        return Err(ProgramError::InvalidSeeds);
    }
    if a.iter().any(|x| x.is_signer) {
        return Err(ProgramError::IllegalOwner);
    }
    Ok(())
}
/// The hook's ExtraAccountMetaList for Execute: HOOK_FIXED, then the PDA of
/// [literal "merrymen", account key 2 (the destination)] under the hook program.
fn hook_meta_list() -> Vec<u8> {
    let mut fixed = vec![0u8];
    fixed.extend_from_slice(HOOK_FIXED.as_ref());
    fixed.extend_from_slice(&[0, 0]);
    let mut pda = vec![1u8];
    let mut config = vec![1u8, 8];
    config.extend_from_slice(b"merrymen");
    config.extend_from_slice(&[3, 2]);
    config.resize(32, 0);
    pda.extend_from_slice(&config);
    pda.extend_from_slice(&[0, 0]);
    let disc = solana_sdk::hash::hash(b"spl-transfer-hook-interface:execute");
    let mut d = disc.to_bytes()[..8].to_vec();
    d.extend_from_slice(&(4u32 + 35 * 2).to_le_bytes());
    d.extend_from_slice(&2u32.to_le_bytes());
    d.extend_from_slice(&fixed);
    d.extend_from_slice(&pda);
    d
}
fn account(owner: Pubkey, data: Vec<u8>, extra: u64) -> Account {
    Account {
        lamports: Rent::default().minimum_balance(data.len()) + extra,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}
fn mint(program: Pubkey, decimals: u8) -> Account {
    let m = spl_token_2022::state::Mint {
        mint_authority: COption::None,
        supply: 1000000,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut d = vec![0; 82];
    spl_token_2022::state::Mint::pack(m, &mut d).unwrap();
    account(program, d, 0)
}
type RawMint = spl_token_2022::state::Mint;
/// A real Token-2022 mint carrying extensions, built with the token program's own layout code.
fn extended_mint(
    decimals: u8,
    extensions: &[ExtensionType],
    configure: impl FnOnce(&mut StateWithExtensionsMut<RawMint>),
) -> Account {
    let len = ExtensionType::try_calculate_account_len::<RawMint>(extensions).unwrap();
    let mut d = vec![0; len];
    {
        let mut state = StateWithExtensionsMut::<RawMint>::unpack_uninitialized(&mut d).unwrap();
        configure(&mut state);
        state.base = RawMint {
            mint_authority: COption::None,
            supply: 1000000,
            decimals,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        state.pack_base();
        state.init_account_type().unwrap();
    }
    account(spl_token_2022::ID, d, 0)
}
fn token(program: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    let rent = Rent::default().minimum_balance(165);
    let native = mint == WSOL;
    let a = spl_token_2022::state::Account {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: spl_token_2022::state::AccountState::Initialized,
        is_native: if native {
            COption::Some(rent)
        } else {
            COption::None
        },
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut d = vec![0; 165];
    spl_token_2022::state::Account::pack(a, &mut d).unwrap();
    account(program, d, if native { amount } else { 0 })
}
fn ata(owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, program)
}
/// The custody side of a swap: whose vault and session, which mints and token programs.
#[derive(Clone, Copy)]
struct Side {
    vault: Pubkey,
    session: Pubkey,
    input_mint: Pubkey,
    input_program: Pubkey,
    output_mint: Pubkey,
    output_program: Pubkey,
}
/// Another tenant in the same cluster, with its own owner, session, vault and custody.
struct Tenant {
    owner: Keypair,
    session: Keypair,
    vault: Pubkey,
}
#[allow(clippy::too_many_arguments)]
fn create_session_ix(
    vault: Pubkey,
    owner: Pubkey,
    session: Pubkey,
    per_trade: u64,
    daily: u64,
    per_trade_wsol: u64,
    daily_wsol: u64,
    expires_at: i64,
) -> Instruction {
    Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::OwnerAuthority { vault, owner }.to_account_metas(None),
        data: vault::instruction::CreateSession {
            session,
            per_trade,
            daily,
            per_trade_wsol,
            daily_wsol,
            max_ops: 10,
            expires_at,
        }
        .data(),
    }
}
struct Fixture {
    ctx: ProgramTestContext,
    owner: Keypair,
    session: Keypair,
    vault: Pubkey,
    input: Pubkey,
    output: Pubkey,
    pool_input: Pubkey,
    pool_output: Pubkey,
    authority: Pubkey,
    last_logs: Vec<String>,
    last_fee: u64,
    /// Makes every session transaction unique, so a resent identical instruction is
    /// judged by the program rather than refused by the runtime as already processed.
    nonce: u32,
    /// The fixture's session expiry: the longest the program grants from the start
    /// clock (create_session refuses one more than 7 days ahead).
    expiry: i64,
}
impl Fixture {
    async fn new() -> Self {
        let owner = Keypair::new();
        let session = Keypair::new();
        let (vault, _) =
            Pubkey::find_program_address(&[b"vault", owner.pubkey().as_ref()], &vault::ID);
        let (authority, _) = Pubkey::find_program_address(&[b"authority", &[0]], &JUPITER);
        let input = ata(&vault, &USDG, &spl_token_2022::ID);
        let output = ata(&vault, &WSOL, &anchor_spl::token::ID);
        let pool_input = Pubkey::new_unique();
        let pool_output = Pubkey::new_unique();
        let mut pt = ProgramTest::new("merrymen_vault", vault::ID, None);
        // BPF_OUT_DIR makes this same suite exercise the compiled SBF custody program.
        pt.prefer_bpf(false); // Mock Jupiter stays native; custody and bundled token programs use SBF.
                              // Use ProgramTest’s bundled real SBF Token, Token-2022 and ATA programs.
        pt.add_program("mock_jupiter", JUPITER, processor!(mock_jupiter));
        // Runs only for a mint whose TransferHook program names it.
        pt.add_program("mock_hook", HOOK, processor!(mock_hook));
        pt.add_account(
            owner.pubkey(),
            account(anchor_lang::system_program::ID, vec![], 100_000_000),
        );
        pt.add_account(
            session.pubkey(),
            account(anchor_lang::system_program::ID, vec![], 1_000_000),
        );
        pt.add_account(USDG, mint(spl_token_2022::ID, 6));
        pt.add_account(WSOL, mint(anchor_spl::token::ID, 9));
        pt.add_account(input, token(spl_token_2022::ID, USDG, vault, 1000));
        pt.add_account(output, token(anchor_spl::token::ID, WSOL, vault, 0));
        pt.add_account(pool_input, token(spl_token_2022::ID, USDG, authority, 1000));
        pt.add_account(
            pool_output,
            token(anchor_spl::token::ID, WSOL, authority, 10000),
        );
        pt.add_account(
            authority,
            account(anchor_lang::system_program::ID, vec![], 1),
        );
        pt.add_account(
            ata(&owner.pubkey(), &USDG, &spl_token_2022::ID),
            token(spl_token_2022::ID, USDG, owner.pubkey(), 0),
        );
        pt.add_account(
            ata(&owner.pubkey(), &WSOL, &anchor_spl::token::ID),
            token(anchor_spl::token::ID, WSOL, owner.pubkey(), 0),
        );
        let ctx = pt.start_with_context().await;
        let clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
        let expiry = clock.unix_timestamp + vault::risk::MAX_SESSION;
        let mut f = Self {
            ctx,
            owner,
            session,
            vault,
            input,
            output,
            pool_input,
            pool_output,
            authority,
            last_logs: Vec::new(),
            last_fee: 0,
            nonce: 0,
            expiry,
        };
        let init = Instruction {
            program_id: vault::ID,
            accounts: vault::accounts::InitializeVault {
                vault: f.vault,
                owner: f.owner.pubkey(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: vault::instruction::InitializeVault {}.data(),
        };
        let session = f.session_ix(100, 150);
        f.owner_send(vec![init, session]).await.unwrap();
        f
    }
    fn session_ix(&self, per_trade: u64, daily: u64) -> Instruction {
        self.session_caps_ix(per_trade, daily, 100, 300)
    }
    fn session_caps_ix(
        &self,
        per_trade: u64,
        daily: u64,
        per_trade_wsol: u64,
        daily_wsol: u64,
    ) -> Instruction {
        create_session_ix(
            self.vault,
            self.owner.pubkey(),
            self.session.pubkey(),
            per_trade,
            daily,
            per_trade_wsol,
            daily_wsol,
            self.expiry,
        )
    }
    async fn owner_send(
        &mut self,
        ix: Vec<Instruction>,
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        let hash = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &ix,
            Some(&self.ctx.payer.pubkey()),
            &[&self.ctx.payer, &self.owner],
            hash,
        );
        self.ctx.banks_client.process_transaction(tx).await
    }
    async fn swap(
        &mut self,
        ix: Instruction,
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        let session = self.session.insecure_clone();
        self.signed(vec![ix], &[&session]).await
    }
    /// An owner transaction made unique like `swap`, so resending is judged by the program.
    async fn send_as(
        &mut self,
        ix: Vec<Instruction>,
        signer: &Keypair,
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        self.signed(ix, &[signer]).await
    }
    /// Signs with the cluster payer (the fee payer account) and `signers`.
    async fn signed(
        &mut self,
        mut ix: Vec<Instruction>,
        signers: &[&Keypair],
    ) -> std::result::Result<(), solana_program_test::BanksClientError> {
        let hash = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        self.nonce += 1;
        // Appended, so the instruction under test keeps index 0; the price stays zero.
        ix.push(
            solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(
                1_000_000 + self.nonce,
            ),
        );
        let mut all = vec![&self.ctx.payer];
        all.extend_from_slice(signers);
        let tx =
            Transaction::new_signed_with_payer(&ix, Some(&self.ctx.payer.pubkey()), &all, hash);
        self.last_fee = self
            .ctx
            .banks_client
            .get_fee_for_message(tx.message.clone())
            .await?
            .expect("a fresh signed message has a fee estimate");
        let result = self
            .ctx
            .banks_client
            .process_transaction_with_metadata(tx)
            .await?;
        self.last_logs = result.metadata.map(|m| m.log_messages).unwrap_or_default();
        result.result.map_err(Into::into)
    }
    fn swap_event(&self) -> vault::SwapExecuted {
        let data = self
            .last_logs
            .iter()
            .filter_map(|line| line.strip_prefix("Program data: "))
            .filter_map(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
            .find(|data| data.len() == 208 && data[..8] == [150, 166, 26, 225, 28, 89, 38, 79])
            .expect("successful swap emits its custody event");
        vault::SwapExecuted::deserialize(&mut &data[8..]).unwrap()
    }
    async fn state(&mut self) -> Vault {
        let a = self
            .ctx
            .banks_client
            .get_account(self.vault)
            .await
            .unwrap()
            .unwrap();
        Vault::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
    async fn balance(&mut self, key: Pubkey) -> u64 {
        let a = self
            .ctx
            .banks_client
            .get_account(key)
            .await
            .unwrap()
            .unwrap();
        // Accounts created by the ATA program for Token-2022 carry extensions.
        spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Account>::unpack(
            &a.data,
        )
        .unwrap()
        .base
        .amount
    }
    /// This tenant's real USDG/WSOL side of a buy or a sell.
    fn side(&self, buy: bool) -> Side {
        let usdg = (USDG, spl_token_2022::ID);
        let wsol = (WSOL, anchor_spl::token::ID);
        let ((input_mint, input_program), (output_mint, output_program)) =
            if buy { (usdg, wsol) } else { (wsol, usdg) };
        Side {
            vault: self.vault,
            session: self.session.pubkey(),
            input_mint,
            input_program,
            output_mint,
            output_program,
        }
    }
    async fn swap_ix(&mut self, seq: u64, epoch: u64, mode: u8) -> Instruction {
        let side = self.side(mode < 3);
        self.swap_ix_side(seq, epoch, mode, side).await
    }
    /// A swap on any custody side; vault, swap and temporary accounts are derived from it.
    async fn swap_ix_side(&mut self, seq: u64, epoch: u64, mode: u8, s: Side) -> Instruction {
        let clock: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        let (swap, _) = Pubkey::find_program_address(
            &[b"swap", s.vault.as_ref(), &seq.to_le_bytes()],
            &vault::ID,
        );
        let buy = mode < 3;
        let (input_mint, output_mint) = (s.input_mint, s.output_mint);
        let (input_program, output_program) = (s.input_program, s.output_program);
        let vault_input = ata(&s.vault, &input_mint, &input_program);
        let vault_output = ata(&s.vault, &output_mint, &output_program);
        let (pool_input, pool_output, quote) = if buy {
            (self.pool_input, self.pool_output, 200u64)
        } else {
            (self.pool_output, self.pool_input, 100u64)
        };
        let temp = ata(&swap, &input_mint, &input_program);
        let mut accounts = vault::accounts::ExecuteSwap {
            vault: s.vault,
            session_signer: s.session,
            fee_payer: self.ctx.payer.pubkey(),
            input_mint,
            output_mint,
            vault_input,
            vault_output,
            swap_authority: swap,
            temp_input: temp,
            input_token_program: input_program,
            output_token_program: output_program,
            jupiter_program: JUPITER,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
            // Like the executor, pass the owner's refund ATA only for a waiting donation.
            owner_refund: None,
        }
        .to_account_metas(None);
        accounts.extend([
            AccountMeta::new_readonly(anchor_spl::token::ID, false),
            AccountMeta::new_readonly(self.authority, false),
            AccountMeta::new_readonly(swap, false),
            AccountMeta::new(temp, false),
            AccountMeta::new(pool_input, false),
            AccountMeta::new(pool_output, false),
            AccountMeta::new(vault_output, false),
            AccountMeta::new_readonly(input_mint, false),
            AccountMeta::new_readonly(output_mint, false),
            AccountMeta::new_readonly(JUPITER, false),
            AccountMeta::new_readonly(spl_token_2022::ID, false),
        ]);
        let mut route_data = vec![0; 32];
        route_data[..8].copy_from_slice(&SHARED_ROUTE);
        route_data[8] = mode;
        route_data[13..21].copy_from_slice(&100u64.to_le_bytes());
        route_data[21..29].copy_from_slice(&quote.to_le_bytes());
        route_data[29..31].copy_from_slice(&100u16.to_le_bytes());
        Instruction {
            program_id: vault::ID,
            accounts,
            data: vault::instruction::ExecuteSwap {
                expected_seq: seq,
                session_epoch: epoch,
                amount_in: 100,
                min_out: quote * 99 / 100,
                deadline: clock.unix_timestamp + 29,
                slippage_bps: 100,
                route_data,
            }
            .data(),
        }
    }
    /// Any swap shape: session-chosen amount, quote, minimum and slippage.
    #[allow(clippy::too_many_arguments)]
    async fn custom_ix(
        &mut self,
        seq: u64,
        epoch: u64,
        buy: bool,
        amount_in: u64,
        quote: u64,
        min_out: u64,
        bps: u16,
        mode: u8,
    ) -> Instruction {
        let mut ix = self.swap_ix(seq, epoch, if buy { 0 } else { 3 }).await;
        let n = ix.data.len();
        // ExecuteSwap data: disc, expected_seq, session_epoch, amount_in, min_out, deadline,
        // slippage_bps, then the route bytes (u32 length + 32 bytes) at the end.
        ix.data[24..32].copy_from_slice(&amount_in.to_le_bytes());
        ix.data[32..40].copy_from_slice(&min_out.to_le_bytes());
        ix.data[48..50].copy_from_slice(&bps.to_le_bytes());
        let route = n - 32;
        ix.data[route + 8] = mode;
        ix.data[route + 13..route + 21].copy_from_slice(&amount_in.to_le_bytes());
        ix.data[route + 21..route + 29].copy_from_slice(&quote.to_le_bytes());
        ix.data[route + 29..route + 31].copy_from_slice(&bps.to_le_bytes());
        ix
    }
    /// Passes the owner's canonical input ATA in the optional refund slot.
    fn with_refund(&self, mut ix: Instruction) -> Instruction {
        let refund = ata(
            &self.owner.pubkey(),
            &ix.accounts[3].pubkey,
            &ix.accounts[9].pubkey,
        );
        ix.accounts[14] = AccountMeta::new(refund, false);
        ix
    }
    /// Unsolicited tokens already in a swap's temporary input ATA.
    fn donate(&mut self, ix: &Instruction, amount: u64) {
        let (temp, authority) = (ix.accounts[8].pubkey, ix.accounts[7].pubkey);
        let (mint, program) = (ix.accounts[3].pubkey, ix.accounts[9].pubkey);
        self.ctx
            .set_account(&temp, &token(program, mint, authority, amount).into());
    }
    /// The owner closes an empty token account of theirs, as a wallet unwrap or rent reclaim does.
    async fn owner_closes(&mut self, mint: Pubkey, program: Pubkey) {
        let account = ata(&self.owner.pubkey(), &mint, &program);
        let close = spl_token_2022::instruction::close_account(
            &program,
            &account,
            &self.owner.pubkey(),
            &self.owner.pubkey(),
            &[],
        )
        .unwrap();
        self.owner_send(vec![close]).await.unwrap();
        assert!(self
            .ctx
            .banks_client
            .get_account(account)
            .await
            .unwrap()
            .is_none());
    }
    async fn exists(&mut self, key: Pubkey) -> bool {
        self.ctx
            .banks_client
            .get_account(key)
            .await
            .unwrap()
            .is_some()
    }
    /// Custody (or anyone's) token account at its canonical ATA, with `amount` in it.
    fn put_token(&mut self, holder: Pubkey, mint: Pubkey, program: Pubkey, amount: u64) -> Pubkey {
        let key = ata(&holder, &mint, &program);
        self.ctx
            .set_account(&key, &token(program, mint, holder, amount).into());
        key
    }
    async fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        clock.unix_timestamp = unix_timestamp;
        self.ctx.set_sysvar(&clock);
    }
    async fn now(&mut self) -> i64 {
        let clock: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        clock.unix_timestamp
    }
    /// Nothing moved: custody balances, sequence and spend history are as the fixture left them.
    async fn untouched(&mut self) {
        assert_eq!(
            (
                self.balance(self.input).await,
                self.balance(self.output).await
            ),
            (1000, 0)
        );
        let state = self.state().await;
        assert_eq!(state.seq, 0);
        assert!(state.debits.is_empty());
    }
    /// A second tenant with its own owner, session, vault and 1000 USDG of custody.
    async fn add_tenant(&mut self) -> Tenant {
        let owner = Keypair::new();
        let session = Keypair::new();
        let (vault, _) =
            Pubkey::find_program_address(&[b"vault", owner.pubkey().as_ref()], &vault::ID);
        let system = anchor_lang::system_program::ID;
        self.ctx.set_account(
            &owner.pubkey(),
            &account(system, vec![], 100_000_000).into(),
        );
        self.ctx.set_account(
            &session.pubkey(),
            &account(system, vec![], 1_000_000).into(),
        );
        self.put_token(vault, USDG, spl_token_2022::ID, 1000);
        self.put_token(vault, WSOL, anchor_spl::token::ID, 0);
        self.put_token(owner.pubkey(), USDG, spl_token_2022::ID, 0);
        let init = Instruction {
            program_id: vault::ID,
            accounts: vault::accounts::InitializeVault {
                vault,
                owner: owner.pubkey(),
                system_program: system,
            }
            .to_account_metas(None),
            data: vault::instruction::InitializeVault {}.data(),
        };
        let create = create_session_ix(
            vault,
            owner.pubkey(),
            session.pubkey(),
            100,
            150,
            100,
            300,
            self.expiry,
        );
        self.send_as(vec![init, create], &owner).await.unwrap();
        Tenant {
            owner,
            session,
            vault,
        }
    }
    async fn hold_wsol(&mut self, amount: u64) {
        self.ctx.set_account(
            &self.output,
            &token(anchor_spl::token::ID, WSOL, self.vault, amount).into(),
        );
        assert_eq!(self.balance(self.output).await, amount);
    }
}
/// The custody program's own error, not a token or runtime failure.
fn vault_error(
    result: std::result::Result<(), solana_program_test::BanksClientError>,
    expected: vault::VaultError,
) -> bool {
    custom_error(result, 6000 + expected as u32)
}
/// A specific custom error code, such as an Anchor account constraint (2000-3999).
fn custom_error(
    result: std::result::Result<(), solana_program_test::BanksClientError>,
    expected: u32,
) -> bool {
    use solana_sdk::{instruction::InstructionError, transaction::TransactionError};
    // Covers both a processed failure and a preflight simulation failure.
    match result {
        Ok(()) => false,
        Err(e) => {
            let e = e.unwrap();
            let matched = matches!(
                e,
                TransactionError::InstructionError(0, InstructionError::Custom(code))
                    if code == expected
            );
            if !matched {
                eprintln!("expected custom error {expected}, got {e:?}");
            }
            matched
        }
    }
}
/// Anchor 0.32 account-constraint codes used below.
const ANCHOR_SEEDS: u32 = 2006;
const ANCHOR_ASSOCIATED: u32 = 2009;
const ANCHOR_TOKEN_OWNER: u32 = 2015;
const ANCHOR_NOT_INITIALIZED: u32 = 3012;
#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn successful_cpi_is_bounded_replay_safe_and_budget_survives_session_replacement() {
    let mut f = Fixture::new().await;
    let ix = f.swap_ix(0, 1, 0).await;
    let temp = ix.accounts[8].pubkey;
    f.swap(ix).await.unwrap();
    assert_eq!(f.balance(f.input).await, 900);
    assert_eq!(f.balance(f.output).await, 200);
    assert!(f
        .ctx
        .banks_client
        .get_account(temp)
        .await
        .unwrap()
        .is_none());
    assert_eq!(f.state().await.seq, 1);
    let stale = f.swap_ix(0, 1, 0).await;
    assert!(f.swap(stale).await.is_err());
    let session = f.session_ix(100, 150);
    f.owner_send(vec![session]).await.unwrap();
    let state = f.state().await;
    assert_eq!(state.seq, 1);
    assert_eq!(state.session_epoch, 2);
    assert_eq!(state.debits.len(), 1);
    let too_much = f.swap_ix(1, 2, 0).await;
    assert!(f.swap(too_much).await.is_err());
    assert_eq!(f.balance(f.input).await, 900);
}
#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn failed_output_and_authority_smuggling_roll_back_every_balance_and_sequence() {
    let mut f = Fixture::new().await;
    let bad = f.swap_ix(0, 1, 1).await;
    assert!(f.swap(bad).await.is_err());
    assert_eq!(f.balance(f.input).await, 1000);
    assert_eq!(f.balance(f.output).await, 0);
    assert_eq!(f.state().await.seq, 0);
    let mut bad = f.swap_ix(0, 1, 0).await;
    bad.accounts.push(AccountMeta::new(f.input, false));
    assert!(f.swap(bad).await.is_err());
    let mut bad = f.swap_ix(0, 1, 0).await;
    bad.accounts
        .push(AccountMeta::new_readonly(f.session.pubkey(), true));
    assert!(f.swap(bad).await.is_err());
    assert_eq!(f.balance(f.input).await, 1000);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn donations_and_route_dust_return_to_custody_without_resetting_budget() {
    let mut f = Fixture::new().await;
    let ix = f.swap_ix(0, 1, 2).await;
    let ix = f.with_refund(ix);
    f.donate(&ix, 7);
    f.swap(ix).await.unwrap();
    assert_eq!(f.balance(f.input).await, 910);
    let event = f
        .last_logs
        .iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
        .find(|data| data.len() == 208 && data[..8] == [150, 166, 26, 225, 28, 89, 38, 79])
        .unwrap();
    let amount_in = u64::from_le_bytes(event[184..192].try_into().unwrap());
    assert_eq!(amount_in, 1000 - f.balance(f.input).await);
    assert_eq!(amount_in, 90);

    assert_eq!(
        f.balance(ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID))
            .await,
        7
    );
    assert_eq!(f.balance(f.output).await, 200);
    assert_eq!(f.state().await.debits[0].notional, 100);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn system_prefunding_is_initialized_and_only_preexisting_lamports_offset_the_fee() {
    // Cover a top-up below token rent and excess funding above token rent.
    // Both deposits are ordinary owner-signed system transfers, not injected token state.
    for prefunding in [900_000, Rent::default().minimum_balance(165) + 1234] {
        let mut f = Fixture::new().await;
        let ix = f.swap_ix(0, 1, 0).await;
        let temp = ix.accounts[8].pubkey;
        f.owner_send(vec![solana_sdk::system_instruction::transfer(
            &f.owner.pubkey(),
            &temp,
            prefunding,
        )])
        .await
        .unwrap();
        let before = f.ctx.banks_client.get_account(temp).await.unwrap().unwrap();
        assert_eq!(before.owner, anchor_lang::system_program::ID);
        assert!(before.data.is_empty());
        assert_eq!(before.lamports, prefunding);
        let payer_before = f
            .ctx
            .banks_client
            .get_balance(f.ctx.payer.pubkey())
            .await
            .unwrap();
        // System-owned lamports are not a token donation, so no refund account is passed.
        assert_eq!(ix.accounts[14].pubkey, vault::ID);
        let owner_refund = ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID);
        let owner_lamports = f.ctx.banks_client.get_balance(owner_refund).await.unwrap();

        f.swap(ix).await.unwrap();

        assert!(f
            .ctx
            .banks_client
            .get_account(temp)
            .await
            .unwrap()
            .is_none());
        let payer_after = f
            .ctx
            .banks_client
            .get_balance(f.ctx.payer.pubkey())
            .await
            .unwrap();
        assert_eq!(payer_after, payer_before - f.last_fee + prefunding);
        assert_eq!(f.balance(owner_refund).await, 0);
        assert_eq!(
            f.ctx.banks_client.get_balance(owner_refund).await.unwrap(),
            owner_lamports
        );
        assert_eq!(f.balance(f.input).await, 900);
        assert_eq!(f.balance(f.output).await, 200);
        let event = f.swap_event();
        assert_eq!(event.input_mint, USDG);
        assert_eq!(event.amount_in, 1000 - f.balance(f.input).await);
        assert_eq!(event.amount_out, f.balance(f.output).await);
        assert_eq!(f.state().await.seq, 1);
    }
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn wsol_donation_moves_native_backing_to_owner_and_only_remaining_lamports_refund_payer() {
    let mut f = Fixture::new().await;
    let buy = f.swap_ix(0, 1, 0).await;
    f.swap(buy).await.unwrap();
    let session = f.session_ix(100, 500);
    f.owner_send(vec![session]).await.unwrap();
    let sell = f.swap_ix(1, 2, 3).await;
    let sell = f.with_refund(sell);
    let temp = sell.accounts[8].pubkey;
    let swap = sell.accounts[7].pubkey;
    let refund = sell.accounts[14].pubkey;
    let donated_tokens = 7;
    let unsynced_lamports = 13;
    f.owner_send(vec![
        anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &f.owner.pubkey(), &swap, &WSOL, &anchor_spl::token::ID,
        ),
        solana_sdk::system_instruction::transfer(&f.owner.pubkey(), &temp, donated_tokens),
        spl_token_2022::instruction::sync_native(&anchor_spl::token::ID, &temp).unwrap(),
        // An unsynced native transfer changes lamports, not the stored token amount.
        solana_sdk::system_instruction::transfer(&f.owner.pubkey(), &temp, unsynced_lamports),
    ]).await.unwrap();
    let before = f.ctx.banks_client.get_account(temp).await.unwrap().unwrap();
    let tokens = spl_token_2022::state::Account::unpack(&before.data).unwrap();
    assert_eq!(before.owner, anchor_spl::token::ID);
    assert_eq!(tokens.owner, swap);
    assert_eq!(tokens.mint, WSOL);
    assert_eq!(tokens.amount, donated_tokens);
    let reserve = match tokens.is_native {
        COption::Some(reserve) => reserve,
        _ => panic!("WSOL requires its native reserve"),
    };
    assert_eq!(
        before.lamports,
        reserve + donated_tokens + unsynced_lamports
    );
    let payer_before = f
        .ctx
        .banks_client
        .get_balance(f.ctx.payer.pubkey())
        .await
        .unwrap();
    let refund_before = f.ctx.banks_client.get_balance(refund).await.unwrap();
    let vault_input_before = f.ctx.banks_client.get_balance(f.output).await.unwrap();

    f.swap(sell).await.unwrap();

    assert!(f
        .ctx
        .banks_client
        .get_account(temp)
        .await
        .unwrap()
        .is_none());
    assert_eq!(f.balance(refund).await, donated_tokens);
    assert_eq!(
        f.ctx.banks_client.get_balance(refund).await.unwrap(),
        refund_before + donated_tokens
    );
    let payer_after = f
        .ctx
        .banks_client
        .get_balance(f.ctx.payer.pubkey())
        .await
        .unwrap();
    // This is exactly the settlement verifier's pre-lamports minus pre-token rule.
    assert_eq!(
        payer_after,
        payer_before - f.last_fee + before.lamports - tokens.amount
    );
    assert_eq!(
        f.ctx.banks_client.get_balance(f.output).await.unwrap(),
        vault_input_before - 100
    );
    assert_eq!(f.balance(f.output).await, 100);
    assert_eq!(f.balance(f.input).await, 1000);
    let event = f.swap_event();
    assert_eq!(event.input_mint, WSOL);
    assert_eq!(event.amount_in, 200 - f.balance(f.output).await);
    assert_eq!(event.amount_out, f.balance(f.input).await - 900);
    assert_eq!(f.state().await.seq, 2);
    assert_eq!(f.state().await.debits[1].notional, 100);
}
#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn lamports_prefunding_a_sells_wsol_temp_become_a_donation_refunded_to_the_owner() {
    // Anyone can send lamports to a future sell's temporary WSOL address while it is still
    // System-owned. init_if_needed opens the native account over them, and InitializeAccount3
    // makes everything above the rent reserve its token amount: a donation like any other.
    let mut f = Fixture::new().await;
    let buy = f.swap_ix(0, 1, 0).await;
    f.swap(buy).await.unwrap();
    let session = f.session_ix(100, 500);
    f.owner_send(vec![session]).await.unwrap();
    let reserve = Rent::default().minimum_balance(165);
    let donated = 1234;
    let sell = f.swap_ix(1, 2, 3).await;
    let temp = sell.accounts[8].pubkey;
    f.owner_send(vec![solana_sdk::system_instruction::transfer(
        &f.owner.pubkey(),
        &temp,
        reserve + donated,
    )])
    .await
    .unwrap();
    let before = f.ctx.banks_client.get_account(temp).await.unwrap().unwrap();
    assert_eq!(before.owner, anchor_lang::system_program::ID);
    assert!(before.data.is_empty());
    // Without the owner's refund account (what an executor that saw only lamports would
    // pass) the sell fails closed, and nothing moves.
    assert_eq!(sell.accounts[14].pubkey, vault::ID);
    assert!(vault_error(
        f.swap(sell.clone()).await,
        vault::VaultError::RefundAccount
    ));
    assert_eq!(f.balance(f.output).await, 200);
    assert_eq!(f.state().await.seq, 1);
    // With it the sell lands: the donation reaches the owner's WSOL account, and the fee
    // payer gets back only the reserve when the temporary account closes.
    let sell = f.with_refund(sell);
    let refund = sell.accounts[14].pubkey;
    let refund_before = f.ctx.banks_client.get_balance(refund).await.unwrap();
    let payer_before = f
        .ctx
        .banks_client
        .get_balance(f.ctx.payer.pubkey())
        .await
        .unwrap();
    f.swap(sell).await.unwrap();
    assert!(!f.exists(temp).await);
    assert_eq!(f.balance(refund).await, donated);
    assert_eq!(
        f.ctx.banks_client.get_balance(refund).await.unwrap(),
        refund_before + donated
    );
    let payer_after = f
        .ctx
        .banks_client
        .get_balance(f.ctx.payer.pubkey())
        .await
        .unwrap();
    // worker/src/solana-settlement.ts books exactly this: the reserve, not the pre-balance.
    assert_eq!(payer_after, payer_before - f.last_fee + reserve);
    assert_eq!(f.balance(f.output).await, 100);
    assert_eq!(f.balance(f.input).await, 1000);
    assert_eq!(f.state().await.seq, 2);
}
#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn sell_checks_actual_cash_proceeds_and_breaker_only_owner_can_reset() {
    let mut f = Fixture::new().await;
    let buy = f.swap_ix(0, 1, 0).await;
    f.swap(buy).await.unwrap();
    let new_session = f.session_ix(100, 500);
    f.owner_send(vec![new_session]).await.unwrap();
    let breaker = |authority, paused| Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::BreakerAuthority {
            vault: f.vault,
            authority,
        }
        .to_account_metas(None),
        data: vault::instruction::SetBreaker { paused }.data(),
    };
    let pause = breaker(f.session.pubkey(), true);
    let unpause = breaker(f.session.pubkey(), false);
    f.swap(pause).await.unwrap();
    assert!(f.swap(unpause).await.is_err());
    let bad_buy = f.swap_ix(1, 2, 0).await;
    assert!(f.swap(bad_buy).await.is_err());
    let excessive = f.swap_ix(1, 2, 4).await;
    assert!(f.swap(excessive).await.is_err());
    assert_eq!(f.balance(f.input).await, 900);
    assert_eq!(f.balance(f.output).await, 200);
    let sell = f.swap_ix(1, 2, 3).await;
    f.swap(sell).await.unwrap();
    assert_eq!(f.balance(f.input).await, 1000);
    assert_eq!(f.balance(f.output).await, 100);
    assert_eq!(f.state().await.seq, 2);
}
#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn owner_recovery_works_after_revoke_and_cannot_redirect_to_other_owner() {
    let mut f = Fixture::new().await;
    let revoke = Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::OwnerAuthority {
            vault: f.vault,
            owner: f.owner.pubkey(),
        }
        .to_account_metas(None),
        data: vault::instruction::RevokeAll {}.data(),
    };
    f.owner_send(vec![revoke]).await.unwrap();
    let bad = f.swap_ix(0, 1, 0).await;
    assert!(f.swap(bad).await.is_err());
    let destination = ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID);
    f.ctx.set_account(
        &destination,
        &token(spl_token_2022::ID, USDG, f.owner.pubkey(), 0).into(),
    );
    let mut withdraw = Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::Withdraw {
            vault: f.vault,
            owner: f.owner.pubkey(),
            mint: USDG,
            vault_token: f.input,
            owner_token: destination,
            token_program: spl_token_2022::ID,
        }
        .to_account_metas(None),
        data: vault::instruction::Withdraw { amount: 1000 }.data(),
    };
    let good = withdraw.clone();
    withdraw.accounts[4].pubkey = f.pool_input;
    assert!(f.owner_send(vec![withdraw]).await.is_err());
    f.owner_send(vec![good]).await.unwrap();
    assert_eq!(f.balance(f.input).await, 0);
    assert_eq!(f.balance(destination).await, 1000);
    assert_eq!(f.state().await.seq, 1);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn native_recovery_preserves_rent_and_requires_owner() {
    let mut f = Fixture::new().await;
    let reserve = f.ctx.banks_client.get_balance(f.vault).await.unwrap();
    let deposit = solana_sdk::system_instruction::transfer(&f.owner.pubkey(), &f.vault, 100);
    f.owner_send(vec![deposit]).await.unwrap();
    let withdraw = |owner, amount| Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::OwnerNativeWithdraw {
            vault: f.vault,
            owner,
        }
        .to_account_metas(None),
        data: vault::instruction::WithdrawSol { amount }.data(),
    };
    let bad = withdraw(f.session.pubkey(), 100);
    let excessive = withdraw(f.owner.pubkey(), 101);
    let good = withdraw(f.owner.pubkey(), 100);
    assert!(f.swap(bad).await.is_err());
    assert!(f.owner_send(vec![excessive]).await.is_err());
    f.owner_send(vec![good]).await.unwrap();
    assert_eq!(
        f.ctx.banks_client.get_balance(f.vault).await.unwrap(),
        reserve
    );
    assert_eq!(f.state().await.seq, 1);
}

#[test]
#[ignore = "run with complete custody verification suite"]
fn jupiter_discriminator_matches_official_anchor_method() {
    assert_eq!(
        SHARED_ROUTE,
        solana_sdk::hash::hash(b"global:shared_accounts_route").to_bytes()[..8]
    );
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn dust_priced_full_exit_is_refused_by_the_wsol_input_cap() {
    // Audit VAULT-1: 5000 raw WSOL, a session-chosen quote of 1 and min_out of 1 used to
    // empty custody for 1 micro-USDG, charged 1 against per_trade=100/daily=150.
    let mut f = Fixture::new().await;
    f.hold_wsol(5_000).await;
    let dust = f.custom_ix(0, 1, false, 5_000, 1, 1, 0, 1).await;
    assert!(vault_error(
        f.swap(dust).await,
        vault::VaultError::RiskLimit
    ));
    // The fair-priced full exit is refused as before (and now on input too).
    let fair = f.custom_ix(0, 1, false, 5_000, 200, 198, 100, 0).await;
    assert!(vault_error(
        f.swap(fair).await,
        vault::VaultError::RiskLimit
    ));
    // Just over the per-trade WSOL cap of 100 is refused even at a dust price.
    let over = f.custom_ix(0, 1, false, 101, 1, 1, 0, 1).await;
    assert!(vault_error(
        f.swap(over).await,
        vault::VaultError::RiskLimit
    ));
    assert_eq!(f.balance(f.output).await, 5_000);
    assert_eq!(f.balance(f.input).await, 1_000);
    let state = f.state().await;
    assert_eq!(state.seq, 0);
    assert!(state.debits.is_empty());
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn a_session_paused_breaker_does_not_reopen_the_dust_exit() {
    // Sells stay available while buys are paused, so the input cap must hold there too.
    let mut f = Fixture::new().await;
    f.hold_wsol(5_000).await;
    let pause = Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::BreakerAuthority {
            vault: f.vault,
            authority: f.session.pubkey(),
        }
        .to_account_metas(None),
        data: vault::instruction::SetBreaker { paused: true }.data(),
    };
    f.swap(pause).await.unwrap();
    assert!(f.state().await.paused);
    let dust = f.custom_ix(0, 1, false, 5_000, 1, 1, 0, 1).await;
    assert!(vault_error(
        f.swap(dust).await,
        vault::VaultError::RiskLimit
    ));
    assert_eq!(f.balance(f.output).await, 5_000);
    // An exit within the cap still works while paused.
    let exit = f.custom_ix(0, 1, false, 100, 1, 1, 0, 1).await;
    f.swap(exit).await.unwrap();
    assert_eq!(f.balance(f.output).await, 4_900);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn sells_record_their_input_and_the_rolling_wsol_budget_survives_replacement() {
    let mut f = Fixture::new().await;
    f.hold_wsol(5_000).await;
    // Generous cash caps so only the WSOL caps can refuse: 100 per sell, 250 a day.
    let caps = f.session_caps_ix(1_000, 10_000, 100, 250);
    f.owner_send(vec![caps]).await.unwrap();
    let first = f.custom_ix(0, 2, false, 100, 1, 1, 0, 1).await;
    f.swap(first).await.unwrap();
    let state = f.state().await;
    assert_eq!(state.debits.len(), 1);
    assert_eq!(state.debits[0].wsol, 100);
    assert_eq!(state.debits[0].notional, 1);
    let second = f.custom_ix(1, 2, false, 100, 1, 1, 0, 1).await;
    f.swap(second).await.unwrap();
    let third = f.custom_ix(2, 2, false, 100, 1, 1, 0, 1).await;
    assert!(vault_error(
        f.swap(third).await,
        vault::VaultError::RiskLimit
    ));
    let rest = f.custom_ix(2, 2, false, 50, 1, 1, 0, 1).await;
    f.swap(rest).await.unwrap();
    assert_eq!(f.balance(f.output).await, 4_750);
    // A replacement session never resets the rolling WSOL history.
    let replacement = f.session_caps_ix(1_000, 10_000, 100, 250);
    f.owner_send(vec![replacement]).await.unwrap();
    let after = f.custom_ix(3, 3, false, 1, 1, 1, 0, 1).await;
    assert!(vault_error(
        f.swap(after).await,
        vault::VaultError::RiskLimit
    ));
    let state = f.state().await;
    assert_eq!(state.seq, 3);
    assert_eq!(state.debits.iter().map(|d| d.wsol).sum::<u64>(), 250);
    // Buys charge cash only.
    let buy = f.swap_ix(3, 3, 0).await;
    f.swap(buy).await.unwrap();
    assert_eq!(f.state().await.debits.last().unwrap().wsol, 0);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn a_session_without_a_wsol_input_bound_cannot_be_created() {
    let mut f = Fixture::new().await;
    for (per_trade_wsol, daily_wsol) in [(0, 0), (0, 100), (200, 100)] {
        let bad = f.session_caps_ix(100, 150, per_trade_wsol, daily_wsol);
        let hash = f.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &[bad],
            Some(&f.ctx.payer.pubkey()),
            &[&f.ctx.payer, &f.owner],
            hash,
        );
        assert!(vault_error(
            f.ctx.banks_client.process_transaction(tx).await,
            vault::VaultError::RiskLimit
        ));
    }
    let state = f.state().await;
    assert_eq!(state.session_epoch, 1);
    assert_eq!((state.per_trade_wsol, state.daily_wsol), (100, 300));
    assert_eq!(state.version, vault::VERSION);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn an_owner_who_closed_their_token_accounts_can_still_buy_and_exit() {
    // Audit VAULT-2: unwrapping WSOL in a wallet closes the owner's WSOL ATA. That used to
    // fail every later sell, including stop-loss exits, with AccountNotInitialized.
    let mut f = Fixture::new().await;
    f.owner_closes(USDG, spl_token_2022::ID).await;
    f.owner_closes(WSOL, anchor_spl::token::ID).await;
    let buy = f.swap_ix(0, 1, 0).await;
    assert_eq!(
        buy.accounts[14],
        AccountMeta::new_readonly(vault::ID, false)
    );
    f.swap(buy).await.unwrap();
    assert_eq!(
        (f.balance(f.input).await, f.balance(f.output).await),
        (900, 200)
    );
    let caps = f.session_ix(100, 500);
    f.owner_send(vec![caps]).await.unwrap();
    let sell = f.swap_ix(1, 2, 3).await;
    f.swap(sell).await.unwrap();
    assert_eq!(
        (f.balance(f.input).await, f.balance(f.output).await),
        (1000, 100)
    );
    let event = f.swap_event();
    assert_eq!(
        (event.input_mint, event.amount_in, event.amount_out),
        (WSOL, 100, 100)
    );
    assert_eq!(f.state().await.seq, 2);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn a_donation_without_the_owners_refund_account_fails_closed_and_is_never_traded() {
    let mut f = Fixture::new().await;
    let refund = ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID);
    let ix = f.swap_ix(0, 1, 0).await;
    let temp = ix.accounts[8].pubkey;
    f.donate(&ix, 7);
    // Left out: the program refuses rather than counting the donation as trade input.
    assert!(vault_error(
        f.swap(ix.clone()).await,
        vault::VaultError::RefundAccount
    ));
    // The owner's account closed: it cannot be passed either, and nobody else's may stand in.
    f.owner_closes(USDG, spl_token_2022::ID).await;
    let closed = f.with_refund(ix.clone());
    assert!(custom_error(f.swap(closed).await, ANCHOR_NOT_INITIALIZED));
    assert!(vault_error(
        f.swap(ix.clone()).await,
        vault::VaultError::RefundAccount
    ));
    let stranger = Pubkey::new_unique();
    let stranger_ata = ata(&stranger, &USDG, &spl_token_2022::ID);
    f.ctx.set_account(
        &stranger_ata,
        &token(spl_token_2022::ID, USDG, stranger, 0).into(),
    );
    let mut foreign = ix.clone();
    foreign.accounts[14] = AccountMeta::new(stranger_ata, false);
    assert!(custom_error(f.swap(foreign).await, ANCHOR_TOKEN_OWNER));
    // An owner-held token account that is not the canonical ATA is refused too.
    let side = Pubkey::new_unique();
    f.ctx.set_account(
        &side,
        &token(spl_token_2022::ID, USDG, f.owner.pubkey(), 0).into(),
    );
    let mut noncanonical = ix.clone();
    noncanonical.accounts[14] = AccountMeta::new(side, false);
    assert!(custom_error(f.swap(noncanonical).await, ANCHOR_ASSOCIATED));
    assert_eq!(f.balance(temp).await, 7);
    assert_eq!(f.balance(f.input).await, 1000);
    let state = f.state().await;
    assert_eq!(state.seq, 0);
    assert!(state.debits.is_empty());
    // Reopening the account lets the same sequence run; the donation goes to the owner
    // and the receipt counts only custody's own input.
    f.owner_send(vec![
        anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &f.owner.pubkey(), &f.owner.pubkey(), &USDG, &spl_token_2022::ID,
        ),
    ])
    .await
    .unwrap();
    let reopened = f.with_refund(ix);
    f.swap(reopened).await.unwrap();
    assert_eq!(f.balance(refund).await, 7);
    assert_eq!(f.balance(f.input).await, 900);
    assert!(!f.exists(temp).await);
    let event = f.swap_event();
    assert_eq!((event.amount_in, event.amount_out), (100, 200));
    assert_eq!(f.state().await.debits[0].notional, 100);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn the_route_never_reaches_the_owners_token_accounts_whether_or_not_refund_is_passed() {
    let mut f = Fixture::new().await;
    let owner_usdg = ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID);
    let owner_wsol = ata(&f.owner.pubkey(), &WSOL, &anchor_spl::token::ID);
    for refund in [false, true] {
        for target in [owner_usdg, owner_wsol] {
            let mut ix = f.swap_ix(0, 1, 0).await;
            if refund {
                ix = f.with_refund(ix);
            }
            ix.accounts.push(AccountMeta::new(target, false));
            assert!(vault_error(f.swap(ix).await, vault::VaultError::Route));
        }
    }
    assert_eq!(f.balance(f.input).await, 1000);
    assert_eq!(f.state().await.seq, 0);
}

/// A USDG token account as the ATA program creates it for a mint carrying TransferHook.
fn hooked_token(owner: Pubkey, amount: u64) -> Account {
    type RawAccount = spl_token_2022::state::Account;
    let len =
        ExtensionType::try_calculate_account_len::<RawAccount>(&[ExtensionType::TransferHookAccount])
            .unwrap();
    let mut d = vec![0; len];
    {
        let mut s = StateWithExtensionsMut::<RawAccount>::unpack_uninitialized(&mut d).unwrap();
        s.init_extension::<TransferHookAccount>(true).unwrap();
        s.base = RawAccount {
            mint: USDG,
            owner,
            amount,
            delegate: COption::None,
            state: spl_token_2022::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        s.pack_base();
        s.init_account_type().unwrap();
    }
    account(spl_token_2022::ID, d, 0)
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn a_usdg_transfer_hook_never_locks_owner_withdrawals_and_never_gets_a_signer() {
    let mut f = Fixture::new().await;
    // The issuer sets a hook program on today's mint (it holds the hook authority).
    let issuer = Pubkey::new_unique();
    let hooked = extended_mint(6, &[ExtensionType::TransferHook], |m| {
        let hook = m.init_extension::<TransferHook>(true).unwrap();
        *hook = some_key(issuer);
        hook.program_id = Some(HOOK).try_into().unwrap();
    });
    f.ctx.set_account(&USDG, &hooked.into());
    let destination = ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID);
    f.ctx
        .set_account(&f.input, &hooked_token(f.vault, 1000).into());
    f.ctx
        .set_account(&destination, &hooked_token(f.owner.pubkey(), 0).into());
    f.ctx
        .set_account(&hook_validation(), &account(HOOK, hook_meta_list(), 0).into());
    let withdraw = |f: &Fixture, amount: u64, extra: &[AccountMeta]| {
        let mut accounts = vault::accounts::Withdraw {
            vault: f.vault,
            owner: f.owner.pubkey(),
            mint: USDG,
            vault_token: f.input,
            owner_token: destination,
            token_program: spl_token_2022::ID,
        }
        .to_account_metas(None);
        accounts.extend_from_slice(extra);
        Instruction {
            program_id: vault::ID,
            accounts,
            data: vault::instruction::Withdraw { amount }.data(),
        }
    };
    let hook_accounts = [
        AccountMeta::new_readonly(HOOK_FIXED, false),
        AccountMeta::new_readonly(hook_pda(&destination), false),
        AccountMeta::new_readonly(hook_validation(), false),
        AccountMeta::new_readonly(HOOK, false),
    ];
    // Swaps still refuse a hooked mint; withdrawal is the owner's way out.
    let buy = f.swap_ix(0, 1, 0).await;
    f.donate(&buy, 0);
    assert!(vault_error(f.swap(buy).await, vault::VaultError::Mint));
    // Without the hook's accounts Token-2022 cannot call the hook, and nothing moves.
    let plain = withdraw(&f, 400, &[]);
    assert!(f.owner_send(vec![plain]).await.is_err());
    assert_eq!(f.balance(f.input).await, 1000);
    assert_eq!(f.state().await.seq, 0);
    // The owner's wallet among them is refused: its signature never reaches a hook.
    let mut smuggled = hook_accounts.to_vec();
    smuggled.push(AccountMeta::new_readonly(f.owner.pubkey(), false));
    let smuggled = withdraw(&f, 400, &smuggled);
    assert!(vault_error(
        f.owner_send(vec![smuggled]).await,
        vault::VaultError::Authority
    ));
    assert_eq!(f.balance(f.input).await, 1000);
    // With them, in any order, the vault releases exactly the amount to the owner.
    let good = withdraw(&f, 400, &hook_accounts);
    f.owner_send(vec![good]).await.unwrap();
    assert_eq!(f.balance(f.input).await, 600);
    assert_eq!(f.balance(destination).await, 400);
    assert_eq!(f.state().await.seq, 1);
    let mut reversed = hook_accounts.to_vec();
    reversed.reverse();
    let rest = withdraw(&f, 600, &reversed);
    f.owner_send(vec![rest]).await.unwrap();
    assert_eq!(f.balance(f.input).await, 0);
    assert_eq!(f.balance(destination).await, 1000);
    assert_eq!(f.state().await.seq, 2);
}

// ---- Custody invariants (audit VAULT-3). Each case runs the compiled program. ----

const ANCHOR_INVALID_PROGRAM_ID: u32 = 3008;
/// A transfer hook with an authority and no program.
fn some_key(key: Pubkey) -> TransferHook {
    TransferHook {
        authority: Some(key).try_into().unwrap(),
        ..TransferHook::default()
    }
}
/// USDG with the issuer extensions the program accepts: zero-fee transfer fee config, a
/// transfer hook with no program, close authority, permanent delegate and metadata pointer.
fn usdg_with_known_extensions() -> Account {
    let issuer = Pubkey::new_unique();
    extended_mint(
        6,
        &[
            ExtensionType::TransferFeeConfig,
            ExtensionType::TransferHook,
            ExtensionType::MintCloseAuthority,
            ExtensionType::PermanentDelegate,
            ExtensionType::MetadataPointer,
        ],
        |m| {
            let fee = m.init_extension::<TransferFeeConfig>(true).unwrap();
            fee.transfer_fee_config_authority = Some(issuer).try_into().unwrap();
            fee.withdraw_withheld_authority = Some(issuer).try_into().unwrap();
            // Configured but zero: a maximum fee alone never debits anything.
            fee.older_transfer_fee.maximum_fee = 5_000u64.into();
            fee.newer_transfer_fee.maximum_fee = 5_000u64.into();
            *m.init_extension::<TransferHook>(true).unwrap() = some_key(issuer);
            m.init_extension::<MintCloseAuthority>(true)
                .unwrap()
                .close_authority = Some(issuer).try_into().unwrap();
            m.init_extension::<PermanentDelegate>(true)
                .unwrap()
                .delegate = Some(issuer).try_into().unwrap();
            let pointer = m.init_extension::<MetadataPointer>(true).unwrap();
            pointer.authority = Some(issuer).try_into().unwrap();
            pointer.metadata_address = Some(USDG).try_into().unwrap();
        },
    )
}
/// USDG mints that must fail the extension screen, by name.
fn usdg_with_unsafe_extensions() -> Vec<(&'static str, Account)> {
    let issuer = Pubkey::new_unique();
    let fee = |older: u16, newer: u16| {
        extended_mint(6, &[ExtensionType::TransferFeeConfig], move |m| {
            let fee = m.init_extension::<TransferFeeConfig>(true).unwrap();
            fee.older_transfer_fee.transfer_fee_basis_points = older.into();
            fee.newer_transfer_fee.transfer_fee_basis_points = newer.into();
            fee.older_transfer_fee.maximum_fee = u64::MAX.into();
            fee.newer_transfer_fee.maximum_fee = u64::MAX.into();
        })
    };
    vec![
        ("scheduled transfer fee", fee(0, 1)),
        ("active transfer fee", fee(1, 0)),
        (
            "transfer hook program",
            extended_mint(6, &[ExtensionType::TransferHook], |m| {
                let hook = m.init_extension::<TransferHook>(true).unwrap();
                *hook = some_key(issuer);
                hook.program_id = Some(Pubkey::new_unique()).try_into().unwrap();
            }),
        ),
        (
            "non-transferable",
            extended_mint(6, &[ExtensionType::NonTransferable], |m| {
                m.init_extension::<NonTransferable>(true).unwrap();
            }),
        ),
        (
            "pausable",
            extended_mint(6, &[ExtensionType::Pausable], |m| {
                m.init_extension::<PausableConfig>(true).unwrap().authority =
                    Some(issuer).try_into().unwrap();
            }),
        ),
        (
            "default frozen accounts",
            extended_mint(6, &[ExtensionType::DefaultAccountState], |m| {
                m.init_extension::<DefaultAccountState>(true).unwrap().state =
                    spl_token_2022::state::AccountState::Frozen as u8;
            }),
        ),
        (
            "interest bearing",
            extended_mint(6, &[ExtensionType::InterestBearingConfig], |m| {
                m.init_extension::<InterestBearingConfig>(true)
                    .unwrap()
                    .rate_authority = Some(issuer).try_into().unwrap();
            }),
        ),
    ]
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn usdg_with_its_known_issuer_extensions_trades_both_ways() {
    let mut f = Fixture::new().await;
    f.ctx
        .set_account(&USDG, &usdg_with_known_extensions().into());
    let buy = f.swap_ix(0, 1, 0).await;
    f.swap(buy).await.unwrap();
    assert_eq!(
        (f.balance(f.input).await, f.balance(f.output).await),
        (900, 200)
    );
    let caps = f.session_ix(100, 500);
    f.owner_send(vec![caps]).await.unwrap();
    let sell = f.swap_ix(1, 2, 3).await;
    f.swap(sell).await.unwrap();
    assert_eq!(
        (f.balance(f.input).await, f.balance(f.output).await),
        (1000, 100)
    );
    assert_eq!(f.state().await.seq, 2);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn usdg_with_a_fee_hook_or_unknown_extension_is_refused_as_input_and_output() {
    for (name, usdg) in usdg_with_unsafe_extensions() {
        let mut f = Fixture::new().await;
        f.ctx.set_account(&USDG, &usdg.into());
        // The temporary account exists, so only the program's own screen can refuse.
        let buy = f.swap_ix(0, 1, 0).await;
        f.donate(&buy, 0);
        assert!(
            vault_error(f.swap(buy).await, vault::VaultError::Mint),
            "{name}: buy"
        );
        f.untouched().await;
        f.hold_wsol(200).await;
        let sell = f.swap_ix(0, 1, 3).await;
        f.donate(&sell, 0);
        assert!(
            vault_error(f.swap(sell).await, vault::VaultError::Mint),
            "{name}: sell"
        );
        assert_eq!(
            (f.balance(f.input).await, f.balance(f.output).await),
            (1000, 200),
            "{name}"
        );
        assert_eq!(f.state().await.seq, 0, "{name}");
    }
}

/// The mainnet USDG mint (fixtures/usdg-mainnet-mint.json): the bytes one read-only
/// getAccountInfo returned at the recorded slot, and variants of them, each with the
/// verdict the vault must give.
fn usdg_mainnet_fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/usdg-mainnet-mint.json")).unwrap()
}
fn hex_bytes(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "odd hex {text}");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}
fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
/// The fixture's mint account changed by one variant's ops, in order ("set" writes hex at
/// byte offset "at", "append" adds it at the end), and checked against the variant's SHA-256.
fn usdg_mainnet_variant(f: &serde_json::Value, variant: &serde_json::Value) -> Account {
    let mut data = base64::engine::general_purpose::STANDARD
        .decode(f["dataBase64"].as_str().unwrap())
        .unwrap();
    for op in variant["ops"].as_array().unwrap() {
        let bytes = hex_bytes(op["hex"].as_str().unwrap());
        match op["op"].as_str().unwrap() {
            "set" => {
                let at = usize::try_from(op["at"].as_u64().unwrap()).unwrap();
                data[at..at + bytes.len()].copy_from_slice(&bytes);
            }
            "append" => data.extend_from_slice(&bytes),
            other => panic!("unknown op {other}"),
        }
    }
    assert_eq!(
        hex_string(&solana_sdk::hash::hash(&data).to_bytes()),
        variant["sha256"].as_str().unwrap(),
        "{}",
        variant["name"]
    );
    Account {
        lamports: f["lamports"].as_u64().unwrap(),
        data,
        owner: f["owner"].as_str().unwrap().parse().unwrap(),
        executable: false,
        rent_epoch: 0,
    }
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn the_mainnet_usdg_mint_as_read_carries_only_extensions_the_vault_accepts_and_trades_both_ways(
) {
    use spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
    let f = usdg_mainnet_fixture();
    assert_eq!(f["address"].as_str().unwrap(), USDG.to_string());
    assert_eq!(f["owner"].as_str().unwrap(), spl_token_2022::ID.to_string());
    let read = &f["variants"][0];
    assert_eq!(read["name"].as_str(), Some("as read"));
    assert_eq!(read["vault"].as_str(), Some("accepts"));
    assert!(read["ops"].as_array().unwrap().is_empty());
    let usdg = usdg_mainnet_variant(&f, read);
    assert_eq!(
        hex_string(&solana_sdk::hash::hash(&usdg.data).to_bytes()),
        f["dataSha256"].as_str().unwrap()
    );
    // The program's own spl-token-2022 parses the account, and finds exactly the extensions
    // the fixture lists (all in check_mint's allowlist, which the trade below exercises).
    let state = StateWithExtensions::<RawMint>::unpack(&usdg.data).unwrap();
    let found: Vec<String> = state
        .get_extension_types()
        .unwrap()
        .iter()
        .map(|t| format!("{t:?}"))
        .collect();
    let listed: Vec<String> = f["decoded"]["extensions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(found, listed);
    assert_eq!((state.base.decimals, state.base.is_initialized), (6, true));
    let fee = state.get_extension::<TransferFeeConfig>().unwrap();
    assert_eq!(
        (
            u16::from(fee.older_transfer_fee.transfer_fee_basis_points),
            u16::from(fee.newer_transfer_fee.transfer_fee_basis_points)
        ),
        (0, 0)
    );
    let hook = state.get_extension::<TransferHook>().unwrap();
    assert!(Option::<Pubkey>::from(hook.program_id).is_none());

    let mut fx = Fixture::new().await;
    fx.ctx.set_account(&USDG, &usdg.into());
    let buy = fx.swap_ix(0, 1, 0).await;
    fx.swap(buy).await.unwrap();
    assert_eq!(
        (fx.balance(fx.input).await, fx.balance(fx.output).await),
        (900, 200)
    );
    let caps = fx.session_ix(100, 500);
    fx.owner_send(vec![caps]).await.unwrap();
    let sell = fx.swap_ix(1, 2, 3).await;
    fx.swap(sell).await.unwrap();
    assert_eq!(
        (fx.balance(fx.input).await, fx.balance(fx.output).await),
        (1000, 100)
    );
    assert_eq!(fx.state().await.seq, 2);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn every_mainnet_usdg_mint_variant_gets_the_vault_verdict_the_fixture_gives_both_ways() {
    let f = usdg_mainnet_fixture();
    let variants = f["variants"].as_array().unwrap();
    assert!(variants.iter().any(|v| v["vault"] == "refuses"));
    for variant in variants {
        let name = variant["name"].as_str().unwrap();
        let usdg = usdg_mainnet_variant(&f, variant);
        let mut fx = Fixture::new().await;
        fx.ctx.set_account(&USDG, &usdg.into());
        match variant["vault"].as_str().unwrap() {
            "accepts" => {
                let buy = fx.swap_ix(0, 1, 0).await;
                fx.swap(buy).await.unwrap();
                let caps = fx.session_ix(100, 500);
                fx.owner_send(vec![caps]).await.unwrap();
                let sell = fx.swap_ix(1, 2, 3).await;
                fx.swap(sell).await.unwrap();
                assert_eq!(
                    (fx.balance(fx.input).await, fx.balance(fx.output).await),
                    (1000, 100),
                    "{name}"
                );
                assert_eq!(fx.state().await.seq, 2, "{name}");
            }
            "refuses" => {
                // The temporary account exists, so only the program's own screen can refuse.
                let buy = fx.swap_ix(0, 1, 0).await;
                fx.donate(&buy, 0);
                assert!(
                    vault_error(fx.swap(buy).await, vault::VaultError::Mint),
                    "{name}: buy"
                );
                fx.untouched().await;
                fx.hold_wsol(200).await;
                let sell = fx.swap_ix(0, 1, 3).await;
                fx.donate(&sell, 0);
                assert!(
                    vault_error(fx.swap(sell).await, vault::VaultError::Mint),
                    "{name}: sell"
                );
                assert_eq!(
                    (fx.balance(fx.input).await, fx.balance(fx.output).await),
                    (1000, 200),
                    "{name}"
                );
                assert_eq!(fx.state().await.seq, 0, "{name}");
            }
            other => panic!("{name}: unknown vault verdict {other}"),
        }
    }
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn substitute_mints_decimals_and_token_programs_are_refused() {
    let classic = anchor_spl::token::ID;
    let t22 = spl_token_2022::ID;
    // Wrong decimals, a freezable WSOL, or the right address under the wrong program.
    let mut frozen_wsol = mint(classic, 9);
    let mut raw = spl_token_2022::state::Mint::unpack(&frozen_wsol.data).unwrap();
    raw.freeze_authority = COption::Some(Pubkey::new_unique());
    spl_token_2022::state::Mint::pack(raw, &mut frozen_wsol.data).unwrap();
    for (name, key, replacement) in [
        ("USDG with 9 decimals", USDG, mint(t22, 9)),
        ("WSOL with 6 decimals", WSOL, mint(classic, 6)),
        ("WSOL with a freeze authority", WSOL, frozen_wsol),
    ] {
        let mut f = Fixture::new().await;
        f.ctx.set_account(&key, &replacement.into());
        let buy = f.swap_ix(0, 1, 0).await;
        f.donate(&buy, 0);
        assert!(
            vault_error(f.swap(buy).await, vault::VaultError::Mint),
            "{name}"
        );
        f.untouched().await;
    }
    // USDG under the classic program and WSOL under Token-2022, with custody accounts that
    // match, so only the program's mint/program pin can refuse.
    let mut f = Fixture::new().await;
    f.ctx.set_account(&USDG, &mint(classic, 6).into());
    f.put_token(f.vault, USDG, classic, 1000);
    let side = Side {
        input_program: classic,
        ..f.side(true)
    };
    let buy = f.swap_ix_side(0, 1, 0, side).await;
    f.donate(&buy, 0);
    assert!(
        vault_error(f.swap(buy).await, vault::VaultError::Mint),
        "USDG under Token"
    );
    let mut f = Fixture::new().await;
    f.ctx.set_account(&WSOL, &mint(t22, 9).into());
    f.put_token(f.vault, WSOL, t22, 0);
    let side = Side {
        output_program: t22,
        ..f.side(true)
    };
    let buy = f.swap_ix_side(0, 1, 0, side).await;
    f.donate(&buy, 0);
    assert!(
        vault_error(f.swap(buy).await, vault::VaultError::Mint),
        "WSOL under Token-2022"
    );
    f.untouched().await;
    // Look-alike mints at other addresses, with custody accounts for them.
    let mut f = Fixture::new().await;
    let fake_usdg = Pubkey::new_unique();
    let fake_wsol = Pubkey::new_unique();
    f.ctx.set_account(&fake_usdg, &mint(t22, 6).into());
    f.ctx.set_account(&fake_wsol, &mint(classic, 9).into());
    f.put_token(f.vault, fake_usdg, t22, 1000);
    f.put_token(f.vault, fake_wsol, classic, 1000);
    for (name, side) in [
        (
            "look-alike USDG input",
            Side {
                input_mint: fake_usdg,
                ..f.side(true)
            },
        ),
        (
            "look-alike WSOL output",
            Side {
                output_mint: fake_wsol,
                ..f.side(true)
            },
        ),
        (
            "look-alike WSOL input",
            Side {
                input_mint: fake_wsol,
                ..f.side(false)
            },
        ),
        (
            "look-alike USDG output",
            Side {
                output_mint: fake_usdg,
                ..f.side(false)
            },
        ),
    ] {
        let ix = f
            .swap_ix_side(
                0,
                1,
                if side.input_mint == USDG || side.input_mint == fake_usdg {
                    0
                } else {
                    3
                },
                side,
            )
            .await;
        f.donate(&ix, 0);
        assert!(
            vault_error(f.swap(ix).await, vault::VaultError::Mint),
            "{name}"
        );
    }
    // A program that is not a token program at all never gets past account validation.
    let mut ix = f.swap_ix(0, 1, 0).await;
    ix.accounts[9] = AccountMeta::new_readonly(anchor_lang::system_program::ID, false);
    assert!(custom_error(f.swap(ix).await, ANCHOR_INVALID_PROGRAM_ID));
    f.untouched().await;
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn another_tenants_session_owner_or_custody_cannot_touch_this_vault() {
    let mut f = Fixture::new().await;
    let b = f.add_tenant().await;
    let b_usdg = ata(&b.vault, &USDG, &spl_token_2022::ID);
    let b_wsol = ata(&b.vault, &WSOL, &anchor_spl::token::ID);
    // B's session on A's vault, and A's session on B's vault.
    let side = Side {
        session: b.session.pubkey(),
        ..f.side(true)
    };
    let ix = f.swap_ix_side(0, 1, 0, side).await;
    assert!(vault_error(
        f.signed(vec![ix], &[&b.session]).await,
        vault::VaultError::Authority
    ));
    let side = Side {
        vault: b.vault,
        ..f.side(true)
    };
    let ix = f.swap_ix_side(0, 1, 0, side).await;
    assert!(vault_error(f.swap(ix).await, vault::VaultError::Authority));
    // A's own session and vault, but B's custody as source or destination.
    let mut ix = f.swap_ix(0, 1, 0).await;
    ix.accounts[5] = AccountMeta::new(b_usdg, false);
    assert!(custom_error(f.swap(ix).await, ANCHOR_TOKEN_OWNER));
    let mut ix = f.swap_ix(0, 1, 0).await;
    ix.accounts[6] = AccountMeta::new(b_wsol, false);
    ix.accounts[15 + 6] = AccountMeta::new(b_wsol, false);
    assert!(custom_error(f.swap(ix).await, ANCHOR_TOKEN_OWNER));
    // B's vault state in A's route.
    let mut ix = f.swap_ix(0, 1, 0).await;
    ix.accounts.push(AccountMeta::new(b.vault, false));
    assert!(vault_error(f.swap(ix).await, vault::VaultError::Route));
    // B's owner on A's vault: every owner instruction is bound to the vault's own seeds.
    let owner_b = b.owner.pubkey();
    let b_owner_usdg = ata(&owner_b, &USDG, &spl_token_2022::ID);
    let owned = vault::accounts::OwnerAuthority {
        vault: f.vault,
        owner: owner_b,
    }
    .to_account_metas(None);
    let attempts = [
        Instruction {
            program_id: vault::ID,
            accounts: owned.clone(),
            data: vault::instruction::RevokeAll {}.data(),
        },
        create_session_ix(
            f.vault,
            owner_b,
            b.session.pubkey(),
            100,
            150,
            100,
            300,
            f.expiry,
        ),
        Instruction {
            program_id: vault::ID,
            accounts: vault::accounts::Withdraw {
                vault: f.vault,
                owner: owner_b,
                mint: USDG,
                vault_token: f.input,
                owner_token: b_owner_usdg,
                token_program: spl_token_2022::ID,
            }
            .to_account_metas(None),
            data: vault::instruction::Withdraw { amount: 1000 }.data(),
        },
        Instruction {
            program_id: vault::ID,
            accounts: vault::accounts::OwnerNativeWithdraw {
                vault: f.vault,
                owner: owner_b,
            }
            .to_account_metas(None),
            data: vault::instruction::WithdrawSol { amount: 1 }.data(),
        },
    ];
    for ix in attempts {
        assert!(custom_error(
            f.send_as(vec![ix], &b.owner).await,
            ANCHOR_SEEDS
        ));
    }
    f.untouched().await;
    let breaker = |vault, authority, paused| Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::BreakerAuthority { vault, authority }.to_account_metas(None),
        data: vault::instruction::SetBreaker { paused }.data(),
    };
    // B's session cannot pause A; once A's session pauses, B's owner cannot clear it.
    let ix = breaker(f.vault, b.session.pubkey(), true);
    assert!(vault_error(
        f.signed(vec![ix], &[&b.session]).await,
        vault::VaultError::Authority
    ));
    assert!(!f.state().await.paused);
    let ix = breaker(f.vault, f.session.pubkey(), true);
    f.swap(ix).await.unwrap();
    let ix = breaker(f.vault, owner_b, false);
    assert!(vault_error(
        f.send_as(vec![ix], &b.owner).await,
        vault::VaultError::Authority
    ));
    assert!(f.state().await.paused);
    // Both tenants are intact and each still trades only its own custody.
    assert_eq!(
        (f.balance(b_usdg).await, f.balance(b_wsol).await),
        (1000, 0)
    );
    let state = f.state().await;
    assert_eq!(
        (state.seq, state.session_epoch, state.session),
        (0, 1, f.session.pubkey())
    );
    let side = Side {
        vault: b.vault,
        session: b.session.pubkey(),
        ..f.side(true)
    };
    let ix = f.swap_ix_side(0, 1, 0, side).await;
    f.signed(vec![ix], &[&b.session]).await.unwrap();
    assert_eq!(
        (f.balance(b_usdg).await, f.balance(b_wsol).await),
        (900, 200)
    );
    assert_eq!(
        (f.balance(f.input).await, f.balance(f.output).await),
        (1000, 0)
    );
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn create_session_refuses_an_expiry_more_than_seven_days_ahead_and_changes_nothing() {
    // web-auth F4: the server never prepares a longer session, and the program refuses
    // one signed anywhere else. The cap runs from the cluster clock at create_session.
    let mut f = Fixture::new().await;
    let owner = f.owner.insecure_clone();
    let now = f.now().await + 3 * 86_400;
    f.set_time(now).await;
    let latest = now + vault::risk::MAX_SESSION + vault::risk::SESSION_CLOCK_ALLOWANCE;
    assert_eq!(latest - now, 7 * 86_400 + 15 * 60);
    let before = f.state().await;
    let (vault_key, session_key) = (f.vault, f.session.pubkey());
    let session_with = |expiry| {
        create_session_ix(
            vault_key,
            owner.pubkey(),
            session_key,
            100,
            150,
            100,
            300,
            expiry,
        )
    };
    for expiry in [latest + 1, now + 30 * 86_400, 4_000_000_000, i64::MAX] {
        let ix = session_with(expiry);
        assert!(
            vault_error(f.send_as(vec![ix], &owner).await, vault::VaultError::RiskLimit),
            "expiry {expiry}"
        );
        // The refused replacement leaves the running session exactly as it was.
        let state = f.state().await;
        assert_eq!(
            (state.session, state.session_epoch, state.expires_at, state.seq),
            (before.session, before.session_epoch, before.expires_at, before.seq),
        );
    }
    // A fresh vault cannot start with one either: the whole transaction rolls back.
    let tenant_owner = Keypair::new();
    let (tenant_vault, _) =
        Pubkey::find_program_address(&[b"vault", tenant_owner.pubkey().as_ref()], &vault::ID);
    f.ctx.set_account(
        &tenant_owner.pubkey(),
        &account(anchor_lang::system_program::ID, vec![], 100_000_000).into(),
    );
    let init = Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::InitializeVault {
            vault: tenant_vault,
            owner: tenant_owner.pubkey(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: vault::instruction::InitializeVault {}.data(),
    };
    let long = create_session_ix(
        tenant_vault,
        tenant_owner.pubkey(),
        Keypair::new().pubkey(),
        100,
        150,
        100,
        300,
        latest + 1,
    );
    let refused = f.send_as(vec![init, long], &tenant_owner).await;
    assert!(
        matches!(
            refused.map_err(|e| e.unwrap()),
            Err(solana_sdk::transaction::TransactionError::InstructionError(
                1,
                solana_sdk::instruction::InstructionError::Custom(code)
            )) if code == 6000 + vault::VaultError::RiskLimit as u32
        ),
        "a too-long first session must fail with RiskLimit"
    );
    assert!(!f.exists(tenant_vault).await);
    // Exactly at the cap is allowed, and the session is replaced as usual.
    let ix = session_with(latest);
    f.send_as(vec![ix], &owner).await.unwrap();
    let state = f.state().await;
    assert_eq!(state.expires_at, latest);
    assert_eq!(state.session_epoch, before.session_epoch + 1);
    assert_eq!(state.seq, before.seq);
    // The new session trades, and stops at the expiry it was given.
    let buy = f.swap_ix(0, state.session_epoch, 0).await;
    f.swap(buy).await.unwrap();
    f.set_time(latest).await;
    let buy = f.swap_ix(1, state.session_epoch, 0).await;
    assert!(vault_error(f.swap(buy).await, vault::VaultError::RiskLimit));
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn an_expired_session_or_deadline_cannot_trade_and_the_owner_still_withdraws() {
    let mut f = Fixture::new().await;
    let now = f.now().await;
    let expiry = now + 100;
    let short = create_session_ix(
        f.vault,
        f.owner.pubkey(),
        f.session.pubkey(),
        100,
        300,
        100,
        300,
        expiry,
    );
    f.owner_send(vec![short]).await.unwrap();
    // ExecuteSwap data: disc, expected_seq, session_epoch, amount_in, min_out, then deadline.
    for deadline in [now, now - 1, now + 31] {
        let mut ix = f.swap_ix(0, 2, 0).await;
        ix.data[40..48].copy_from_slice(&deadline.to_le_bytes());
        assert!(
            vault_error(f.swap(ix).await, vault::VaultError::Expired),
            "deadline {deadline}"
        );
    }
    f.untouched().await;
    let buy = f.swap_ix(0, 2, 0).await;
    f.swap(buy).await.unwrap();
    f.set_time(expiry - 1).await;
    let buy = f.swap_ix(1, 2, 0).await;
    f.swap(buy).await.unwrap();
    assert_eq!(
        (f.balance(f.input).await, f.balance(f.output).await),
        (800, 400)
    );
    // At expiry neither a buy nor an exit is authorized any more.
    f.set_time(expiry).await;
    let buy = f.swap_ix(2, 2, 0).await;
    assert!(vault_error(f.swap(buy).await, vault::VaultError::RiskLimit));
    let sell = f.swap_ix(2, 2, 3).await;
    assert!(vault_error(
        f.swap(sell).await,
        vault::VaultError::RiskLimit
    ));
    assert_eq!(
        (f.balance(f.input).await, f.balance(f.output).await),
        (800, 400)
    );
    assert_eq!(f.state().await.seq, 2);
    // The owner's recovery never depends on the session.
    let destination = ata(&f.owner.pubkey(), &USDG, &spl_token_2022::ID);
    let withdraw = Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::Withdraw {
            vault: f.vault,
            owner: f.owner.pubkey(),
            mint: USDG,
            vault_token: f.input,
            owner_token: destination,
            token_program: spl_token_2022::ID,
        }
        .to_account_metas(None),
        data: vault::instruction::Withdraw { amount: 800 }.data(),
    };
    f.owner_send(vec![withdraw]).await.unwrap();
    assert_eq!(
        (f.balance(f.input).await, f.balance(destination).await),
        (0, 800)
    );
    assert_eq!(f.state().await.seq, 3);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn the_fee_payer_can_be_neither_the_session_nor_the_owner() {
    let mut f = Fixture::new().await;
    let (session, owner) = (f.session.insecure_clone(), f.owner.insecure_clone());
    let mut ix = f.swap_ix(0, 1, 0).await;
    ix.accounts[2] = AccountMeta::new(session.pubkey(), true);
    // An existing temporary account, so the session's rent cannot be what fails.
    f.donate(&ix, 0);
    assert!(vault_error(f.swap(ix).await, vault::VaultError::Authority));
    let mut ix = f.swap_ix(0, 1, 0).await;
    ix.accounts[2] = AccountMeta::new(owner.pubkey(), true);
    assert!(vault_error(
        f.signed(vec![ix], &[&session, &owner]).await,
        vault::VaultError::Authority
    ));
    f.untouched().await;
    let ok = f.swap_ix(0, 1, 0).await;
    f.swap(ok).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn the_route_cannot_carry_the_fee_payer_vault_state_owner_wallet_or_other_custody() {
    let mut f = Fixture::new().await;
    // A custody-held USDG account that is not the destination ATA.
    let side_account = Pubkey::new_unique();
    f.ctx.set_account(
        &side_account,
        &token(spl_token_2022::ID, USDG, f.vault, 0).into(),
    );
    let payer = f.ctx.payer.pubkey();
    for (name, extra) in [
        ("fee payer", AccountMeta::new(payer, false)),
        (
            "fee payer read-only",
            AccountMeta::new_readonly(payer, false),
        ),
        ("vault state", AccountMeta::new(f.vault, false)),
        (
            "vault state read-only",
            AccountMeta::new_readonly(f.vault, false),
        ),
        ("owner wallet", AccountMeta::new(f.owner.pubkey(), false)),
        (
            "other custody account",
            AccountMeta::new(side_account, false),
        ),
    ] {
        let mut ix = f.swap_ix(0, 1, 0).await;
        ix.accounts.push(extra);
        assert!(
            vault_error(f.swap(ix).await, vault::VaultError::Route),
            "{name}"
        );
    }
    // The fee payer cannot stand in for a fixed route slot either.
    let mut ix = f.swap_ix(0, 1, 0).await;
    ix.accounts[15 + 4] = AccountMeta::new(payer, false);
    assert!(vault_error(f.swap(ix).await, vault::VaultError::Route));
    f.untouched().await;
}

// ---- TypeScript-built instructions against the compiled program (audit core-abi-4). ----

/// Written by packages/core/src/solana-live.test.ts from the TypeScript builders, which
/// also checks that it is current. Nothing here rebuilds an instruction.
const TS_FIXTURE: &str = include_str!("fixtures/ts-instructions.json");
fn fixture_key(value: &serde_json::Value) -> Pubkey {
    value
        .as_str()
        .expect("base58 key")
        .parse()
        .expect("valid key")
}
fn fixture_instruction(step: &serde_json::Value) -> Instruction {
    let hex = step["data"].as_str().unwrap();
    let data = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    let accounts = step["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| AccountMeta {
            pubkey: fixture_key(&a["pubkey"]),
            is_signer: a["signer"].as_bool().unwrap(),
            is_writable: a["writable"].as_bool().unwrap(),
        })
        .collect();
    Instruction {
        program_id: fixture_key(&step["programId"]),
        accounts,
        data,
    }
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn typescript_built_instructions_run_against_the_compiled_program() {
    let fx: serde_json::Value = serde_json::from_str(TS_FIXTURE).unwrap();
    let key = |name: &str| fixture_key(&fx["keys"][name]);
    let seeded =
        |name: &str| Keypair::new_from_array([fx["seeds"][name].as_u64().unwrap() as u8; 32]);
    let (owner, session, fee_payer) = (seeded("owner"), seeded("session"), seeded("feePayer"));
    let t22 = spl_token_2022::ID;
    let classic = anchor_spl::token::ID;
    // The TypeScript derivations agree with the program's and the token programs'.
    assert_eq!(fixture_key(&fx["program"]), vault::ID);
    assert_eq!(owner.pubkey(), key("owner"));
    assert_eq!(session.pubkey(), key("session"));
    assert_eq!(fee_payer.pubkey(), key("feePayer"));
    let (vault_key, _) =
        Pubkey::find_program_address(&[b"vault", owner.pubkey().as_ref()], &vault::ID);
    assert_eq!(vault_key, key("vault"));
    assert_eq!(ata(&vault_key, &USDG, &t22), key("vaultUsdg"));
    assert_eq!(ata(&vault_key, &WSOL, &classic), key("vaultWsol"));
    assert_eq!(ata(&owner.pubkey(), &USDG, &t22), key("ownerUsdg"));
    let (authority, _) = Pubkey::find_program_address(&[b"authority", &[0]], &JUPITER);
    assert_eq!(authority, key("jupiterAuthority"));
    for (seq, input, program) in [(0u64, USDG, t22), (1, WSOL, classic), (2, USDG, t22)] {
        let (swap, _) = Pubkey::find_program_address(
            &[b"swap", vault_key.as_ref(), &seq.to_le_bytes()],
            &vault::ID,
        );
        assert_eq!(swap, key(&format!("swap{seq}")));
        assert_eq!(ata(&swap, &input, &program), key(&format!("temp{seq}")));
    }
    let (vault_usdg, vault_wsol, owner_usdg) =
        (key("vaultUsdg"), key("vaultWsol"), key("ownerUsdg"));

    let mut pt = ProgramTest::new("merrymen_vault", vault::ID, None);
    pt.prefer_bpf(false);
    pt.add_program("mock_jupiter", JUPITER, processor!(mock_jupiter));
    let system = anchor_lang::system_program::ID;
    pt.add_account(owner.pubkey(), account(system, vec![], 100_000_000));
    pt.add_account(session.pubkey(), account(system, vec![], 1_000_000));
    pt.add_account(fee_payer.pubkey(), account(system, vec![], 1_000_000_000));
    pt.add_account(USDG, mint(t22, 6));
    pt.add_account(WSOL, mint(classic, 9));
    pt.add_account(vault_usdg, token(t22, USDG, vault_key, 1000));
    pt.add_account(vault_wsol, token(classic, WSOL, vault_key, 0));
    pt.add_account(owner_usdg, token(t22, USDG, owner.pubkey(), 0));
    pt.add_account(key("poolUsdg"), token(t22, USDG, authority, 1000));
    pt.add_account(key("poolWsol"), token(classic, WSOL, authority, 10000));
    pt.add_account(authority, account(system, vec![], 1));
    let mut ctx = pt.start_with_context().await;
    let mut clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp = fx["now"].as_i64().unwrap();
    ctx.set_sysvar(&clock);

    async fn read_state(ctx: &mut ProgramTestContext, key: Pubkey) -> Vault {
        let a = ctx.banks_client.get_account(key).await.unwrap().unwrap();
        Vault::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
    async fn amount(ctx: &mut ProgramTestContext, key: Pubkey) -> u64 {
        let a = ctx.banks_client.get_account(key).await.unwrap().unwrap();
        spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Account>::unpack(
            &a.data,
        )
        .unwrap()
        .base
        .amount
    }
    let mut names = Vec::new();
    for step in fx["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        names.push(name.to_string());
        let ix = fixture_instruction(step);
        match name {
            "execute_swap_buy_refund" => {
                let temp = key("temp2");
                ctx.set_account(&temp, &token(t22, USDG, key("swap2"), 7).into());
            }
            "withdraw_sol" => {
                let mut lamports = ctx
                    .banks_client
                    .get_account(vault_key)
                    .await
                    .unwrap()
                    .unwrap();
                lamports.lamports += 1000;
                ctx.set_account(&vault_key, &lamports.into());
            }
            _ => {}
        }
        let signers: Vec<&Keypair> = step["signers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| match s.as_str().unwrap() {
                "owner" => &owner,
                "session" => &session,
                "feePayer" => &fee_payer,
                other => panic!("unknown signer {other}"),
            })
            .collect();
        // A swap is paid by its own fee payer, as in production; owner steps by the cluster.
        let payer = if signers.iter().any(|s| s.pubkey() == fee_payer.pubkey()) {
            fee_payer.insecure_clone()
        } else {
            ctx.payer.insecure_clone()
        };
        let mut all = vec![&payer];
        all.extend(signers.into_iter().filter(|s| s.pubkey() != payer.pubkey()));
        let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &all, hash);
        let result = ctx.banks_client.process_transaction(tx).await;
        assert!(result.is_ok(), "{name}: {result:?}");
        let state = read_state(&mut ctx, vault_key).await;
        let (usdg, wsol) = (
            amount(&mut ctx, vault_usdg).await,
            amount(&mut ctx, vault_wsol).await,
        );
        match name {
            "initialize_vault" => assert_eq!(
                (state.owner, state.version),
                (owner.pubkey(), vault::VERSION)
            ),
            "create_session" => {
                assert_eq!((state.session, state.session_epoch), (session.pubkey(), 1));
                assert_eq!(
                    (
                        state.per_trade,
                        state.daily,
                        state.per_trade_wsol,
                        state.daily_wsol
                    ),
                    (100, 300, 100, 300)
                );
                assert_eq!(
                    (state.max_ops, state.expires_at),
                    (10, clock.unix_timestamp + 86_400)
                );
            }
            "execute_swap_buy" => assert_eq!((usdg, wsol, state.seq), (900, 200, 1)),
            "execute_swap_sell" => assert_eq!((usdg, wsol, state.seq), (1000, 100, 2)),
            "set_breaker_session_pause" => assert!(state.paused),
            "set_breaker_owner_clear" => assert!(!state.paused),
            "execute_swap_buy_refund" => {
                assert_eq!((usdg, wsol, state.seq), (900, 300, 3));
                assert_eq!(amount(&mut ctx, owner_usdg).await, 7);
                assert_eq!(state.debits.iter().map(|d| d.notional).sum::<u64>(), 300);
            }
            "withdraw" => {
                assert_eq!((usdg, state.seq), (850, 4));
                assert_eq!(amount(&mut ctx, owner_usdg).await, 57);
            }
            "withdraw_sol" => {
                let info = ctx
                    .banks_client
                    .get_account(vault_key)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    info.lamports,
                    Rent::default().minimum_balance(info.data.len())
                );
                assert_eq!(state.seq, 5);
            }
            "revoke_all" => {
                assert_eq!((state.session, state.session_epoch), (Pubkey::default(), 2));
                assert!(state.paused);
            }
            other => panic!("unexpected fixture step {other}"),
        }
    }
    assert_eq!(
        names,
        [
            "initialize_vault",
            "create_session",
            "execute_swap_buy",
            "execute_swap_sell",
            "set_breaker_session_pause",
            "set_breaker_owner_clear",
            "execute_swap_buy_refund",
            "withdraw",
            "withdraw_sol",
            "revoke_all",
        ]
    );
    // Every temporary swap account closed again.
    for temp in ["temp0", "temp1", "temp2"] {
        assert!(ctx
            .banks_client
            .get_account(key(temp))
            .await
            .unwrap()
            .is_none());
    }
}
