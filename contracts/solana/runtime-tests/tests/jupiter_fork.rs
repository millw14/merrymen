//! Fork test: the compiled custody program's `execute_swap` runs a real Jupiter v6
//! `sharedAccountsRoute` (USDG -> WSOL, one Orca Whirlpool hop) against the mainnet
//! binaries of Jupiter v6, Whirlpool, SPL Token, Token-2022 and the ATA program, and the
//! route's mainnet accounts read at one slot. Nothing here reaches a network.
//!
//! fixtures/jupiter/ holds, each with its source URL, slot and UTC time:
//! - route.json: one Jupiter /swap/v1 quote and swap-instructions answer, asked for this
//!   test vault's seq-0 swap authority and WSOL ATA (OWNER_SEED below) under the vault
//!   program its provenance names (builtFor), with the executor's parameters
//!   (worker/src/solana-live-market.ts) plus onlyDirectRoutes. The test moves those vault
//!   accounts to this build's program ID (Answer::rebind), so a new declare_id needs no
//!   new answer;
//! - accounts.json: every account that instruction names (mints, Jupiter's shared token
//!   accounts and authorities, the pool, its vaults, tick arrays and oracle, the lookup
//!   table), from one getMultipleAccounts at one slot, and that slot's block time;
//! - programs.json and *.so: the program ELFs without their on-chain zero padding. The
//!   test pads each back and checks the sha256 of the on-chain bytes before loading it.
//!   NOTICE.md names each program's source and licence status. Only the SPL copies are
//!   committed: jupiter_v6.so and whirlpool.so are supplied out of band (in the directory
//!   MERRYMEN_JUPITER_FORK_PROGRAMS names, or placed here), and test.sh skips this target
//!   without them;
//! - refresh.mjs: the read-only fetch and the offline build that write these files.
//!
//! What it holds, at the recorded slot and clock:
//! - compute: the executor's budget (worker/src/solana-executor.ts): simulate at 1.4M,
//!   then sign min(1.4M, ceil(units * 1.2)); the signed swap must succeed at that limit,
//!   and stay under COMPUTE_CEILING;
//! - accounts: the vault's 64 remaining accounts, a 64-account lock limit (the runtime's
//!   limit without increase_tx_account_lock_limit) and the 1232-byte packet, with the
//!   route's lookup table compressing the message as the executor does, and the distinct
//!   accounts the vault adds to the route's own (VAULT_ACCOUNTS, one more with a refund),
//!   which bound how many distinct accounts a route can name;
//! - CPI depth and trace: the deepest invocation must leave a level free under the
//!   runtime's 5 (here Token, Token-2022 and Memo under Whirlpool under Jupiter under the
//!   vault: level 4, one deeper than a top-level Jupiter swap), and the transaction's
//!   instructions, top-level and CPIs together, must stay within its trace of 64;
//! - route size: the recorded leg split two and three ways through the same pool, each
//!   further leg's units under LEG_CEILING, and a fourth leg refused by the vault's 64
//!   route accounts before Jupiter is invoked;
//! - custody: the owner's caps before the route, the output check after it, nothing left
//!   in the temporary account or Jupiter's shared accounts, a waiting donation refunded
//!   to the owner, and the SwapExecuted record.
//!
//! Limits of this evidence. One direct route through one pool at one slot. The split
//! routes repeat its leg through the same pool: they measure what each further leg costs,
//! not a multi-hop route through other pools or AMMs, whose distinct accounts, compute and
//! CPI depth stay unmeasured here. Only the buy is Jupiter's answer. The exit is
//! derived from it (same pool and accounts, direction flag flipped, the seller's own
//! accounts in place of the buyer's, the quote taken from a simulation of that swap):
//! it exercises the vault's sell path through the real programs, not Jupiter's routing.
//! The vault's return of leftover input after the route never runs here: an ExactIn
//! sharedAccountsRoute spends exactly its input, which check_route holds equal to
//! amount_in, so these tests show only that nothing is left and the temporary account
//! closes; custody.rs covers a non-zero return with a mock route that leaves dust
//! (donations_and_route_dust_return_to_custody_without_resetting_budget). The runtime is
//! agave 2.3.13's solana-program-test with every feature of that release active and the
//! programs' deploy slot written as 0, and the lock limit is the conservative 64; the RPC
//! node that served the accounts reported apiVersion 4.3.2 (accounts.json provenance), so
//! mainnet's compute costs, CPI limits and lock limit can differ from these numbers. On
//! mainnet the executor's own simulation (signed at ceil(units * 1.2)) sets the compute
//! limit, and the release gate's owner-authorized acceptance canary covers live fills.
//! Run with --nocapture to see the measured compute units and account counts.
use anchor_lang::prelude::*;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::spl_associated_token_account::{
    get_associated_token_address_with_program_id as ata,
    instruction::create_associated_token_account_idempotent,
};
use anchor_spl::token_2022::spl_token_2022::{
    self, extension::StateWithExtensions, state::Account as TokenAccount,
};
use base64::Engine;
use merrymen_vault::{self as vault, Vault, JUPITER, SHARED_ROUTE, USDG, WSOL};
use solana_program_test::{ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    hash::hashv,
    instruction::{AccountMeta, Instruction, InstructionError},
    message::{v0, AddressLookupTableAccount, VersionedMessage},
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError, VersionedTransaction},
};
use std::collections::BTreeMap;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/jupiter");
/// The test owner. route.json was asked for this owner's vault (seq 0 swap authority, its
/// temporary USDG ATA and the vault's WSOL ATA) under the vault program its provenance
/// names; Answer::read checks that it still is.
const OWNER_SEED: [u8; 32] = *b"merrymen jupiter fork test owner";
/// The route accounts that hold the vault's own addresses for a buy: the swap authority
/// (the route's only signer), its temporary USDG ATA and the vault's WSOL ATA, which
/// check_route_accounts pins to execute_swap's own accounts.
const VAULT_SLOTS: [usize; 3] = [2, 3, 6];
const TOKEN: Pubkey = anchor_spl::token::ID;
const TOKEN_2022: Pubkey = spl_token_2022::ID;
const LOADER_V3: Pubkey = solana_sdk::bpf_loader_upgradeable::ID;
const LOADER_V2: Pubkey = solana_sdk::bpf_loader::ID;
const WHIRLPOOL: &str = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
/// The executor's simulation limit and its signed headroom (solana-executor.ts).
const EXECUTOR_MAX_UNITS: u64 = 1_400_000;
/// Fails a change that makes this one-hop swap much dearer; the executor's own bound
/// (simulated * 1.2 <= 1.4M) is checked separately. Measured when committed: 162,314
/// units for the buy, 154,593 for the exit, 149,929 for the buy with a refund (with
/// solana-program-test's older bundled SPL Token, Token-2022 and ATA programs instead:
/// 173,843, 181,892 and 161,922).
const COMPUTE_CEILING: u64 = 250_000;
const LOCK_LIMIT: usize = 64;
/// agave 2.3.13 (solana-program-runtime execution_budget.rs): a top-level instruction is
/// level 1 and a CPI from level 5 fails with CallDepth; a transaction's instruction trace
/// (top-level instructions and every CPI) holds at most 64.
const STACK_DEPTH_LIMIT: usize = 5;
const TRACE_LIMIT: usize = 64;
const PACKET_DATA_SIZE: usize = 1232;
const ROUTE_ACCOUNT_LIMIT: usize = 64;
/// sharedAccountsRoute's own accounts, before the first leg's AMM program, and one
/// Whirlpool leg: the Whirlpool program and its 15 accounts.
const JUPITER_FIXED: usize = 13;
const WHIRLPOOL_LEG: usize = 16;
/// The distinct accounts execute_swap's transaction adds to the route's own: the vault,
/// the session, the fee payer, the vault's input ATA, the ATA and system programs, the
/// vault program and the compute budget program. The owner's refund ATA, passed only
/// when a donation waits, makes it one more. The rest of execute_swap's accounts (mints,
/// output ATA, swap authority, temporary ATA, token programs, Jupiter) are route
/// accounts too. A route can therefore name at most ROUTE_DISTINCT_LIMIT distinct
/// accounts and still fit every swap the executor signs.
const VAULT_ACCOUNTS: usize = 8;
/// LOCK_LIMIT less VAULT_ACCOUNTS and the refund account: 55.
const ROUTE_DISTINCT_LIMIT: usize = LOCK_LIMIT - VAULT_ACCOUNTS - 1;
/// Fails a change that makes each further Whirlpool leg much dearer. Measured when
/// committed: 76,735 units for each of the second and third legs, of which about 15,870
/// are the vault's own work on the leg's 16 more route accounts.
const LEG_CEILING: u64 = 120_000;
/// The vault's error codes (VaultError, from 6000). Jupiter's own errors use the same
/// range, so every refusal below also checks whether Jupiter ran.
const RISK_LIMIT: u32 = 6002;
const AMOUNT: u32 = 6003;
const ROUTE: u32 = 6008;
/// In every swap transaction: compute limit, compute price, then the swap.
const SWAP_INDEX: u8 = 2;
/// One USDG, the recorded quote's input.
const BUY_IN: u64 = 1_000_000;
/// The derived exit's WSOL input: about half of what the buy receives.
const SELL_IN: u64 = 5_000_000;

fn json(name: &str) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(format!("{DIR}/{name}")).unwrap()).unwrap()
}
fn key(v: &serde_json::Value) -> Pubkey {
    v.as_str().unwrap().parse().unwrap()
}
fn number(v: &serde_json::Value) -> u64 {
    v.as_str()
        .map_or_else(|| v.as_u64().unwrap(), |s| s.parse().unwrap())
}
fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn vault_address(program: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"vault", owner.as_ref()], program).0
}
fn swap_authority_under(program: &Pubkey, vault: &Pubkey, seq: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"swap", vault.as_ref(), &seq.to_le_bytes()], program).0
}
fn swap_authority(vault: &Pubkey, seq: u64) -> Pubkey {
    swap_authority_under(&vault::ID, vault, seq)
}
/// The addresses at VAULT_SLOTS for a buy by `owner`'s vault under `program` at `seq`.
fn buy_slots(program: &Pubkey, owner: &Pubkey, seq: u64) -> [Pubkey; 3] {
    let vault = vault_address(program, owner);
    let swap = swap_authority_under(program, &vault, seq);
    [
        swap,
        ata(&swap, &USDG, &TOKEN_2022),
        ata(&vault, &WSOL, &TOKEN),
    ]
}
fn custom(err: &TransactionError) -> Option<(u8, u32)> {
    match err {
        TransactionError::InstructionError(i, InstructionError::Custom(code)) => Some((*i, *code)),
        _ => None,
    }
}
fn recorded_account(pubkey: &Pubkey) -> Vec<u8> {
    json("accounts.json")["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| key(&a["pubkey"]) == *pubkey)
        .map(|a| b64(a["data"].as_str().unwrap()))
        .unwrap_or_else(|| panic!("{pubkey} is recorded"))
}

/// The directory the program ELFs are read from: PROGRAMS_ENV's, when set, or this one.
/// programs.json (always this directory's) pins their bytes either way, so the setting
/// changes where the copies live, never what runs (NOTICE.md).
const PROGRAMS_ENV: &str = "MERRYMEN_JUPITER_FORK_PROGRAMS";
fn elf_dir() -> String {
    std::env::var(PROGRAMS_ENV)
        .ok()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| DIR.to_string())
}
/// One programs.json entry's ELF from `dir`, padded back to its on-chain length: the file
/// must be the recorded one and the padded bytes the on-chain program. A missing or
/// different file is an error, never a skip.
fn program_elf(dir: &str, p: &serde_json::Value) -> std::result::Result<Vec<u8>, String> {
    let path = format!(
        "{dir}/{}",
        p["file"].as_str().ok_or("an entry with no file")?
    );
    let mut elf = std::fs::read(&path).map_err(|e| {
        format!("{path}: {e}; refresh.mjs fetch and build --elf-out write it ({PROGRAMS_ENV})")
    })?;
    if hex(hashv(&[&elf]).as_ref()) != p["sha256File"].as_str().unwrap_or_default() {
        return Err(format!("{path} is not the recorded file (sha256File)"));
    }
    let len = number(&p["onChainLen"]) as usize;
    if elf.len() > len {
        return Err(format!("{path} is longer than the on-chain program"));
    }
    elf.resize(len, 0);
    if hex(hashv(&[&elf]).as_ref()) != p["sha256OnChain"].as_str().unwrap_or_default() {
        return Err(format!("{path}: the fixture is not the on-chain program"));
    }
    Ok(elf)
}

/// Mainnet programs: the ELF padded back to its on-chain length, checked against the
/// recorded sha256, as a loader-v3 program and programdata pair or a loader-v2 program.
fn add_programs(pt: &mut ProgramTest, fork_slot: u64) -> usize {
    let programs = json("programs.json");
    let dir = elf_dir();
    let mut loaded = 0;
    for p in programs["programs"].as_array().unwrap() {
        let id = key(&p["program"]);
        let elf = program_elf(&dir, p).unwrap_or_else(|e| panic!("{id}: {e}"));
        let loader = key(&p["loader"]);
        if loader == LOADER_V2 {
            pt.add_account(
                id,
                Account {
                    lamports: Rent::default().minimum_balance(elf.len()),
                    data: elf,
                    owner: LOADER_V2,
                    executable: true,
                    rent_epoch: u64::MAX,
                },
            );
        } else {
            assert_eq!(loader, LOADER_V3);
            let programdata = key(&p["programdata"]);
            assert!(
                number(&p["deploySlot"]) < fork_slot,
                "{id} deployed after the fork slot"
            );
            // UpgradeableLoaderState::ProgramData: tag 3, deploy slot, Option<authority>.
            // The deploy slot written is 0, not mainnet's: the test bank's program cache
            // treats a program as deployed only at a slot its own fork graph knows (or at
            // or below its root, which stays 0), and a program never reads this field.
            let mut data = vec![3, 0, 0, 0];
            data.extend_from_slice(&0u64.to_le_bytes());
            match p["upgradeAuthority"].as_str() {
                Some(a) => {
                    data.push(1);
                    data.extend_from_slice(a.parse::<Pubkey>().unwrap().as_ref());
                }
                None => data.extend_from_slice(&[0; 33]),
            }
            data.extend_from_slice(&elf);
            pt.add_account(
                programdata,
                Account {
                    lamports: Rent::default().minimum_balance(data.len()),
                    data,
                    owner: LOADER_V3,
                    executable: false,
                    rent_epoch: u64::MAX,
                },
            );
            // The program account itself is in accounts.json; it must point here.
            let program = recorded_account(&id);
            assert_eq!(program[..4], [2, 0, 0, 0]);
            assert_eq!(program[4..36], programdata.to_bytes());
        }
        loaded += 1;
    }
    loaded
}

/// Jupiter's answer as route.json records it, and what it was asked for.
#[derive(Clone)]
struct Answer {
    metas: Vec<AccountMeta>,
    data: Vec<u8>,
    alt: AddressLookupTableAccount,
    /// The vault program and owner whose seq-0 addresses the answer names at VAULT_SLOTS.
    built_for: Pubkey,
    owner: Pubkey,
    /// accounts.json's accounts, which never include a vault address.
    dumped: Vec<Pubkey>,
}
impl Answer {
    fn read() -> Self {
        let route = json("route.json");
        let built = &route["swapInstructions"];
        let ix = &built["swapInstruction"];
        assert_eq!(key(&ix["programId"]), JUPITER);
        let metas = ix["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| AccountMeta {
                pubkey: key(&a["pubkey"]),
                is_signer: a["isSigner"].as_bool().unwrap(),
                is_writable: a["isWritable"].as_bool().unwrap(),
            })
            .collect();
        let tables = built["addressLookupTableAddresses"].as_array().unwrap();
        assert_eq!(tables.len(), 1, "the recorded route uses one lookup table");
        let table = key(&tables[0]);
        let raw = recorded_account(&table);
        // LookupTableMeta: type 1 (lookup table), deactivation slot u64::MAX (active);
        // the addresses start at byte 56.
        assert_eq!(raw[..4], [1, 0, 0, 0]);
        assert_eq!(u64::from_le_bytes(raw[4..12].try_into().unwrap()), u64::MAX);
        let addresses = raw[56..]
            .chunks(32)
            .map(|c| Pubkey::new_from_array(c.try_into().unwrap()))
            .collect();
        // provenance.builtFor (refresh.mjs): the vault program and owner seed the answer
        // was asked for, and the addresses it derived from them.
        let b = &route["provenance"]["builtFor"];
        assert_eq!(
            b["ownerSeed"].as_str().map(str::as_bytes),
            Some(&OWNER_SEED[..]),
            "route.json was asked for another owner"
        );
        assert_eq!(b["seq"].as_u64(), Some(0));
        let owner = Keypair::new_from_array(OWNER_SEED).pubkey();
        let built_for = key(&b["vaultProgram"]);
        let [swap, input, output] = buy_slots(&built_for, &owner, 0);
        assert_eq!(
            [
                key(&b["owner"]),
                key(&b["vault"]),
                key(&b["swapAuthority"]),
                key(&b["inputAccount"]),
                key(&b["outputAccount"])
            ],
            [
                owner,
                vault_address(&built_for, &owner),
                swap,
                input,
                output
            ],
            "route.json's builtFor is not derived from its vault program and owner seed"
        );
        let dumped = json("accounts.json")["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| key(&a["pubkey"]))
            .collect();
        Self {
            metas,
            data: b64(ix["data"].as_str().unwrap()),
            alt: AddressLookupTableAccount {
                key: table,
                addresses,
            },
            built_for,
            owner,
            dumped,
        }
    }
    /// The answer for the same owner's vault under `program`. VAULT_SLOTS must hold the
    /// seq-0 addresses under `built_for` (the answer is Jupiter's for that vault), and
    /// neither those nor `program`'s may appear anywhere else: in another account, the
    /// instruction data, the lookup table or accounts.json. Only those three accounts
    /// change; nothing else in Jupiter's answer depends on the vault.
    fn rebind(&self, program: &Pubkey) -> std::result::Result<Vec<AccountMeta>, String> {
        let asked = buy_slots(&self.built_for, &self.owner, 0);
        let moved = buy_slots(program, &self.owner, 0);
        if self.metas.len() <= VAULT_SLOTS[2] {
            return Err(format!("{} route accounts", self.metas.len()));
        }
        for (slot, k) in VAULT_SLOTS.iter().zip(&asked) {
            let found = self.metas[*slot].pubkey;
            if found != *k {
                return Err(format!(
                    "account {slot} is {found}, not {k}: the answer was not asked for the vault \
                     under {}",
                    self.built_for
                ));
            }
        }
        for k in asked.iter().chain(&moved) {
            let elsewhere = self
                .metas
                .iter()
                .enumerate()
                .find(|(i, m)| !VAULT_SLOTS.contains(i) && m.pubkey == *k);
            if let Some((i, _)) = elsewhere {
                return Err(format!("vault address {k} is also account {i}"));
            }
            if self.data.windows(32).any(|w| w == k.as_ref()) {
                return Err(format!("vault address {k} is in the instruction data"));
            }
            if self.alt.addresses.contains(k) {
                return Err(format!("vault address {k} is in the lookup table"));
            }
            if self.dumped.contains(k) {
                return Err(format!("vault address {k} is in accounts.json"));
            }
        }
        let mut metas = self.metas.clone();
        for (slot, k) in VAULT_SLOTS.iter().zip(moved) {
            metas[*slot].pubkey = k;
        }
        Ok(metas)
    }
}

/// The route as Jupiter answered it, moved to this build's vault, and the quote it was
/// built from.
struct Recorded {
    metas: Vec<AccountMeta>,
    data: Vec<u8>,
    alt: AddressLookupTableAccount,
    in_amount: u64,
    out_amount: u64,
    threshold: u64,
    slippage: u16,
}
fn recorded() -> Recorded {
    let route = json("route.json");
    let quote = &route["quote"];
    let answer = Answer::read();
    let metas = answer
        .rebind(&vault::ID)
        .unwrap_or_else(|e| panic!("route.json: {e}"));
    Recorded {
        metas,
        data: answer.data,
        alt: answer.alt,
        in_amount: number(&quote["inAmount"]),
        out_amount: number(&quote["outAmount"]),
        threshold: number(&quote["otherAmountThreshold"]),
        slippage: quote["slippageBps"].as_u64().unwrap() as u16,
    }
}

/// What one swap transaction cost and carried.
#[derive(Debug, Default)]
struct Measured {
    /// Units the 1.4M simulation consumed, and the limit the executor then signs.
    simulated: u64,
    limit: u64,
    /// Units the signed transaction consumed at `limit`.
    consumed: u64,
    /// Units of each outermost invocation: the vault (everything under it), Jupiter
    /// (with its AMM legs) and Whirlpool (every leg).
    vault: u64,
    jupiter: u64,
    whirlpool: u64,
    loaded_data: u32,
    wire_bytes: usize,
    static_keys: usize,
    lookup_writable: usize,
    lookup_readonly: usize,
    route_accounts: usize,
    /// Distinct accounts among the route's.
    route_distinct: usize,
    instruction_accounts: usize,
    /// The deepest "invoke [n]" and the number of invocations: the instruction trace.
    max_depth: usize,
    trace: usize,
}
impl Measured {
    fn total_accounts(&self) -> usize {
        self.static_keys + self.lookup_writable + self.lookup_readonly
    }
    /// Distinct accounts the transaction holds beyond the route's own.
    fn vault_accounts(&self) -> usize {
        self.total_accounts() - self.route_distinct
    }
    fn report(&self, label: &str) {
        println!("{}", self.summary(label));
    }
    /// The bound printed is ROUTE_DISTINCT_LIMIT, which holds with or without a refund
    /// account, not this transaction's own headroom.
    fn summary(&self, label: &str) -> String {
        format!(
            "{label}: simulated {} CU, signed limit {}, consumed {} (vault with its own token \
             CPIs {}, Jupiter {} of which Whirlpool {}); loaded account data {} bytes; {} of \
             {} wire bytes; {} accounts ({} static, {} writable + {} readonly from the lookup \
             table) of a {} lock limit; {} route accounts of the vault's {}; {} accounts on \
             the swap instruction; the route names {} distinct accounts and the vault adds \
             {} here, so a route can name at most {} distinct accounts in every swap the \
             executor signs ({} less the vault's {} and a refund account); deepest \
             invocation level {} of {}; {} instructions of a {} trace",
            self.simulated,
            self.limit,
            self.consumed,
            self.vault - self.jupiter,
            self.jupiter,
            self.whirlpool,
            self.loaded_data,
            self.wire_bytes,
            PACKET_DATA_SIZE,
            self.total_accounts(),
            self.static_keys,
            self.lookup_writable,
            self.lookup_readonly,
            LOCK_LIMIT,
            self.route_accounts,
            ROUTE_ACCOUNT_LIMIT,
            self.instruction_accounts,
            self.route_distinct,
            self.vault_accounts(),
            ROUTE_DISTINCT_LIMIT,
            LOCK_LIMIT,
            VAULT_ACCOUNTS,
            self.max_depth,
            STACK_DEPTH_LIMIT,
            self.trace,
            TRACE_LIMIT,
        )
    }
    /// Units per program from the "invoke [depth]" / "consumed N of M" log lines, the
    /// deepest invocation and the number of invocations.
    fn programs(&mut self, logs: &[String]) {
        assert!(
            !logs.iter().any(|l| l == "Log truncated"),
            "the logs are whole"
        );
        let mut depth = 0;
        for line in logs {
            let Some(rest) = line.strip_prefix("Program ") else {
                continue;
            };
            let words: Vec<&str> = rest.split_whitespace().collect();
            match words.as_slice() {
                [_, "invoke", level] => {
                    depth = level
                        .strip_prefix('[')
                        .and_then(|l| l.strip_suffix(']'))
                        .and_then(|l| l.parse().ok())
                        .expect("invoke [n]");
                    self.max_depth = self.max_depth.max(depth);
                    self.trace += 1;
                }
                [id, "consumed", n, "of", _, "compute", "units"] => {
                    let n: u64 = n.parse().unwrap();
                    match depth {
                        1 if *id == vault::ID.to_string() => self.vault = n,
                        2 if *id == JUPITER.to_string() => self.jupiter = n,
                        3 if *id == WHIRLPOOL => self.whirlpool += n,
                        _ => {}
                    }
                }
                [_, "success"] | [_, "failed:", ..] => depth -= 1,
                _ => {}
            }
        }
    }
}

struct Caps {
    per_trade: u64,
    daily: u64,
    per_trade_wsol: u64,
    daily_wsol: u64,
}
const CAPS: Caps = Caps {
    per_trade: BUY_IN,
    daily: 1_600_000,
    per_trade_wsol: SELL_IN,
    daily_wsol: SELL_IN,
};

struct Fork {
    ctx: ProgramTestContext,
    owner: Keypair,
    session: Keypair,
    vault: Pubkey,
    vault_usdg: Pubkey,
    vault_wsol: Pubkey,
    route: Recorded,
    now: i64,
    epoch: u64,
    logs: Vec<String>,
}
impl Fork {
    async fn new(caps: Caps, usdg: u64) -> Self {
        let owner = Keypair::new_from_array(OWNER_SEED);
        let session = Keypair::new();
        let vault =
            Pubkey::find_program_address(&[b"vault", owner.pubkey().as_ref()], &vault::ID).0;
        let vault_usdg = ata(&vault, &USDG, &TOKEN_2022);
        let vault_wsol = ata(&vault, &WSOL, &TOKEN);
        let route = recorded();
        let swap = swap_authority(&vault, 0);
        // The recorded answer, moved to this build's vault: its swap authority signs, the
        // temporary USDG ATA pays in and the vault's WSOL ATA receives, as the executor asks.
        let m = &route.metas;
        assert_eq!(m[2].pubkey, swap);
        assert_eq!(m[3].pubkey, ata(&swap, &USDG, &TOKEN_2022));
        assert_eq!(m[6].pubkey, vault_wsol);
        assert!(m.iter().enumerate().all(|(i, a)| a.is_signer == (i == 2)));
        assert_eq!(
            (m[7].pubkey, m[8].pubkey, m[9].pubkey),
            (USDG, WSOL, JUPITER)
        );
        // SPL Token at 0 although the input is Token-2022 USDG; Token-2022 at 10.
        assert_eq!((m[0].pubkey, m[10].pubkey), (TOKEN, TOKEN_2022));
        assert_eq!(m[13].pubkey.to_string(), WHIRLPOOL);
        let d = &route.data;
        let n = d.len();
        assert_eq!(d[..8], SHARED_ROUTE);
        assert_eq!(
            u64::from_le_bytes(d[n - 19..n - 11].try_into().unwrap()),
            route.in_amount
        );
        assert_eq!(
            u64::from_le_bytes(d[n - 11..n - 3].try_into().unwrap()),
            route.out_amount
        );
        assert_eq!(
            u16::from_le_bytes(d[n - 3..n - 1].try_into().unwrap()),
            route.slippage
        );
        assert_eq!((route.in_amount, d[n - 1]), (BUY_IN, 0));

        let mut pt = ProgramTest::default();
        // BPF_OUT_DIR (test.sh) supplies the compiled custody program.
        pt.add_program("merrymen_vault", vault::ID, None);
        pt.set_transaction_account_lock_limit(LOCK_LIMIT);
        let accounts = json("accounts.json");
        let fork_slot = number(&accounts["provenance"]["slot"]);
        assert_eq!(add_programs(&mut pt, fork_slot), 5);
        for a in accounts["accounts"].as_array().unwrap() {
            pt.add_account(
                key(&a["pubkey"]),
                Account {
                    lamports: number(&a["lamports"]),
                    data: b64(a["data"].as_str().unwrap()),
                    owner: key(&a["owner"]),
                    executable: a["executable"].as_bool().unwrap(),
                    rent_epoch: number(&a["rentEpoch"]),
                },
            );
        }
        for k in [owner.pubkey(), session.pubkey()] {
            pt.add_account(
                k,
                Account {
                    lamports: 100_000_000,
                    data: vec![],
                    owner: anchor_lang::system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            );
        }
        let mut ctx = pt.start_with_context().await;
        // The recorded slot and its block time: lookup-table entries extended before it are
        // live, programs deployed before it are visible, and Whirlpool's clock checks hold.
        ctx.warp_to_slot(fork_slot + 1).unwrap();
        let mut clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
        clock.unix_timestamp = accounts["provenance"]["blockTime"].as_i64().unwrap();
        ctx.set_sysvar(&clock);
        let now = clock.unix_timestamp;
        let mut f = Self {
            ctx,
            owner,
            session,
            vault,
            vault_usdg,
            vault_wsol,
            route,
            now,
            epoch: 0,
            logs: Vec::new(),
        };
        let init = Instruction {
            program_id: vault::ID,
            accounts: vault::accounts::InitializeVault {
                vault,
                owner: f.owner.pubkey(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: vault::instruction::InitializeVault {}.data(),
        };
        let payer = f.ctx.payer.pubkey();
        let open = [
            create_associated_token_account_idempotent(&payer, &vault, &USDG, &TOKEN_2022),
            create_associated_token_account_idempotent(&payer, &vault, &WSOL, &TOKEN),
            create_associated_token_account_idempotent(
                &payer,
                &f.owner.pubkey(),
                &USDG,
                &TOKEN_2022,
            ),
        ];
        let owner = f.owner.insecure_clone();
        f.legacy(&[init], &[&owner]).await;
        f.set_caps(caps).await;
        f.legacy(&open, &[]).await;
        // The owner's deposit: USDG cannot be minted here, so the vault's ATA (opened above
        // by the mainnet ATA and Token-2022 programs) is credited directly.
        f.set_token_amount(vault_usdg, usdg).await;
        f
    }
    async fn legacy(&mut self, ixs: &[Instruction], signers: &[&Keypair]) {
        let hash = self.ctx.get_new_latest_blockhash().await.unwrap();
        let mut all = vec![&self.ctx.payer];
        all.extend_from_slice(signers);
        let tx =
            Transaction::new_signed_with_payer(ixs, Some(&self.ctx.payer.pubkey()), &all, hash);
        self.ctx.banks_client.process_transaction(tx).await.unwrap();
    }
    /// A new owner-signed session with these caps (the session epoch moves on).
    async fn set_caps(&mut self, caps: Caps) {
        let ix = Instruction {
            program_id: vault::ID,
            accounts: vault::accounts::OwnerAuthority {
                vault: self.vault,
                owner: self.owner.pubkey(),
            }
            .to_account_metas(None),
            data: vault::instruction::CreateSession {
                session: self.session.pubkey(),
                per_trade: caps.per_trade,
                daily: caps.daily,
                per_trade_wsol: caps.per_trade_wsol,
                daily_wsol: caps.daily_wsol,
                max_ops: 10,
                expires_at: self.now + vault::risk::DAY,
            }
            .data(),
        };
        let owner = self.owner.insecure_clone();
        self.legacy(&[ix], &[&owner]).await;
        self.epoch += 1;
    }
    async fn account(&mut self, k: Pubkey) -> Option<Account> {
        self.ctx.banks_client.get_account(k).await.unwrap()
    }
    async fn balance(&mut self, k: Pubkey) -> u64 {
        let a = self.account(k).await.expect("token account exists");
        StateWithExtensions::<TokenAccount>::unpack(&a.data)
            .unwrap()
            .base
            .amount
    }
    async fn set_token_amount(&mut self, k: Pubkey, amount: u64) {
        let mut a = self.account(k).await.unwrap();
        a.data[64..72].copy_from_slice(&amount.to_le_bytes());
        self.ctx.set_account(&k, &a.into());
    }
    async fn state(&mut self) -> Vault {
        let a = self.account(self.vault).await.unwrap();
        Vault::try_deserialize(&mut a.data.as_slice()).unwrap()
    }
    /// The recorded route for the swap at `seq`: Jupiter's answer with the swap authority
    /// and temporary ATA of that sequence, which is all a later answer would change.
    fn buy_route(&self, seq: u64) -> (Vec<AccountMeta>, Vec<u8>) {
        let mut metas = self.route.metas.clone();
        let swap = swap_authority(&self.vault, seq);
        metas[2].pubkey = swap;
        metas[3].pubkey = ata(&swap, &USDG, &TOKEN_2022);
        (metas, self.route.data.clone())
    }
    /// The exit derived from the recorded route: the same pool, Jupiter accounts and leg
    /// with a_to_b set (Whirlpool mint A is WSOL), Jupiter's shared WSOL account as the
    /// program source and its USDG account as the destination, and the seller's swap
    /// authority, temporary WSOL ATA and the vault's USDG ATA. The swap stays inside the
    /// current tick array, which the leg passes three times.
    fn sell_route(
        &self,
        seq: u64,
        amount: u64,
        quote: u64,
        bps: u16,
    ) -> (Vec<AccountMeta>, Vec<u8>) {
        let mut metas = self.route.metas.clone();
        let swap = swap_authority(&self.vault, seq);
        let recorded = &self.route.metas;
        metas[2].pubkey = swap;
        metas[3].pubkey = ata(&swap, &WSOL, &TOKEN);
        metas[4].pubkey = recorded[5].pubkey;
        metas[5].pubkey = recorded[4].pubkey;
        metas[6].pubkey = self.vault_usdg;
        metas[7].pubkey = WSOL;
        metas[8].pubkey = USDG;
        metas[26].pubkey = metas[25].pubkey;
        metas[27].pubkey = metas[25].pubkey;
        let mut data = self.route.data.clone();
        // disc 8, id 1, steps u32, WhirlpoolSwapV2 (47) { a_to_b, remaining_accounts_info: None }.
        assert_eq!((data[13], data[14], data[15]), (47, 0, 0));
        data[14] = 1;
        let n = data.len();
        data[n - 19..n - 11].copy_from_slice(&amount.to_le_bytes());
        data[n - 11..n - 3].copy_from_slice(&quote.to_le_bytes());
        data[n - 3..n - 1].copy_from_slice(&bps.to_le_bytes());
        (metas, data)
    }
    /// The recorded buy split into `percents.len()` legs through the same pool: Jupiter's
    /// fixed 13 accounts, then the leg (the Whirlpool program and its 15 accounts) once per
    /// step, and one WhirlpoolSwapV2 step per leg with that percent.
    fn split_route(
        &self,
        seq: u64,
        percents: &[u8],
        quote: u64,
        bps: u16,
    ) -> (Vec<AccountMeta>, Vec<u8>) {
        let (mut metas, recorded) = self.buy_route(seq);
        let leg = metas[JUPITER_FIXED..].to_vec();
        for _ in 1..percents.len() {
            metas.extend_from_slice(&leg);
        }
        // disc 8, id 1, steps u32, then per step: WhirlpoolSwapV2 (47) { a_to_b, None },
        // percent, input index, output index; then the 19-byte tail check_route reads.
        let step = &recorded[13..19];
        assert_eq!((step[0], step[3], step[4], step[5]), (47, 100, 0, 1));
        let mut data = recorded[..9].to_vec();
        data.extend_from_slice(&(percents.len() as u32).to_le_bytes());
        for p in percents {
            data.extend_from_slice(&step[..3]);
            data.extend_from_slice(&[*p, 0, 1]);
        }
        data.extend_from_slice(&recorded[19..]);
        let n = data.len();
        data[n - 11..n - 3].copy_from_slice(&quote.to_le_bytes());
        data[n - 3..n - 1].copy_from_slice(&bps.to_le_bytes());
        (metas, data)
    }
    /// execute_swap as the executor builds it (packages/core/src/solana-live.ts): the
    /// fixed accounts, then every route account as a non-signer, writable as Jupiter said.
    #[allow(clippy::too_many_arguments)]
    fn swap_ix(
        &self,
        seq: u64,
        buy: bool,
        route: (Vec<AccountMeta>, Vec<u8>),
        amount_in: u64,
        min_out: u64,
        slippage_bps: u16,
        refund: bool,
    ) -> Instruction {
        let ((input_mint, input_program), (output_mint, output_program)) = if buy {
            ((USDG, TOKEN_2022), (WSOL, TOKEN))
        } else {
            ((WSOL, TOKEN), (USDG, TOKEN_2022))
        };
        let swap = swap_authority(&self.vault, seq);
        let mut accounts = vault::accounts::ExecuteSwap {
            vault: self.vault,
            session_signer: self.session.pubkey(),
            fee_payer: self.ctx.payer.pubkey(),
            input_mint,
            output_mint,
            vault_input: ata(&self.vault, &input_mint, &input_program),
            vault_output: ata(&self.vault, &output_mint, &output_program),
            swap_authority: swap,
            temp_input: ata(&swap, &input_mint, &input_program),
            input_token_program: input_program,
            output_token_program: output_program,
            jupiter_program: JUPITER,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
            owner_refund: refund.then(|| ata(&self.owner.pubkey(), &input_mint, &input_program)),
        }
        .to_account_metas(None);
        accounts.extend(route.0.iter().map(|a| AccountMeta {
            pubkey: a.pubkey,
            is_signer: false,
            is_writable: a.is_writable,
        }));
        Instruction {
            program_id: vault::ID,
            accounts,
            data: vault::instruction::ExecuteSwap {
                expected_seq: seq,
                session_epoch: self.epoch,
                amount_in,
                min_out,
                deadline: self.now + 29,
                slippage_bps,
                route_data: route.1,
            }
            .data(),
        }
    }
    /// A v0 transaction as the executor compiles it: compute limit, zero price, the swap,
    /// compressed with the route's lookup table; signed by the fee payer and the session.
    async fn transaction(
        &mut self,
        ix: &Instruction,
        limit: u64,
        m: &mut Measured,
    ) -> VersionedTransaction {
        let hash = self.ctx.get_new_latest_blockhash().await.unwrap();
        let ixs = [
            ComputeBudgetInstruction::set_compute_unit_limit(limit as u32),
            ComputeBudgetInstruction::set_compute_unit_price(0),
            ix.clone(),
        ];
        let message = v0::Message::try_compile(
            &self.ctx.payer.pubkey(),
            &ixs,
            &[self.route.alt.clone()],
            hash,
        )
        .unwrap();
        m.static_keys = message.account_keys.len();
        m.lookup_writable = message
            .address_table_lookups
            .iter()
            .map(|l| l.writable_indexes.len())
            .sum();
        m.lookup_readonly = message
            .address_table_lookups
            .iter()
            .map(|l| l.readonly_indexes.len())
            .sum();
        m.instruction_accounts = ix.accounts.len();
        m.route_accounts = ix.accounts.len() - 15;
        m.route_distinct = ix.accounts[15..]
            .iter()
            .map(|a| a.pubkey)
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        let session = self.session.insecure_clone();
        let signers = [&self.ctx.payer, &session];
        let tx = VersionedTransaction::try_new(VersionedMessage::V0(message), &signers).unwrap();
        // Wire format: compact-u16 signature count, the signatures, the message.
        m.wire_bytes = 1 + 64 * tx.signatures.len() + tx.message.serialize().len();
        tx
    }
    async fn simulate(
        &mut self,
        ix: &Instruction,
        limit: u64,
        m: &mut Measured,
    ) -> std::result::Result<(), TransactionError> {
        let tx = self.transaction(ix, limit, m).await;
        let sim = self
            .ctx
            .banks_client
            .simulate_transaction(tx)
            .await
            .unwrap();
        let details = sim.simulation_details.expect("simulation details");
        m.simulated = details.units_consumed;
        m.loaded_data = details.loaded_accounts_data_size;
        self.logs = details.logs;
        sim.result.expect("simulated")
    }
    async fn process(
        &mut self,
        ix: &Instruction,
        limit: u64,
        m: &mut Measured,
    ) -> std::result::Result<(), TransactionError> {
        let tx = self.transaction(ix, limit, m).await;
        let out = self
            .ctx
            .banks_client
            .process_transaction_with_metadata(tx)
            .await
            .unwrap();
        let meta = out.metadata.expect("transaction metadata");
        m.consumed = meta.compute_units_consumed;
        self.logs = meta.log_messages;
        m.programs(&self.logs);
        out.result
    }
    /// The executor's budget: simulate at 1.4M, sign min(1.4M, ceil(units * 1.2)), and
    /// require the signed swap to succeed within it and under `ceiling`.
    async fn swap_within_executor_budget(&mut self, ix: &Instruction, ceiling: u64) -> Measured {
        let mut m = Measured::default();
        if let Err(e) = self.simulate(ix, EXECUTOR_MAX_UNITS, &mut m).await {
            panic!("simulation failed: {e:?}\n{}", self.logs.join("\n"));
        }
        assert!(
            m.simulated * 12 <= EXECUTOR_MAX_UNITS * 10,
            "no 20% headroom under 1.4M: {m:?}"
        );
        m.limit = EXECUTOR_MAX_UNITS.min((m.simulated * 12).div_ceil(10));
        if let Err(e) = self.process(ix, m.limit, &mut m).await {
            panic!(
                "swap failed at the executor's limit: {e:?}\n{}",
                self.logs.join("\n")
            );
        }
        assert!(m.consumed <= m.limit && m.consumed <= ceiling, "{m:?}");
        assert!(
            m.jupiter > 0 && m.whirlpool > 0 && m.vault > m.jupiter,
            "{m:?}"
        );
        assert!(m.wire_bytes <= PACKET_DATA_SIZE, "{m:?}");
        assert!(m.total_accounts() <= LOCK_LIMIT, "{m:?}");
        assert!(m.route_accounts <= ROUTE_ACCOUNT_LIMIT, "{m:?}");
        assert!(m.vault_accounts() <= VAULT_ACCOUNTS + 1, "{m:?}");
        assert!(m.route_distinct <= ROUTE_DISTINCT_LIMIT, "{m:?}");
        assert!(m.max_depth < STACK_DEPTH_LIMIT, "no CPI level left: {m:?}");
        assert!(m.trace <= TRACE_LIMIT, "{m:?}");
        m
    }
    fn swap_event(&self) -> vault::SwapExecuted {
        let data = self
            .logs
            .iter()
            .filter_map(|line| line.strip_prefix("Program data: "))
            .filter_map(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
            .find(|data| data.len() == 208 && data[..8] == [150, 166, 26, 225, 28, 89, 38, 79])
            .expect("a successful swap emits its custody event");
        vault::SwapExecuted::deserialize(&mut &data[8..]).unwrap()
    }
    async fn payer_lamports(&mut self) -> u64 {
        let payer = self.ctx.payer.pubkey();
        self.account(payer).await.unwrap().lamports
    }
    /// The signature fee of a swap transaction (fee payer and session, no priority fee).
    async fn signature_fee(&mut self) -> u64 {
        let both = Instruction::new_with_bytes(
            anchor_lang::system_program::ID,
            &[],
            vec![AccountMeta::new_readonly(self.session.pubkey(), true)],
        );
        let mut message =
            solana_sdk::message::Message::new(&[both], Some(&self.ctx.payer.pubkey()));
        message.recent_blockhash = self.ctx.get_new_latest_blockhash().await.unwrap();
        assert_eq!(message.header.num_required_signatures, 2);
        let fee = self
            .ctx
            .banks_client
            .get_fee_for_message(message)
            .await
            .unwrap();
        fee.expect("a fee for a fresh message")
    }
    fn jupiter_invoked(&self) -> bool {
        let invoke = format!("Program {JUPITER} invoke");
        self.logs.iter().any(|l| l.starts_with(&invoke))
    }
    fn jupiter_succeeded(&self) -> bool {
        let success = format!("Program {JUPITER} success");
        self.logs.iter().any(|l| *l == success)
    }
    /// Everything a refused swap must leave alone.
    async fn snapshot(&mut self, seq: u64) -> BTreeMap<&'static str, u64> {
        let mut s = BTreeMap::new();
        let keys = [
            ("vault USDG", self.vault_usdg),
            ("vault WSOL", self.vault_wsol),
            ("Jupiter USDG", self.route.metas[4].pubkey),
            ("Jupiter WSOL", self.route.metas[5].pubkey),
            ("pool WSOL", self.route.metas[22].pubkey),
            ("pool USDG", self.route.metas[24].pubkey),
        ];
        for (name, k) in keys {
            let b = self.balance(k).await;
            s.insert(name, b);
        }
        let state = self.state().await;
        s.insert("seq", state.seq);
        s.insert("debits", state.debits.len() as u64);
        let swap = swap_authority(&self.vault, seq);
        for (name, k) in [
            ("temp USDG exists", ata(&swap, &USDG, &TOKEN_2022)),
            ("temp WSOL exists", ata(&swap, &WSOL, &TOKEN)),
        ] {
            let exists = self.account(k).await.is_some();
            s.insert(name, exists as u64);
        }
        s
    }
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn a_real_jupiter_route_buys_and_exits_through_the_vault_within_the_executors_budget() {
    let mut f = Fork::new(CAPS, 2 * BUY_IN).await;
    let before = f.snapshot(0).await;
    let fee = f.signature_fee().await;

    // Buy: Jupiter's answer, unchanged, at its guaranteed output.
    let min_out = f.route.threshold;
    let ix = f.swap_ix(
        0,
        true,
        f.buy_route(0),
        BUY_IN,
        min_out,
        f.route.slippage,
        false,
    );
    let payer = f.payer_lamports().await;
    let buy = f.swap_within_executor_budget(&ix, COMPUTE_CEILING).await;
    buy.report("buy (Jupiter's route)");
    assert_eq!(buy.vault_accounts(), VAULT_ACCOUNTS, "{buy:?}");
    // The fee payer funds the temporary account and gets its rent back when it closes.
    assert_eq!(f.payer_lamports().await, payer - fee);
    let event = f.swap_event();
    let after = f.snapshot(0).await;
    let received = after["vault WSOL"] - before["vault WSOL"];
    println!(
        "buy: quoted {} out, guaranteed {min_out}, received {received}",
        f.route.out_amount
    );
    assert!(received >= min_out);
    // ExactIn: the whole input is spent and the rest of the deposit stays; no input is left
    // in the temporary account (closed) or in Jupiter's shared accounts. So the vault's
    // return of leftover input does not run here; custody.rs's mock route covers it.
    assert_eq!(after["vault USDG"], before["vault USDG"] - BUY_IN);
    assert_eq!(after["temp USDG exists"], 0);
    assert_eq!(after["Jupiter USDG"], before["Jupiter USDG"]);
    assert_eq!(after["Jupiter WSOL"], before["Jupiter WSOL"]);
    assert_eq!(after["pool USDG"], before["pool USDG"] + BUY_IN);
    assert_eq!(after["pool WSOL"], before["pool WSOL"] - received);
    let state = f.state().await;
    assert_eq!(state.seq, 1);
    assert_eq!(state.debits.len(), 1);
    assert_eq!(
        (state.debits[0].notional, state.debits[0].wsol),
        (BUY_IN, 0)
    );
    assert_eq!(
        (
            event.seq,
            event.session_epoch,
            event.input_mint,
            event.output_mint
        ),
        (0, 1, USDG, WSOL)
    );
    assert_eq!((event.amount_in, event.amount_out), (BUY_IN, received));
    assert_eq!(
        (event.vault, event.owner, event.session),
        (f.vault, f.owner.pubkey(), f.session.pubkey())
    );

    // Exit, derived from the recorded route. Its quote is a simulation of that swap; the
    // signed exit then guarantees that output less 50 bps, as a Jupiter quote would.
    let probe = f.swap_ix(
        1,
        false,
        f.sell_route(1, SELL_IN, 1, 0),
        SELL_IN,
        1,
        0,
        false,
    );
    if let Err(e) = f
        .simulate(&probe, EXECUTOR_MAX_UNITS, &mut Measured::default())
        .await
    {
        panic!("{e:?}\n{}", f.logs.join("\n"));
    }
    let quote = f.swap_event().amount_out;
    let sell_min = quote * 9950 / 10000;
    let route = f.sell_route(1, SELL_IN, quote, 50);
    let ix = f.swap_ix(1, false, route, SELL_IN, sell_min, 50, false);
    let payer = f.payer_lamports().await;
    let sell = f.swap_within_executor_budget(&ix, COMPUTE_CEILING).await;
    sell.report("exit (derived)");
    assert_eq!(sell.vault_accounts(), VAULT_ACCOUNTS, "{sell:?}");
    assert_eq!(f.payer_lamports().await, payer - fee);
    let exited = f.snapshot(1).await;
    let proceeds = exited["vault USDG"] - after["vault USDG"];
    println!("exit: simulated quote {quote}, guaranteed {sell_min}, received {proceeds}");
    assert!(proceeds >= sell_min && proceeds > 0);
    assert_eq!(exited["vault WSOL"], after["vault WSOL"] - SELL_IN);
    assert_eq!(exited["temp WSOL exists"], 0);
    assert_eq!(exited["Jupiter USDG"], before["Jupiter USDG"]);
    assert_eq!(exited["Jupiter WSOL"], before["Jupiter WSOL"]);
    assert_eq!(exited["pool WSOL"], after["pool WSOL"] + SELL_IN);
    assert_eq!(exited["pool USDG"], after["pool USDG"] - proceeds);
    let state = f.state().await;
    assert_eq!(state.seq, 2);
    assert_eq!(
        (state.debits[1].notional, state.debits[1].wsol),
        (proceeds, SELL_IN)
    );
    let event = f.swap_event();
    assert_eq!(
        (event.seq, event.input_mint, event.output_mint),
        (1, WSOL, USDG)
    );
    assert_eq!((event.amount_in, event.amount_out), (SELL_IN, proceeds));

    // The rolling caps now refuse a second buy (USDG daily) and any further sell (WSOL
    // daily) before the route runs; nothing moves.
    let quiet = f.snapshot(2).await;
    let ix = f.swap_ix(
        2,
        true,
        f.buy_route(2),
        BUY_IN,
        min_out,
        f.route.slippage,
        false,
    );
    let err = f
        .process(&ix, EXECUTOR_MAX_UNITS, &mut Measured::default())
        .await
        .unwrap_err();
    assert_eq!(custom(&err), Some((SWAP_INDEX, RISK_LIMIT)), "{err:?}");
    assert!(!f.jupiter_invoked());
    let ix = f.swap_ix(2, false, f.sell_route(2, 1, 1, 0), 1, 1, 0, false);
    let err = f
        .process(&ix, EXECUTOR_MAX_UNITS, &mut Measured::default())
        .await
        .unwrap_err();
    assert_eq!(custom(&err), Some((SWAP_INDEX, RISK_LIMIT)), "{err:?}");
    assert!(!f.jupiter_invoked());
    assert_eq!(f.snapshot(2).await, quiet);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn the_real_route_is_refused_by_the_per_trade_cap_and_by_the_output_check_after_the_cpi() {
    let tight = Caps {
        per_trade: BUY_IN - 1,
        ..CAPS
    };
    let mut f = Fork::new(tight, 2 * BUY_IN).await;
    let before = f.snapshot(0).await;
    let min_out = f.route.threshold;
    // Above the owner's per-trade cap: refused before Jupiter is invoked.
    let ix = f.swap_ix(
        0,
        true,
        f.buy_route(0),
        BUY_IN,
        min_out,
        f.route.slippage,
        false,
    );
    let err = f
        .process(&ix, EXECUTOR_MAX_UNITS, &mut Measured::default())
        .await
        .unwrap_err();
    assert_eq!(custom(&err), Some((SWAP_INDEX, RISK_LIMIT)), "{err:?}");
    assert!(!f.jupiter_invoked());
    assert_eq!(f.snapshot(0).await, before);

    // Within the caps the route delivers `received`. Asking for one unit more (the route's
    // quoted output raised to match, so Jupiter's own 50 bps check still passes) is refused
    // by the vault after Jupiter succeeded, and the whole swap rolls back.
    f.set_caps(CAPS).await;
    let ix = f.swap_ix(
        0,
        true,
        f.buy_route(0),
        BUY_IN,
        min_out,
        f.route.slippage,
        false,
    );
    f.simulate(&ix, EXECUTOR_MAX_UNITS, &mut Measured::default())
        .await
        .unwrap();
    let received = f.swap_event().amount_out;
    let (mut route, greedy) = (f.buy_route(0), received + 1);
    let n = route.1.len();
    route.1[n - 11..n - 3].copy_from_slice(&greedy.to_le_bytes());
    let ix = f.swap_ix(0, true, route, BUY_IN, greedy, f.route.slippage, false);
    let err = f
        .process(&ix, EXECUTOR_MAX_UNITS, &mut Measured::default())
        .await
        .unwrap_err();
    assert_eq!(custom(&err), Some((SWAP_INDEX, AMOUNT)), "{err:?}");
    assert!(
        f.jupiter_succeeded(),
        "the output check runs after the real CPI"
    );
    assert_eq!(f.snapshot(0).await, before);

    // The unchanged route still fills afterwards, for what the simulation showed.
    let ix = f.swap_ix(
        0,
        true,
        f.buy_route(0),
        BUY_IN,
        min_out,
        f.route.slippage,
        false,
    );
    f.swap_within_executor_budget(&ix, COMPUTE_CEILING).await;
    assert_eq!(f.swap_event().amount_out, received);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn a_waiting_donation_goes_back_to_the_owner_and_the_real_route_still_fills() {
    let mut f = Fork::new(CAPS, 2 * BUY_IN).await;
    // Someone opens the seq-0 swap authority's USDG ATA and leaves tokens in it.
    let swap = swap_authority(&f.vault, 0);
    let temp = ata(&swap, &USDG, &TOKEN_2022);
    let payer = f.ctx.payer.pubkey();
    let open = create_associated_token_account_idempotent(&payer, &swap, &USDG, &TOKEN_2022);
    f.legacy(&[open], &[]).await;
    f.set_token_amount(temp, 123).await;
    let refund = ata(&f.owner.pubkey(), &USDG, &TOKEN_2022);
    let before = f.snapshot(0).await;
    // The executor passes the owner's ATA only for a waiting donation: the largest swap.
    let ix = f.swap_ix(
        0,
        true,
        f.buy_route(0),
        BUY_IN,
        f.route.threshold,
        f.route.slippage,
        true,
    );
    let m = f.swap_within_executor_budget(&ix, COMPUTE_CEILING).await;
    m.report("buy with a donation refunded");
    // The owner's refund ATA is the one account the vault adds beyond VAULT_ACCOUNTS.
    assert_eq!(m.vault_accounts(), VAULT_ACCOUNTS + 1, "{m:?}");
    let after = f.snapshot(0).await;
    assert_eq!(f.balance(refund).await, 123);
    assert_eq!(after["vault USDG"], before["vault USDG"] - BUY_IN);
    assert!(after["vault WSOL"] - before["vault WSOL"] >= f.route.threshold);
    assert_eq!(after["temp USDG exists"], 0);
    assert_eq!(after["Jupiter USDG"], before["Jupiter USDG"]);
    assert_eq!(f.state().await.debits[0].notional, BUY_IN);
}

#[tokio::test]
#[ignore = "requires the compiled custody SBF artifact; run contracts/solana/test.sh"]
async fn split_routes_cost_one_leg_more_per_leg_and_a_fourth_whirlpool_leg_is_refused() {
    // The recorded leg split two and three ways through the same pool. Jupiter's percents
    // are shares of the input and add up to 100.
    let mut units = Vec::new();
    for percents in [&[100u8][..], &[50, 50], &[34, 33, 33]] {
        let legs = percents.len();
        let mut f = Fork::new(CAPS, 2 * BUY_IN).await;
        let before = f.snapshot(0).await;
        // The quote is a simulation of the split; the signed swap guarantees it less
        // 50 bps, as a Jupiter quote would.
        let probe = f.split_route(0, percents, 1, 0);
        let probe = f.swap_ix(0, true, probe, BUY_IN, 1, 0, false);
        if let Err(e) = f
            .simulate(&probe, EXECUTOR_MAX_UNITS, &mut Measured::default())
            .await
        {
            panic!("{legs} legs: {e:?}\n{}", f.logs.join("\n"));
        }
        let quote = f.swap_event().amount_out;
        let min_out = quote * 9950 / 10000;
        let route = f.split_route(0, percents, quote, 50);
        let ix = f.swap_ix(0, true, route, BUY_IN, min_out, 50, false);
        let ceiling = COMPUTE_CEILING + (legs as u64 - 1) * LEG_CEILING;
        let m = f.swap_within_executor_budget(&ix, ceiling).await;
        m.report(&format!("buy split over {legs} legs (derived)"));
        assert_eq!(m.route_accounts, JUPITER_FIXED + legs * WHIRLPOOL_LEG);
        // A repeated leg adds route accounts, not distinct ones: no new locks.
        assert_eq!(m.vault_accounts(), VAULT_ACCOUNTS, "{m:?}");
        let after = f.snapshot(0).await;
        assert!(after["vault WSOL"] - before["vault WSOL"] >= min_out);
        assert_eq!(after["vault USDG"], before["vault USDG"] - BUY_IN);
        assert_eq!(after["pool USDG"], before["pool USDG"] + BUY_IN);
        assert_eq!(after["temp USDG exists"], 0);
        assert_eq!(after["Jupiter USDG"], before["Jupiter USDG"]);
        assert_eq!(after["Jupiter WSOL"], before["Jupiter WSOL"]);
        units.push(m.consumed);
    }
    for legs in 1..units.len() {
        let leg = units[legs] - units[legs - 1];
        println!("leg {}: {leg} units", legs + 1);
        assert!(leg <= LEG_CEILING, "{units:?}");
    }
    // Three legs use 61 of the vault's 64 route accounts. A fourth needs 77: the vault
    // refuses the route before Jupiter is invoked, and nothing moves.
    let mut f = Fork::new(CAPS, 2 * BUY_IN).await;
    let before = f.snapshot(0).await;
    let route = f.split_route(0, &[25, 25, 25, 25], 1, 0);
    assert!(route.0.len() > ROUTE_ACCOUNT_LIMIT);
    let ix = f.swap_ix(0, true, route, BUY_IN, 1, 0, false);
    let err = f
        .process(&ix, EXECUTOR_MAX_UNITS, &mut Measured::default())
        .await
        .unwrap_err();
    assert_eq!(custom(&err), Some((SWAP_INDEX, ROUTE)), "{err:?}");
    assert!(!f.jupiter_invoked());
    assert_eq!(f.snapshot(0).await, before);
}

/// Without the SBF artifact: the recorded answer moves to another vault program (a
/// release's declare_id) at the three vault accounts only, flags unchanged.
#[test]
fn the_recorded_answer_moves_to_another_vault_program_at_the_three_vault_accounts_only() {
    let answer = Answer::read();
    assert_eq!(answer.rebind(&answer.built_for).unwrap(), answer.metas);
    let release = Pubkey::new_from_array([7; 32]);
    assert_ne!(release, answer.built_for);
    let moved = answer.rebind(&release).unwrap();
    assert_eq!(moved.len(), answer.metas.len());
    for (i, (was, now)) in answer.metas.iter().zip(&moved).enumerate() {
        assert_eq!(
            (was.is_signer, was.is_writable),
            (now.is_signer, now.is_writable),
            "account {i}"
        );
        assert_eq!(
            was.pubkey == now.pubkey,
            !VAULT_SLOTS.contains(&i),
            "account {i}"
        );
    }
    assert_eq!(
        VAULT_SLOTS.map(|i| moved[i].pubkey),
        buy_slots(&release, &answer.owner, 0)
    );
}

/// An answer that does not name builtFor's vault at the three accounts, or that names a
/// vault address anywhere else (where a rebinding would leave it behind), is refused.
#[test]
fn an_answer_not_asked_for_the_recorded_vault_is_refused() {
    let answer = Answer::read();
    let release = Pubkey::new_from_array([7; 32]);
    for slot in VAULT_SLOTS {
        let mut a = answer.clone();
        a.metas[slot].pubkey = Pubkey::new_unique();
        assert!(a.rebind(&release).is_err(), "account {slot}");
    }
    let mut a = answer.clone();
    a.built_for = release;
    assert!(
        a.rebind(&vault::ID).is_err(),
        "builtFor names another program"
    );
    let [swap, temp, output] = VAULT_SLOTS.map(|i| answer.metas[i].pubkey);
    let mut a = answer.clone();
    a.metas[17].pubkey = swap;
    assert!(a.rebind(&release).is_err(), "another account");
    let mut a = answer.clone();
    a.data.extend_from_slice(temp.as_ref());
    assert!(a.rebind(&release).is_err(), "the instruction data");
    let mut a = answer.clone();
    a.alt.addresses.push(output);
    assert!(a.rebind(&release).is_err(), "the lookup table");
    let mut a = answer.clone();
    a.dumped.push(swap);
    assert!(a.rebind(&release).is_err(), "accounts.json");
    let mut a = answer.clone();
    a.metas[17].pubkey = buy_slots(&release, &answer.owner, 0)[0];
    assert!(a.rebind(&release).is_err(), "the new program's address");
    assert!(answer.rebind(&release).is_ok());
}

/// The report's distinct-account bound is the one every executor swap fits, a refund
/// account included (55), whatever this transaction itself added.
#[test]
fn the_report_states_the_distinct_account_bound_that_every_swap_fits() {
    assert_eq!(ROUTE_DISTINCT_LIMIT, 55);
    // The plain buy: 29 accounts, of which the route names 21 and the vault adds 8.
    let plain = Measured {
        static_keys: 18,
        lookup_writable: 4,
        lookup_readonly: 7,
        route_distinct: 21,
        ..Measured::default()
    };
    // With the owner's refund account: one more static key.
    let refund = Measured {
        static_keys: 19,
        ..plain
    };
    for (m, added) in [(&plain, VAULT_ACCOUNTS), (&refund, VAULT_ACCOUNTS + 1)] {
        assert_eq!(m.vault_accounts(), added);
        let line = m.summary("buy");
        assert!(
            line.contains(&format!(
                "the vault adds {added} here, so a route can name at most 55 distinct \
                 accounts in every swap the executor signs"
            )),
            "{line}"
        );
    }
}

/// The program copies, wherever PROGRAMS_ENV puts them, load only with the recorded
/// bytes: a missing file, a changed byte or another on-chain length fails closed.
#[test]
fn a_program_copy_that_is_missing_or_not_the_recorded_bytes_is_refused() {
    let programs = json("programs.json");
    let entries = programs["programs"].as_array().unwrap();
    for p in entries {
        let elf = program_elf(&elf_dir(), p).unwrap();
        assert_eq!(elf.len() as u64, number(&p["onChainLen"]));
    }
    let token = entries.iter().find(|p| p["name"] == "spl_token").unwrap();
    let dir = format!("{}/jupiter-fork-programs", env!("CARGO_TARGET_TMPDIR"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let missing = program_elf(&dir, token).unwrap_err();
    assert!(missing.contains("spl_token.so"), "{missing}");
    let mut bytes = std::fs::read(format!("{}/spl_token.so", elf_dir())).unwrap();
    std::fs::write(format!("{dir}/spl_token.so"), &bytes).unwrap();
    assert!(program_elf(&dir, token).is_ok());
    bytes[1000] ^= 1;
    std::fs::write(format!("{dir}/spl_token.so"), &bytes).unwrap();
    assert!(program_elf(&dir, token).unwrap_err().contains("sha256File"));
    let mut longer = token.clone();
    longer["onChainLen"] = (number(&token["onChainLen"]) + 1).into();
    bytes[1000] ^= 1;
    std::fs::write(format!("{dir}/spl_token.so"), &bytes).unwrap();
    assert!(program_elf(&dir, &longer)
        .unwrap_err()
        .contains("not the on-chain program"));
    std::fs::remove_dir_all(&dir).unwrap();
}
