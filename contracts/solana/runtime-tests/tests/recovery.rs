//! Owner recovery (`merrymen solana-recover`) against the compiled vault program and the
//! SPL Token, Token-2022 and ATA programs bundled with solana-program-test.
//!
//! The transactions (revoke_all, then one withdrawal per asset: SOL, USDG, WSOL) are read
//! from fixtures/recovery-transactions.txt, which worker/src/solana-recover.test.ts writes
//! from the exact bytes the tool signs and sends.
//! Only the recent blockhash is replaced (the fixture's comes from a fake chain) and the
//! owner signs again; instructions, account order and privileges stay byte-identical.
//! Everything else here only builds a funded vault through the program's own instructions.
use anchor_lang::solana_program::{program_option::COption, program_pack::Pack};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::spl_associated_token_account::{
    get_associated_token_address_with_program_id as ata,
    instruction::create_associated_token_account_idempotent,
};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{
        metadata_pointer::MetadataPointer, mint_close_authority::MintCloseAuthority,
        permanent_delegate::PermanentDelegate, transfer_fee::TransferFeeConfig,
        transfer_hook::TransferHook, BaseStateWithExtensionsMut, ExtensionType,
        StateWithExtensions, StateWithExtensionsMut,
    },
    state::{Account as TokenAccount, Mint as RawMint},
};
use base64::Engine;
use merrymen_vault::{self as vault, Vault, USDG, WSOL};
use solana_program_test::{BanksClientError, ProgramTest, ProgramTestContext};
#[allow(deprecated)]
// solana-system-interface is not a dependency here; the builder is the same.
use solana_sdk::system_instruction;
use solana_sdk::{
    account::Account,
    clock::Clock,
    hash::Hash,
    instruction::{CompiledInstruction, Instruction},
    message::{v0, Message, MessageHeader, VersionedMessage},
    pubkey::Pubkey,
    rent::Rent,
    signature::{Keypair, Signature, Signer},
    transaction::{Transaction, TransactionError, VersionedTransaction},
};
use std::collections::HashMap;

const FIXTURE: &str = include_str!("../fixtures/recovery-transactions.txt");
const CLASSIC_TOKEN: Pubkey = anchor_spl::token::ID;
const TOKEN_2022: Pubkey = spl_token_2022::ID;

fn fixture() -> HashMap<&'static str, &'static str> {
    FIXTURE
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .map(|l| l.split_once(' ').expect("key value"))
        .collect()
}
fn key(f: &HashMap<&str, &str>, name: &str) -> Pubkey {
    f[name].parse().unwrap()
}
fn number(f: &HashMap<&str, &str>, name: &str) -> u64 {
    f[name].parse().unwrap()
}

/// Solana's compact-u16 (short_vec) length prefix.
fn short_u16(bytes: &[u8], at: &mut usize) -> usize {
    let mut value = 0usize;
    for shift in 0..3 {
        let byte = bytes[*at];
        *at += 1;
        value |= ((byte & 0x7f) as usize) << (7 * shift);
        if byte & 0x80 == 0 {
            return value;
        }
    }
    panic!("malformed compact-u16");
}
struct Wire {
    signatures: Vec<Signature>,
    message: Vec<u8>,
    parsed: v0::Message,
}
/// A signed v0 transaction as the tool put it on the wire, parsed exactly.
fn parse_wire(base64_tx: &str) -> Wire {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_tx)
        .unwrap();
    let mut at = 0;
    let count = short_u16(&bytes, &mut at);
    let mut signatures = Vec::new();
    for _ in 0..count {
        signatures.push(Signature::from(
            <[u8; 64]>::try_from(&bytes[at..at + 64]).unwrap(),
        ));
        at += 64;
    }
    let message = bytes[at..].to_vec();
    let m = &message;
    let mut i = 0;
    assert_eq!(m[i], 0x80, "a version 0 message");
    i += 1;
    let header = MessageHeader {
        num_required_signatures: m[i],
        num_readonly_signed_accounts: m[i + 1],
        num_readonly_unsigned_accounts: m[i + 2],
    };
    i += 3;
    let mut account_keys = Vec::new();
    for _ in 0..short_u16(m, &mut i) {
        account_keys.push(Pubkey::try_from(&m[i..i + 32]).unwrap());
        i += 32;
    }
    let recent_blockhash = Hash::new_from_array(m[i..i + 32].try_into().unwrap());
    i += 32;
    let mut instructions = Vec::new();
    for _ in 0..short_u16(m, &mut i) {
        let program_id_index = m[i];
        i += 1;
        let n = short_u16(m, &mut i);
        let accounts = m[i..i + n].to_vec();
        i += n;
        let n = short_u16(m, &mut i);
        let data = m[i..i + n].to_vec();
        i += n;
        instructions.push(CompiledInstruction {
            program_id_index,
            accounts,
            data,
        });
    }
    assert_eq!(short_u16(m, &mut i), 0, "no address lookup tables");
    assert_eq!(i, m.len());
    let parsed = v0::Message {
        header,
        account_keys,
        recent_blockhash,
        instructions,
        address_table_lookups: vec![],
    };
    assert_eq!(
        VersionedMessage::V0(parsed.clone()).serialize(),
        message,
        "parsed without loss"
    );
    Wire {
        signatures,
        message,
        parsed,
    }
}

/// USDG as issued: Token-2022 with a zero transfer fee, a hook-less transfer hook, close
/// authority, permanent delegate and metadata pointer. The test holds its mint authority,
/// and its freeze authority when `freezable`.
fn usdg_mint(issuer: Pubkey, freezable: bool) -> Account {
    let extensions = [
        ExtensionType::TransferFeeConfig,
        ExtensionType::TransferHook,
        ExtensionType::MintCloseAuthority,
        ExtensionType::PermanentDelegate,
        ExtensionType::MetadataPointer,
    ];
    let len = ExtensionType::try_calculate_account_len::<RawMint>(&extensions).unwrap();
    let mut data = vec![0; len];
    {
        let mut m = StateWithExtensionsMut::<RawMint>::unpack_uninitialized(&mut data).unwrap();
        let fee = m.init_extension::<TransferFeeConfig>(true).unwrap();
        fee.transfer_fee_config_authority = Some(issuer).try_into().unwrap();
        fee.withdraw_withheld_authority = Some(issuer).try_into().unwrap();
        m.init_extension::<TransferHook>(true).unwrap().authority =
            Some(issuer).try_into().unwrap();
        m.init_extension::<MintCloseAuthority>(true)
            .unwrap()
            .close_authority = Some(issuer).try_into().unwrap();
        m.init_extension::<PermanentDelegate>(true)
            .unwrap()
            .delegate = Some(issuer).try_into().unwrap();
        let pointer = m.init_extension::<MetadataPointer>(true).unwrap();
        pointer.authority = Some(issuer).try_into().unwrap();
        pointer.metadata_address = Some(USDG).try_into().unwrap();
        m.base = RawMint {
            mint_authority: COption::Some(issuer),
            supply: 0,
            decimals: 6,
            is_initialized: true,
            freeze_authority: if freezable {
                COption::Some(issuer)
            } else {
                COption::None
            },
        };
        m.pack_base();
        m.init_account_type().unwrap();
    }
    Account {
        lamports: Rent::default().minimum_balance(len),
        data,
        owner: TOKEN_2022,
        executable: false,
        rent_epoch: 0,
    }
}
fn wsol_mint() -> Account {
    let mut data = vec![0; RawMint::LEN];
    RawMint::pack(
        RawMint {
            mint_authority: COption::None,
            supply: 0,
            decimals: 9,
            is_initialized: true,
            freeze_authority: COption::None,
        },
        &mut data,
    )
    .unwrap();
    Account {
        lamports: Rent::default().minimum_balance(data.len()),
        data,
        owner: CLASSIC_TOKEN,
        executable: false,
        rent_epoch: 0,
    }
}

struct Chain {
    ctx: ProgramTestContext,
    owner: Keypair,
}
impl Chain {
    async fn account(&mut self, address: Pubkey) -> Option<Account> {
        self.ctx.banks_client.get_account(address).await.unwrap()
    }
    async fn lamports(&mut self, address: Pubkey) -> u64 {
        self.account(address).await.map_or(0, |a| a.lamports)
    }
    async fn token(&mut self, address: Pubkey) -> (u64, u64, usize) {
        let a = self.account(address).await.expect("token account exists");
        let amount = StateWithExtensions::<TokenAccount>::unpack(&a.data)
            .unwrap()
            .base
            .amount;
        (amount, a.lamports, a.data.len())
    }
    async fn vault_state(&mut self, address: Pubkey) -> Vault {
        let a = self.account(address).await.unwrap();
        Vault::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
    async fn setup(&mut self, ixs: &[Instruction], signers: &[&Keypair]) {
        let hash = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let mut all: Vec<&Keypair> = vec![&self.ctx.payer];
        all.extend_from_slice(signers);
        let tx =
            Transaction::new_signed_with_payer(ixs, Some(&self.ctx.payer.pubkey()), &all, hash);
        self.ctx.banks_client.process_transaction(tx).await.unwrap();
    }
    /// Re-signs a fixture transaction under a current blockhash and runs it.
    async fn run_fixture(&mut self, wire: &Wire) -> Result<(), BanksClientError> {
        let mut message = wire.parsed.clone();
        // A fresh blockhash each time, so a rerun is judged by the program, not as a duplicate.
        message.recent_blockhash = self.ctx.get_new_latest_blockhash().await.unwrap();
        let tx =
            VersionedTransaction::try_new(VersionedMessage::V0(message), &[&self.owner]).unwrap();
        self.ctx.banks_client.process_transaction(tx).await
    }
}

struct Fixture {
    program: Pubkey,
    seed: [u8; 32],
    owner: Pubkey,
    vault: Pubkey,
    session: Pubkey,
    usdg: u64,
    synced: u64,
    unsynced: u64,
    excess: u64,
    revoke: Wire,
    /// Step 2, one transaction per asset, in the order the tool sends them.
    sol: Wire,
    usdg_leg: Wire,
    wsol_leg: Wire,
}
fn load() -> Fixture {
    let f = fixture();
    let program = key(&f, "program");
    assert_eq!(program, vault::ID, "the fixture targets this program");
    let seed: [u8; 32] = (0..32)
        .map(|i| u8::from_str_radix(&f["owner_seed_hex"][2 * i..2 * i + 2], 16).unwrap())
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    let owner = Keypair::new_from_array(seed).pubkey();
    assert_eq!(owner, key(&f, "owner"));
    let (vault, _) = Pubkey::find_program_address(&[b"vault", owner.as_ref()], &program);
    assert_eq!(
        vault,
        key(&f, "vault"),
        "TS and Rust derive the same vault PDA"
    );
    let fx = Fixture {
        program,
        seed,
        owner,
        vault,
        session: key(&f, "session"),
        usdg: number(&f, "usdg_raw"),
        synced: number(&f, "wsol_synced_raw"),
        unsynced: number(&f, "wsol_unsynced_lamports"),
        excess: number(&f, "sol_excess_lamports"),
        revoke: parse_wire(f["revoke_tx"]),
        sol: parse_wire(f["withdraw_sol_tx"]),
        usdg_leg: parse_wire(f["withdraw_usdg_tx"]),
        wsol_leg: parse_wire(f["withdraw_wsol_tx"]),
    };
    for wire in [&fx.revoke, &fx.sol, &fx.usdg_leg, &fx.wsol_leg] {
        assert_eq!(wire.signatures.len(), 1, "the owner is the only signer");
        assert_eq!(wire.parsed.account_keys[0], owner, "the owner pays the fee");
        assert!(
            wire.signatures[0].verify(owner.as_ref(), &wire.message),
            "the tool signed exactly these bytes with the owner key"
        );
    }
    let (vault_usdg, vault_wsol, owner_usdg, owner_wsol) = atas(&fx);
    // Each asset leg names only its own token accounts.
    for (wire, own, other) in [
        (
            &fx.usdg_leg,
            [vault_usdg, owner_usdg],
            [vault_wsol, owner_wsol],
        ),
        (
            &fx.wsol_leg,
            [vault_wsol, owner_wsol],
            [vault_usdg, owner_usdg],
        ),
    ] {
        for address in own {
            assert!(
                wire.parsed.account_keys.contains(&address),
                "TS and Rust derive the same ATA {address}"
            );
        }
        for address in other {
            assert!(
                !wire.parsed.account_keys.contains(&address),
                "a leg touches one asset only"
            );
        }
    }
    for address in [vault_usdg, vault_wsol, owner_usdg, owner_wsol] {
        assert!(
            !fx.sol.parsed.account_keys.contains(&address),
            "the SOL leg touches no token account"
        );
    }
    fx
}
fn atas(fx: &Fixture) -> (Pubkey, Pubkey, Pubkey, Pubkey) {
    (
        ata(&fx.vault, &USDG, &TOKEN_2022),
        ata(&fx.vault, &WSOL, &CLASSIC_TOKEN),
        ata(&fx.owner, &USDG, &TOKEN_2022),
        ata(&fx.owner, &WSOL, &CLASSIC_TOKEN),
    )
}

/// The chain the tool read when it built the fixture: a live vault built through the
/// program's own instructions (initialize, a session, custody ATAs), funded with minted
/// USDG, synced and unsynced native SOL in the WSOL account, and spare vault SOL.
async fn funded_chain(fx: &Fixture, issuer: &Keypair, freezable_usdg: bool) -> Chain {
    // The compiled program from BPF_OUT_DIR; Token, Token-2022 and ATA are ProgramTest's SBF builds.
    let mut pt = ProgramTest::new("merrymen_vault", vault::ID, None);
    pt.add_account(
        fx.owner,
        Account::new(1_000_000_000, 0, &anchor_lang::system_program::ID),
    );
    pt.add_account(USDG, usdg_mint(issuer.pubkey(), freezable_usdg));
    pt.add_account(WSOL, wsol_mint());
    let ctx = pt.start_with_context().await;
    let mut chain = Chain {
        ctx,
        owner: Keypair::new_from_array(fx.seed),
    };
    let now = chain
        .ctx
        .banks_client
        .get_sysvar::<Clock>()
        .await
        .unwrap()
        .unix_timestamp;
    let (vault_usdg, vault_wsol, _, _) = atas(fx);
    let payer = chain.ctx.payer.pubkey();
    let initialize = Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::InitializeVault {
            vault: fx.vault,
            owner: fx.owner,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: vault::instruction::InitializeVault {}.data(),
    };
    let create_session = Instruction {
        program_id: vault::ID,
        accounts: vault::accounts::OwnerAuthority {
            vault: fx.vault,
            owner: fx.owner,
        }
        .to_account_metas(None),
        data: vault::instruction::CreateSession {
            session: fx.session,
            per_trade: 25_000_000,
            daily: 100_000_000,
            per_trade_wsol: 1_000_000_000,
            daily_wsol: 4_000_000_000,
            max_ops: 20,
            expires_at: now + 86_400,
        }
        .data(),
    };
    let owner_signer = Keypair::new_from_array(fx.seed);
    chain
        .setup(&[initialize, create_session], &[&owner_signer])
        .await;
    chain
        .setup(
            &[
                create_associated_token_account_idempotent(&payer, &fx.vault, &USDG, &TOKEN_2022),
                create_associated_token_account_idempotent(
                    &payer,
                    &fx.vault,
                    &WSOL,
                    &CLASSIC_TOKEN,
                ),
            ],
            &[],
        )
        .await;
    chain
        .setup(
            &[
                spl_token_2022::instruction::mint_to(
                    &TOKEN_2022,
                    &USDG,
                    &vault_usdg,
                    &issuer.pubkey(),
                    &[],
                    fx.usdg,
                )
                .unwrap(),
                system_instruction::transfer(&payer, &vault_wsol, fx.synced),
                spl_token_2022::instruction::sync_native(&CLASSIC_TOKEN, &vault_wsol).unwrap(),
                system_instruction::transfer(&payer, &vault_wsol, fx.unsynced),
                system_instruction::transfer(&payer, &fx.vault, fx.excess),
            ],
            &[issuer],
        )
        .await;
    let rent = chain.ctx.banks_client.get_rent().await.unwrap();
    let vault_size = chain.account(fx.vault).await.unwrap().data.len();
    assert_eq!(vault_size, Vault::SPACE);
    assert_eq!(
        chain.lamports(fx.vault).await,
        rent.minimum_balance(vault_size) + fx.excess
    );
    assert_eq!(chain.token(vault_usdg).await.0, fx.usdg);
    assert_eq!(
        chain.token(vault_wsol).await,
        (
            fx.synced,
            rent.minimum_balance(TokenAccount::LEN) + fx.synced + fx.unsynced,
            TokenAccount::LEN
        )
    );
    assert_eq!(chain.vault_state(fx.vault).await.session, fx.session);
    chain
}
fn failed_at(result: Result<(), BanksClientError>) -> u8 {
    match result {
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(index, _))) => {
            index
        }
        other => panic!("expected an instruction error, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn owner_recovery_transactions_empty_the_vault_into_the_owner_wallet() {
    let fx = load();
    let issuer = Keypair::new();
    let mut chain = funded_chain(&fx, &issuer, false).await;
    let rent = chain.ctx.banks_client.get_rent().await.unwrap();
    let (vault_usdg, vault_wsol, owner_usdg, owner_wsol) = atas(&fx);
    let vault_reserve = rent.minimum_balance(Vault::SPACE);
    let wsol_reserve = rent.minimum_balance(TokenAccount::LEN);
    let owner_key = fx.owner;
    assert!(chain.account(owner_usdg).await.is_none() && chain.account(owner_wsol).await.is_none());
    // The fee of a message the owner alone signs, with no priority fee: what each step pays.
    let hash = chain.ctx.banks_client.get_latest_blockhash().await.unwrap();
    let fee = chain
        .ctx
        .banks_client
        .get_fee_for_message(Message::new_with_blockhash(&[], Some(&owner_key), &hash))
        .await
        .unwrap()
        .expect("a fee for a current blockhash");
    let owner_before = chain.lamports(owner_key).await;

    // Step 1: revoke_all alone.
    chain
        .run_fixture(&fx.revoke)
        .await
        .expect("revoke_all runs");
    let state = chain.vault_state(fx.vault).await;
    assert_eq!(state.session, Pubkey::default(), "no session can trade");
    assert!(state.paused);
    assert_eq!(state.expires_at, 0);
    assert_eq!(
        chain.token(vault_usdg).await.0,
        fx.usdg,
        "revoke moves nothing"
    );
    assert_eq!(chain.lamports(owner_key).await, owner_before - fee);

    // Step 2, SOL: withdraw_sol, so the spare SOL reaches the owner first.
    chain.run_fixture(&fx.sol).await.expect("the SOL leg runs");
    assert_eq!(
        chain.lamports(fx.vault).await,
        vault_reserve,
        "vault account at its rent reserve"
    );
    assert_eq!(
        chain.lamports(owner_key).await,
        owner_before - 2 * fee + fx.excess
    );
    // Step 2, USDG: the owner's Token-2022 account, then the USDG withdraw.
    chain
        .run_fixture(&fx.usdg_leg)
        .await
        .expect("the USDG leg runs");
    let (usdg_left, usdg_lamports, _) = chain.token(vault_usdg).await;
    assert_eq!(usdg_left, 0);
    assert_eq!(
        usdg_lamports,
        rent.minimum_balance(chain.account(vault_usdg).await.unwrap().data.len())
    );
    // Step 2, WSOL: the owner's WSOL account, SyncNative, then the WSOL withdraw.
    chain
        .run_fixture(&fx.wsol_leg)
        .await
        .expect("the WSOL leg runs");
    assert_eq!(
        chain.token(vault_wsol).await,
        (0, wsol_reserve, TokenAccount::LEN),
        "WSOL account at its reserve"
    );
    let (owner_usdg_amount, owner_usdg_rent, _) = chain.token(owner_usdg).await;
    let (owner_wsol_amount, owner_wsol_lamports, _) = chain.token(owner_wsol).await;
    assert_eq!(
        owner_usdg_amount, fx.usdg,
        "every USDG unit reached the owner"
    );
    assert_eq!(
        owner_wsol_amount,
        fx.synced + fx.unsynced,
        "every WSOL lamport, synced or not, reached the owner"
    );
    assert_eq!(owner_wsol_lamports, wsol_reserve + fx.synced + fx.unsynced);
    assert_eq!(
        chain.lamports(owner_key).await,
        owner_before - 4 * fee - owner_usdg_rent - wsol_reserve + fx.excess,
        "the owner paid four fees and two ATA reserves and received the spare SOL"
    );

    // A rerun of any leg cannot move more: each stale amount fails its own withdrawal.
    let owner_after = chain.lamports(owner_key).await;
    // withdraw_sol is the SOL leg's only instruction; the token legs' CreateIdempotent
    // (and SyncNative) are no-ops now, so they fail at their withdraw.
    for (wire, index) in [(&fx.sol, 0), (&fx.usdg_leg, 1), (&fx.wsol_leg, 2)] {
        assert_eq!(failed_at(chain.run_fixture(wire).await), index);
    }
    assert_eq!(chain.token(owner_usdg).await.0, fx.usdg);
    assert_eq!(chain.token(owner_wsol).await.0, fx.synced + fx.unsynced);
    assert_eq!(chain.token(vault_wsol).await.1, wsol_reserve);
    assert_eq!(chain.lamports(fx.vault).await, vault_reserve);
    assert_eq!(
        chain.lamports(owner_key).await,
        owner_after - 3 * fee,
        "only the fees are spent"
    );
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn a_blocked_asset_fails_alone_and_the_others_still_reach_the_owner() {
    let fx = load();
    let issuer = Keypair::new();
    let mut chain = funded_chain(&fx, &issuer, true).await;
    let rent = chain.ctx.banks_client.get_rent().await.unwrap();
    let (vault_usdg, vault_wsol, owner_usdg, owner_wsol) = atas(&fx);
    // The issuer froze the owner's USDG account after the tool read the chain.
    let payer = chain.ctx.payer.pubkey();
    chain
        .setup(
            &[
                create_associated_token_account_idempotent(&payer, &fx.owner, &USDG, &TOKEN_2022),
                spl_token_2022::instruction::freeze_account(
                    &TOKEN_2022,
                    &owner_usdg,
                    &USDG,
                    &issuer.pubkey(),
                    &[],
                )
                .unwrap(),
            ],
            &[&issuer],
        )
        .await;

    chain
        .run_fixture(&fx.revoke)
        .await
        .expect("revoke_all runs");
    chain.run_fixture(&fx.sol).await.expect("the SOL leg runs");
    // CreateIdempotent passes on the existing account; the transfer into it is refused.
    assert_eq!(failed_at(chain.run_fixture(&fx.usdg_leg).await), 1);
    chain
        .run_fixture(&fx.wsol_leg)
        .await
        .expect("the WSOL leg runs after the USDG leg failed");

    assert_eq!(
        chain.token(vault_usdg).await.0,
        fx.usdg,
        "the blocked USDG stays in the vault, intact"
    );
    assert_eq!(chain.token(owner_usdg).await.0, 0);
    assert_eq!(
        chain.token(vault_wsol).await,
        (
            0,
            rent.minimum_balance(TokenAccount::LEN),
            TokenAccount::LEN
        )
    );
    assert_eq!(chain.token(owner_wsol).await.0, fx.synced + fx.unsynced);
    assert_eq!(
        chain.lamports(fx.vault).await,
        rent.minimum_balance(Vault::SPACE)
    );
}
