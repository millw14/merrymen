/** `merrymen solana-recover`: argument parsing and key input for the owner recovery tool. */
import { readFileSync, statSync } from "node:fs";
import { base58Decode } from "../../packages/core/src/ids";
import { redactUrls } from "./redact-urls";
import { createSolanaLiveRpc } from "./solana-live-rpc";
import {
  isSolanaWalletAddress, readSolanaOwnerKey, runSolanaRecovery, SOLANA_RECOVER_KEY_MAX_BYTES, SolanaRecoverError, solanaRecoveryProgramTrust,
  type SolanaRecoveryResult, type SolanaVaultRelease,
} from "./solana-recover";

/** Where the owner's RPC URL is read from: an environment variable keeps a provider key out of shell history and ps. */
export const SOLANA_RECOVER_RPC_ENV = "MERRYMEN_SOLANA_RECOVER_RPC";
/** Printed (to stderr, never with the URL) when --rpc carries what looks like a provider key. */
export const SOLANA_RECOVER_RPC_ARG_WARNING = `Warning: the --rpc URL looks like it carries an API key. It is not printed, but `
  + `command-line arguments stay in your shell history and other users of this machine can see them while the command runs. `
  + `Next time put the URL in ${SOLANA_RECOVER_RPC_ENV} instead, and consider rotating that key.`;

export const SOLANA_RECOVER_HELP = `Solana vault recovery: withdraw everything from your Merrymen Solana vault
with your own wallet key, without the Merrymen app or server.

First put your RPC URL in ${SOLANA_RECOVER_RPC_ENV}, without typing it into a
command (it may carry your provider's API key). For example, in bash or zsh:
    read -rs ${SOLANA_RECOVER_RPC_ENV}; export ${SOLANA_RECOVER_RPC_ENV}
then paste the URL and press Enter.

solana-recover --program PROGRAM_ID --owner PUBLIC_KEY
    Show the plan: vault, balances and the transactions it would send.
solana-recover --program PROGRAM_ID --key-file PATH --send
    Sign and send. Use --key-file - to read the key from standard input,
    for example: pbpaste | merrymen solana-recover ... --key-file - --send
Options: --program-sha256 HEX checks the deployed program binary first.
--rpc HTTPS_URL gives the RPC on the command line instead, for a URL with no
API key in it (a public endpoint). Give one or the other, not both.

--send signs only for a released Merrymen vault program, whose immutable
binary is checked against its released hash first. Your key signs every
instruction of the program you name, and a look-alike program could take
the SOL in your wallet and the tokens in its USDG and WSOL accounts. For a
program you deployed or audited yourself, add --program-sha256 HEX and
--unlisted-program: the binary must match, and the tool warns and waits
before signing. If someone sent you a command with --unlisted-program,
stop: Merrymen never asks for it.

Steps: (1) revoke_all, alone, waiting until it is finalized, so no session
key can trade; (2) from finalized balances, withdraw the vault's spare SOL,
all USDG and all WSOL to your wallet, creating your USDG and WSOL token
accounts if needed. Each asset is its own transaction, so one that cannot
move does not stop the others. Funds only ever move from the vault to the
owner.
Nothing is sent without --send. Each transaction is signed once; the same
signed bytes are rebroadcast until it lands or its blockhash expires, so it
can land at most once. If one does not finalize, run the command again: it
re-reads the chain first.

The key is your exported Solana wallet secret key (base58, or a
solana-keygen JSON file). It is read only from the file or standard input,
never from the command line, and is never printed, logged or sent anywhere.
--owner takes the wallet's address (its public key), never a secret.
Delete the key file when you are done. PROGRAM_ID is the program shown
next to your vault in Merrymen (the owner of the vault account). The RPC
must be a mainnet-beta HTTPS endpoint you trust; the owner pays the fees.`;

/**
 * Whether an RPC URL looks like it carries a credential: anything redactUrls
 * would hide (userinfo, a keyed provider's host, a key-named parameter, a
 * key-shaped segment), any query string, or a long token-like path segment.
 * Only for a warning, so erring towards it costs a line of text.
 */
function rpcUrlLooksKeyed(raw: string): boolean {
  if (redactUrls(raw) !== raw) return true;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.search || url.username || url.password) return true;
  return url.pathname.split("/").some((segment) => segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment) && /[0-9]/.test(segment));
}

const VALUE_FLAGS = new Set(["program", "rpc", "key-file", "owner", "program-sha256"]);
const BOOLEAN_FLAGS = new Set(["send", "unlisted-program"]);

/** True for text that decodes as a 64-byte secret key, in either export format. */
function looksLikeSecret(value: string): boolean {
  const text = value.trim();
  if (text.startsWith("[")) return text.split(",").length >= 32;
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(text)) return false;
  return base58Decode(text)?.length === 64;
}

function parse(args: readonly string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = Object.create(null);
  const refuse = (): never => {
    // Never echo an argument: a pasted key must not reach the terminal or logs.
    const leaked = args.some(looksLikeSecret);
    throw new SolanaRecoverError("Unsupported, repeated or missing option. The key is read only from --key-file PATH or --key-file - (standard input), never from the command line. Run solana-recover --help."
      + (leaked ? " A secret key appears in the command line: clear it from your shell history and treat that key as exposed." : ""));
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) refuse();
    const key = arg.slice(2);
    if (Object.hasOwn(flags, key)) refuse();
    if (BOOLEAN_FLAGS.has(key)) { flags[key] = true; continue; }
    const value = args[i + 1];
    if (!VALUE_FLAGS.has(key) || value === undefined || value.startsWith("--") || !value.length || value.length > 2048) refuse();
    // A key pasted where a value belongs (even as the --key-file path) is refused unread.
    if (looksLikeSecret(value!)) refuse();
    flags[key] = value!;
    i++;
  }
  return flags;
}

export interface SolanaRecoverCommandDeps {
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Standard input, read only for --key-file -. */
  stdin?: AsyncIterable<Buffer | string> & { isTTY?: boolean };
  fetch?: typeof globalThis.fetch;
  /** Waits: the unlisted-program pause, status polls and the transport's rebroadcast interval. */
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  pollMs?: number;
  /** Released programs; defaults to SOLANA_VAULT_RELEASES. */
  releases?: readonly SolanaVaultRelease[];
  /** Where SOLANA_RECOVER_RPC_ENV is read; process.env by default. */
  env?: Readonly<Record<string, string | undefined>>;
}

async function readKeyText(source: string, deps: SolanaRecoverCommandDeps): Promise<string> {
  const tooLarge = () => { throw new SolanaRecoverError("The key input is too large to be a Solana secret key."); };
  if (source === "-") {
    const stdin = deps.stdin ?? process.stdin;
    if (stdin.isTTY) throw new SolanaRecoverError("Standard input is a terminal. Pipe the key in (for example: pbpaste | merrymen solana-recover ... --key-file -) or pass a file path.");
    let text = "";
    for await (const chunk of stdin) {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(text) > SOLANA_RECOVER_KEY_MAX_BYTES) tooLarge();
    }
    return text;
  }
  let stats: ReturnType<typeof statSync>;
  try { stats = statSync(source); } catch { throw new SolanaRecoverError("The key file could not be read."); }
  if (!stats.isFile()) throw new SolanaRecoverError("The key file could not be read.");
  if (stats.size > SOLANA_RECOVER_KEY_MAX_BYTES) tooLarge();
  if (process.platform !== "win32" && (Number(stats.mode) & 0o077)) {
    (deps.warn ?? console.error)("Warning: the key file can be read by other users on this machine. Delete it when you are done.");
  }
  try { return readFileSync(source, "utf8"); } catch { throw new SolanaRecoverError("The key file could not be read."); }
}

export async function runSolanaRecoverCommand(args: readonly string[], deps: SolanaRecoverCommandDeps = {}): Promise<SolanaRecoveryResult | string> {
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!)) return SOLANA_RECOVER_HELP;
  if (!args.length) return SOLANA_RECOVER_HELP;
  const flags = parse(args);
  const text = (key: string) => typeof flags[key] === "string" ? flags[key] as string : undefined;
  const programId = text("program"), rpcArg = text("rpc"), keyFile = text("key-file"), expectedOwner = text("owner");
  const send = flags.send === true;
  if (!programId) throw new SolanaRecoverError("--program is required: the program shown next to your vault in Merrymen.");
  // The RPC URL from the environment, the documented path: a provider key in it stays out of
  // shell history and the process list. --rpc remains for a keyless URL. Neither is ever echoed.
  const rpcEnv = (deps.env ?? process.env)[SOLANA_RECOVER_RPC_ENV]?.trim() || undefined;
  if (rpcEnv !== undefined && rpcArg !== undefined) {
    throw new SolanaRecoverError(`Give the RPC once: ${SOLANA_RECOVER_RPC_ENV} or --rpc, not both. Nothing was read or sent.`);
  }
  const rpcUrl = rpcEnv ?? rpcArg;
  if (!rpcUrl) {
    throw new SolanaRecoverError(`Set ${SOLANA_RECOVER_RPC_ENV} to a mainnet-beta HTTPS RPC endpoint you trust (it keeps a provider key out of your shell history), `
      + "or pass --rpc HTTPS_URL for a URL with no API key in it. Run solana-recover --help.");
  }
  if (rpcArg !== undefined && rpcUrlLooksKeyed(rpcArg)) (deps.warn ?? console.error)(SOLANA_RECOVER_RPC_ARG_WARNING);
  if (send && !keyFile) throw new SolanaRecoverError("--send needs --key-file PATH (or --key-file - for standard input).");
  if (!keyFile && !expectedOwner) throw new SolanaRecoverError("Give --owner PUBLIC_KEY for a plan, or --key-file to derive it from your key.");
  // Checked before anything is read or contacted, and never echoed: a value
  // that is not a wallet address may be a pasted 32-byte secret seed.
  if (expectedOwner !== undefined && !isSolanaWalletAddress(expectedOwner)) {
    throw new SolanaRecoverError("--owner must be your Solana wallet address (its public key), and the value given is not one. It was not used, "
      + "shown or sent anywhere. If you pasted a secret key or seed there, clear it from your shell history and treat that key as exposed.");
  }
  const sha = text("program-sha256");
  if (sha !== undefined && !/^[a-f0-9]{64}$/.test(sha)) throw new SolanaRecoverError("--program-sha256 must be 64 lowercase hex characters.");
  const allowUnlistedProgram = flags["unlisted-program"] === true;
  // Refuse an unverifiable program before the key is read or the RPC is contacted.
  solanaRecoveryProgramTrust({ programId, send, programSha256: sha, allowUnlistedProgram, releases: deps.releases });
  // The RPC URL can carry an API key: it is validated, used, and never printed.
  const rpc = createSolanaLiveRpc({ env: { MERRYMEN_SOLANA_RPC_MAINNET: rpcUrl }, fetch: deps.fetch, timeoutMs: 15_000, singleEndpoint: true,
    ...(deps.sleep ? { sleep: deps.sleep } : {}) });

  let key: Awaited<ReturnType<typeof readSolanaOwnerKey>> | undefined;
  if (keyFile) {
    key = await readSolanaOwnerKey(await readKeyText(keyFile, deps));
    if (expectedOwner !== undefined && expectedOwner !== key.owner) {
      // The key's own address only: the --owner value is not repeated.
      throw new SolanaRecoverError(`The key belongs to ${key.owner}, not to the --owner address given. Nothing was sent.`);
    }
  }
  const log = deps.log ?? ((line: string) => console.log(line));
  const result = await runSolanaRecovery({ rpc, programId, owner: key?.owner ?? expectedOwner!, keyPair: key?.keyPair, send, programSha256: sha,
    allowUnlistedProgram, releases: deps.releases },
    { log, sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), maxWaitMs: deps.maxWaitMs, pollMs: deps.pollMs });
  if (keyFile && keyFile !== "-") log("Delete the exported key file now: anyone who has it controls this wallet.");
  return result;
}
