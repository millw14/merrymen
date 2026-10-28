#!/usr/bin/env node
// Writes this directory's fixtures for tests/jupiter_fork.rs: one Jupiter v6 route for the
// test vault, the mainnet accounts it names at one slot and the programs it runs.
//
//   node refresh.mjs addresses [--vault-program <id>] [--owner-seed <text>]
//       No network. Prints what a route is asked for: the test owner, its vault, and the
//       vault's seq-0 swap authority, temporary USDG account and WSOL account.
//   node refresh.mjs fetch <raw dir> [--vault-program <id>] [--owner-seed <text>] [--rpc <url>]
//       Read-only, keyless reads, saved as answered to <raw dir> (an empty directory
//       outside the repository): one Jupiter quote (GET) and swap-instructions build
//       (POST: Jupiter answers with an unsigned instruction; nothing is signed or sent) at
//       lite-api.jup.ag, the keyless host of the executor's /swap/v1 API; one
//       getMultipleAccounts of every account the route names, at one slot, and
//       getBlockTime of that slot; getAccountInfo of each program the route runs (and of
//       its programdata) and of the ATA program.
//   node refresh.mjs build <raw dir> [--out <dir>] [--elf-out <dir>]
//       No network. Writes route.json, accounts.json and programs.json (to --out, default
//       this directory) and each program's ELF without its on-chain zero padding (to
//       --elf-out, default --out), with the provenance tests/jupiter_fork.rs checks.
//
// --vault-program defaults to declare_id! in programs/merrymen-vault/src/lib.rs and
// --owner-seed to the test's OWNER_SEED. route.json's provenance.builtFor names both and
// the addresses derived from them; the test moves those three vault accounts to its own
// build's program ID, so a new declare_id needs no new fetch. A Jupiter, Whirlpool or SPL
// upgrade (programs.json's hashes stop matching what an RPC serves), another route or a
// change to the executor's parameters does: fetch and build again, delete any program
// file the new route no longer uses, and record the change in NOTICE.md.
// --rpc must be keyless (https, no path, query or credentials): it is written into the
// fixtures. Node 22 or later, built-ins only.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_RS = path.join(HERE, "..", "..", "..", "programs", "merrymen-vault", "src", "lib.rs");
export const OWNER_SEED = "merrymen jupiter fork test owner";
export const USDG = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
export const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111";
const LOADER_V2 = "BPFLoader2111111111111111111111111111111111";
// solana-program-test 2.3.13 bundles spl_memo-3.0.0.so with this sha256, and the test
// uses that copy, so the route's Memo program is not dumped.
const BUNDLED_MEMO_SHA256 = "f520eaf096361abbb9639ea4dc3e5388a87b9330e121f476607b87c46ef67954";
const JUPITER_HOST = "https://lite-api.jup.ag";
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
// Program fixtures by address: name and file. Another program is named by its address.
const PROGRAMS = {
  [JUPITER]: ["jupiter_v6", "jupiter_v6.so"],
  [WHIRLPOOL]: ["whirlpool", "whirlpool.so"],
  [TOKEN]: ["spl_token", "spl_token.so"],
  [TOKEN_2022]: ["spl_token_2022", "spl_token_2022.so"],
  [ATA_PROGRAM]: ["spl_ata", "spl_associated_token_account.so"],
  [MEMO]: ["spl_memo", null],
};
// worker/src/solana-live-market.ts's quote for one USDG -> WSOL buy of 1 USDG, plus
// onlyDirectRoutes, and its swap-instructions body without the quote and accounts.
// maxAccounts (SOLANA_JUPITER_MAX_ACCOUNTS) was added after the committed route.json
// was recorded; that direct route names 21 distinct accounts, so it would not have
// changed it. The next refresh asks with it.
export const QUOTE = {
  inputMint: USDG, outputMint: WSOL, amount: "1000000", slippageBps: "50", swapMode: "ExactIn",
  restrictIntermediateTokens: "true", platformFeeBps: "0", instructionVersion: "V1", maxAccounts: "40", onlyDirectRoutes: "true",
};
export const BUILD = {
  wrapAndUnwrapSol: false, useSharedAccounts: true, dynamicSlippage: false,
  dynamicComputeUnitLimit: false, skipUserAccountsRpcCalls: true, computeUnitPriceMicroLamports: 0,
};
const ROUTE_NOTE = "One read-only Jupiter quote (GET) and swap-instructions build (POST; nothing was signed or sent), written by refresh.mjs. userPublicKey is builtFor's seq-0 swap authority and destinationTokenAccount its WSOL account; the test moves these and the temporary USDG account (accounts 2, 6 and 3) to its own build's vault program. Parameters mirror worker/src/solana-live-market.ts plus onlyDirectRoutes=true; lite-api.jup.ag is the keyless host of the same /swap/v1 API.";

// JSON with integers beyond 2^53 kept exact (rentEpoch is u64::MAX), as BigInt.
export function parseJson(text) {
  return JSON.parse(text, (_key, value, context) =>
    typeof value === "number" && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? "")
      ? BigInt(context.source) : value);
}
export function stringify(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? JSON.rawJSON(String(v)) : v), 1) + "\n";
}
const readJson = file => parseJson(readFileSync(file, "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
export function key(text) {
  if (typeof text !== "string" || text.length === 0) throw new Error(`not an address: ${text}`);
  let n = 0n;
  for (const c of text) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${text}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of text) { if (c !== "1") break; bytes.unshift(0); }
  if (bytes.length !== 32) throw new Error(`not a 32-byte address: ${text}`);
  return Buffer.from(bytes);
}

// Ed25519 over p = 2^255 - 19: whether 32 bytes decompress to a curve point, as
// curve25519-dalek's CompressedEdwardsY::decompress (Pubkey::is_on_curve) decides: y is
// the low 255 bits, and a point exists when (y^2 - 1) / (d y^2 + 1) is a square or zero.
const P = 2n ** 255n - 19n;
const mod = a => ((a % P) + P) % P;
function pow(b, e) {
  let r = 1n;
  for (b = mod(b); e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; }
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));
export function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y = mod(y & ((1n << 255n) - 1n));
  const yy = (y * y) % P;
  const w = (mod(yy - 1n) * pow(mod(D * yy + 1n), P - 2n)) % P;
  return w === 0n || pow(w, (P - 1n) / 2n) === 1n;
}
/** Pubkey::find_program_address. */
export function programAddress(seeds, program) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const seed of seeds) h.update(seed);
    const out = h.update(Buffer.from([bump])).update(key(program)).update("ProgramDerivedAddress").digest();
    if (!onCurve(out)) return b58encode(out);
  }
  throw new Error("no program address");
}
export const ata = (wallet, mint, tokenProgram) =>
  programAddress([key(wallet), key(tokenProgram), key(mint)], ATA_PROGRAM);
/** The public key of the Ed25519 keypair whose 32-byte secret seed is `seed` (Keypair::new_from_array). */
export function ownerFromSeed(seed) {
  const bytes = Buffer.from(seed, "utf8");
  if (bytes.length !== 32) throw new Error("--owner-seed must be 32 bytes");
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), bytes]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  return b58encode(spki.subarray(spki.length - 32));
}
/** What a route is asked for: route.json's provenance.builtFor. */
export function builtFor(vaultProgram, ownerSeed = OWNER_SEED, seq = 0) {
  key(vaultProgram);
  const owner = ownerFromSeed(ownerSeed);
  const vault = programAddress([Buffer.from("vault"), key(owner)], vaultProgram);
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(seq));
  const swapAuthority = programAddress([Buffer.from("swap"), key(vault), le], vaultProgram);
  return {
    vaultProgram, ownerSeed, owner, vault, seq, swapAuthority,
    inputAccount: ata(swapAuthority, USDG, TOKEN_2022), outputAccount: ata(vault, WSOL, TOKEN),
  };
}
export function declaredId(source = readFileSync(LIB_RS, "utf8")) {
  const found = /^declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\);$/m.exec(source);
  if (!found) throw new Error(`no declare_id! in ${LIB_RS}`);
  key(found[1]);
  return found[1];
}
export function keylessRpc(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") {
    throw new Error("--rpc must be a keyless https origin, with no path, query or credentials: it is written into the fixtures");
  }
  return u.origin;
}

async function http(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${text.slice(0, 200)}`);
  return parseJson(text);
}
const unique = keys => [...new Set(keys)];

/** The read-only fetch: raw answers, as given, into an empty directory. */
export async function fetchRaw(raw, { vaultProgram = declaredId(), ownerSeed = OWNER_SEED, rpc: rpcUrl = DEFAULT_RPC } = {}) {
  if (existsSync(raw) && readdirSync(raw).length > 0) throw new Error(`${raw} is not empty`);
  rpcUrl = keylessRpc(rpcUrl);
  mkdirSync(path.join(raw, "route"), { recursive: true });
  mkdirSync(path.join(raw, "programs"), { recursive: true });
  const write = (name, value) => writeFileSync(path.join(raw, name), stringify(value));
  const rpc = async (method, params) => {
    const out = await http(rpcUrl, { jsonrpc: "2.0", id: 1, method, params });
    if (out.error) throw new Error(`${method}: ${stringify(out.error)}`);
    return out.result;
  };
  const request = builtFor(vaultProgram, ownerSeed);
  write("request.json", request);

  const quoteUrl = `${JUPITER_HOST}/swap/v1/quote?${new URLSearchParams(QUOTE)}`;
  let at = utcNow();
  const quote = await http(quoteUrl);
  write("route/quote.json", { url: quoteUrl, fetchedAtUtc: at, response: quote });
  const buildUrl = `${JUPITER_HOST}/swap/v1/swap-instructions`;
  const body = { userPublicKey: request.swapAuthority, quoteResponse: quote, destinationTokenAccount: request.outputAccount, ...BUILD };
  at = utcNow();
  const built = await http(buildUrl, body);
  write("route/swap-instructions.json", { url: buildUrl, fetchedAtUtc: at, request: body, response: built });

  const keys = unique([...built.swapInstruction.accounts.map(a => a.pubkey), ...(built.addressLookupTableAddresses ?? []), USDG, WSOL]);
  if (keys.length > 100) throw new Error(`${keys.length} accounts: getMultipleAccounts takes 100`);
  at = utcNow();
  const accounts = await rpc("getMultipleAccounts", [keys, { encoding: "base64", commitment: "finalized" }]);
  write("route/accounts.json", { rpc: rpcUrl, fetchedAtUtc: at, keys, result: accounts });
  const slot = accounts.context.slot;
  write("route/block-time.json", { rpc: rpcUrl, slot, blockTime: await rpc("getBlockTime", [slot]) });

  const programs = {};
  const executables = keys.filter((_, i) => accounts.value[i]?.executable);
  for (const program of unique([...executables, ATA_PROGRAM])) {
    const [name] = PROGRAMS[program] ?? [program];
    const readAtUtc = utcNow();
    const info = await rpc("getAccountInfo", [program, { encoding: "base64", commitment: "finalized" }]);
    if (!info.value?.executable) throw new Error(`${program} is not an executable account`);
    const data = Buffer.from(info.value.data[0], "base64");
    if (info.value.owner === LOADER_V3) {
      // UpgradeableLoaderState::Program: tag 2, then the programdata address.
      if (data.length !== 36 || data.readUInt32LE(0) !== 2) throw new Error(`${program}: not a loader-v3 program account`);
      const programdata = b58encode(data.subarray(4, 36));
      const pd = await rpc("getAccountInfo", [programdata, { encoding: "base64", commitment: "finalized" }]);
      const bytes = Buffer.from(pd.value.data[0], "base64");
      // ProgramData: tag 3, deploy slot, Option<upgrade authority>, then the ELF.
      if (pd.value.owner !== LOADER_V3 || bytes.readUInt32LE(0) !== 3) throw new Error(`${programdata}: not programdata`);
      const full = bytes.subarray(45);
      writeFileSync(path.join(raw, "programs", `${name}.full.so`), full);
      programs[name] = {
        program, programdata, readSlot: pd.context.slot, readAtUtc,
        deploySlot: Number(bytes.readBigUInt64LE(4)), upgradeAuthority: bytes[12] ? b58encode(bytes.subarray(13, 45)) : null,
        programdataLen: bytes.length, sha256Full: sha256(full), lenFull: full.length,
      };
    } else if (info.value.owner === LOADER_V2) {
      writeFileSync(path.join(raw, "programs", `${name}.full.so`), data);
      programs[name] = { program, loader: LOADER_V2, readSlot: info.context.slot, readAtUtc, sha256Full: sha256(data), lenFull: data.length };
    } else {
      throw new Error(`${program}: loader ${info.value.owner} is not supported`);
    }
  }
  write("programs/programs.json", programs);
  return request;
}

/** Where an ELF64's sections (but SHT_NOBITS), segments and section header table end. */
export function elfExtent(full) {
  if (full.length < 64 || full.readUInt32BE(0) !== 0x7f454c46 || full[4] !== 2 || full[5] !== 1) {
    throw new Error("not a little-endian ELF64");
  }
  const phoff = Number(full.readBigUInt64LE(0x20));
  const shoff = Number(full.readBigUInt64LE(0x28));
  const [phentsize, phnum, shentsize, shnum] = [0x36, 0x38, 0x3a, 0x3c].map(o => full.readUInt16LE(o));
  let end = shoff + shnum * shentsize;
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    if (full.readUInt32LE(o + 4) !== 8) end = Math.max(end, Number(full.readBigUInt64LE(o + 0x18)) + Number(full.readBigUInt64LE(o + 0x20)));
  }
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    end = Math.max(end, Number(full.readBigUInt64LE(o + 8)) + Number(full.readBigUInt64LE(o + 0x20)));
  }
  return end;
}
/** The on-chain bytes without their zero padding, never cutting into the ELF's extent. */
export function trimElf(full) {
  let last = full.length;
  while (last > 0 && full[last - 1] === 0) last--;
  const length = Math.max(elfExtent(full), last);
  if (length > full.length) throw new Error("the ELF extends past the account");
  return full.subarray(0, length);
}

const same = (a, b) => stringify(a) === stringify(b);
/** The offline build: fixtures from a raw directory that fetch wrote. */
export function buildFixtures(raw, { out = HERE, elfOut = out } = {}) {
  const read = name => readJson(path.join(raw, name));
  const request = read("request.json");
  const q = read("route/quote.json");
  const s = read("route/swap-instructions.json");
  const a = read("route/accounts.json");
  const bt = read("route/block-time.json");
  const progs = read("programs/programs.json");
  // What the answer was asked for, derived again from the program and seed.
  const expected = builtFor(request.vaultProgram, request.ownerSeed, request.seq);
  if (!same(request, expected)) throw new Error("request.json is not derived from its vault program and owner seed");
  if (s.request.userPublicKey !== expected.swapAuthority || s.request.destinationTokenAccount !== expected.outputAccount) {
    throw new Error("swap-instructions was not asked for builtFor's accounts");
  }
  if (!same(s.request.quoteResponse, q.response)) throw new Error("swap-instructions did not build the recorded quote");
  const ix = s.response.swapInstruction;
  if (ix.programId !== JUPITER) throw new Error(`the swap instruction is for ${ix.programId}`);
  const vaultAccounts = [expected.swapAuthority, expected.inputAccount, expected.outputAccount];
  if (!same([2, 3, 6].map(i => ix.accounts[i]?.pubkey), vaultAccounts)) {
    throw new Error("Jupiter's answer does not name builtFor's accounts at 2, 3 and 6");
  }
  const slot = a.result.context.slot;
  if (bt.slot !== slot) throw new Error("the block time is for another slot");

  const route = {
    provenance: {
      note: ROUTE_NOTE,
      builtFor: expected,
      quote: { method: "GET", url: q.url, fetchedAtUtc: q.fetchedAtUtc },
      swapInstructions: {
        method: "POST", url: s.url, fetchedAtUtc: s.fetchedAtUtc,
        body: Object.fromEntries(Object.entries(s.request).filter(([k]) => k !== "quoteResponse")),
      },
    },
    quote: q.response,
    swapInstructions: s.response,
  };

  // Every account the route names at the one slot, but the Memo program (the test uses
  // solana-program-test's identical copy) and the vault's own accounts, which mainnet
  // must not have: the test creates them.
  const kept = [];
  let memo = null;
  a.keys.forEach((k, i) => {
    const v = a.result.value[i];
    if (vaultAccounts.includes(k)) {
      if (v !== null) throw new Error(`${k}, a vault account, exists on mainnet`);
      return;
    }
    if (v === null) throw new Error(`${k} does not exist at slot ${slot}`);
    if (k === MEMO) { memo = k; return; }
    kept.push({ pubkey: k, owner: v.owner, lamports: v.lamports, executable: v.executable, rentEpoch: v.rentEpoch, data: v.data[0] });
  });
  if (!vaultAccounts.every(k => a.keys.includes(k))) throw new Error("the route does not name every vault account");
  const omitted = {};
  if (memo) {
    const memoSha = progs.spl_memo?.sha256Full;
    if (memoSha !== BUNDLED_MEMO_SHA256) throw new Error(`mainnet's Memo program (sha256 ${memoSha}) is not solana-program-test's bundled copy`);
    omitted[MEMO] = `loader-v2 program, sha256 ${memoSha} equals solana-program-test's bundled spl_memo-3.0.0.so`;
  }
  omitted[vaultAccounts.join(", ")] = "builtFor's swap authority, temporary input ATA and WSOL ATA: absent on mainnet, created by the test (under its own build's vault program)";
  const accounts = {
    provenance: {
      rpc: a.rpc, method: "getMultipleAccounts", commitment: "finalized", encoding: "base64", slot,
      apiVersion: a.result.context.apiVersion,
      apiVersionSource: "the getMultipleAccounts response context: the RPC node's software version, not the test runtime's",
      fetchedAtUtc: a.fetchedAtUtc, blockTime: bt.blockTime, blockTimeSource: "getBlockTime(slot) on the same RPC",
      omitted,
    },
    accounts: kept,
  };

  // Programs: the ELF without the on-chain zero padding; the test pads it back to the
  // recorded on-chain length and checks the sha256 of the on-chain bytes.
  const programs = {
    provenance: {
      rpc: a.rpc,
      method: "getAccountInfo (base64) of the programdata account, or of the program for loader v2",
      note: "file = ELF bytes; onChainLen/sha256OnChain = the bytes after the 45-byte programdata header (or the loader-v2 account data), i.e. the file followed by zero padding",
    },
    programs: [],
  };
  const elves = [];
  // Known programs in PROGRAMS's order, then any other by name: a refresh keeps the order.
  const rank = ([name, m]) => [Object.keys(PROGRAMS).indexOf(m.program) >>> 0, name];
  const order = (x, y) => { const [a, b] = [rank(x), rank(y)]; return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); };
  for (const [name, m] of Object.entries(progs).sort(order)) {
    if (m.program === MEMO) continue;
    const file = PROGRAMS[m.program]?.[1] ?? `${name}.so`;
    const full = readFileSync(path.join(raw, "programs", `${name}.full.so`));
    if (sha256(full) !== m.sha256Full || full.length !== m.lenFull) throw new Error(`${name}.full.so is not what was read`);
    const elf = trimElf(full);
    const entry = {
      name, file, program: m.program, readSlot: m.readSlot, readAtUtc: m.readAtUtc,
      onChainLen: full.length, sha256OnChain: m.sha256Full, sha256File: sha256(elf), fileLen: elf.length,
    };
    if (m.programdata) {
      if (m.deploySlot >= slot) throw new Error(`${name} was deployed at slot ${m.deploySlot}, not before the route's slot ${slot}: fetch again`);
      Object.assign(entry, { loader: LOADER_V3, programdata: m.programdata, deploySlot: m.deploySlot, upgradeAuthority: m.upgradeAuthority });
    } else {
      Object.assign(entry, { loader: m.loader });
    }
    programs.programs.push(entry);
    elves.push([file, elf]);
  }
  const named = new Set(programs.programs.map(p => p.program));
  for (const k of a.keys.filter((_, i) => a.result.value[i]?.executable)) {
    if (k !== MEMO && !named.has(k)) throw new Error(`the route runs ${k}, which was not read`);
  }
  mkdirSync(out, { recursive: true });
  mkdirSync(elfOut, { recursive: true });
  writeFileSync(path.join(out, "route.json"), stringify(route));
  writeFileSync(path.join(out, "accounts.json"), stringify(accounts));
  writeFileSync(path.join(out, "programs.json"), stringify(programs));
  for (const [file, elf] of elves) writeFileSync(path.join(elfOut, file), elf);
  return { route, accounts, programs, files: elves.map(([file]) => file) };
}

function options(args) {
  const out = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const name = { "--vault-program": "vaultProgram", "--owner-seed": "ownerSeed", "--rpc": "rpc", "--out": "out", "--elf-out": "elfOut" }[args[i]];
    if (name) {
      if (i + 1 >= args.length) throw new Error(`${args[i]} needs a value`);
      out[name] = args[++i];
    } else if (args[i].startsWith("--")) {
      throw new Error(`unknown option ${args[i]}`);
    } else {
      out.positional.push(args[i]);
    }
  }
  return out;
}
async function main([command, ...args]) {
  if (typeof JSON.rawJSON !== "function") throw new Error("Node 22 or later is needed (JSON.rawJSON)");
  const o = options(args);
  if (command === "addresses" && o.positional.length === 0) {
    process.stdout.write(stringify(builtFor(o.vaultProgram ?? declaredId(), o.ownerSeed ?? OWNER_SEED)));
  } else if (command === "fetch" && o.positional.length === 1) {
    const request = await fetchRaw(path.resolve(o.positional[0]), { vaultProgram: o.vaultProgram, ownerSeed: o.ownerSeed, rpc: o.rpc });
    console.log(`fetched for vault program ${request.vaultProgram} into ${o.positional[0]}`);
  } else if (command === "build" && o.positional.length === 1) {
    const out = path.resolve(o.out ?? HERE);
    const built = buildFixtures(path.resolve(o.positional[0]), { out, elfOut: path.resolve(o.elfOut ?? out) });
    console.log(`wrote route.json, accounts.json, programs.json and ${built.files.join(", ")}`);
  } else {
    console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 21).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(2);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
