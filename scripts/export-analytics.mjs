#!/usr/bin/env node
/**
 * Export the shared Merrymen ledger for analysis — pseudonymized, read-only.
 *
 *   npm install --no-save pg@8
 *   DATABASE_URL='postgresql://…' node scripts/export-analytics.mjs [outDir]
 *
 * WHAT LEAVES, AND WHAT NEVER DOES.
 * Only the tables in TABLES below are read. Signing keys (grants), sealed owner
 * settings (tenant_settings), Telegram link codes, auth nonces, private chats
 * (chat_turns), owner commands, journals and login identities are never
 * selected at all — an allowlist, so a table added later stays private until
 * somebody decides otherwise.
 *
 * PSEUDONYMS THAT STILL JOIN. Every personal address (agent accounts, owners,
 * session keys, per-account vaults), every transaction / UserOperation hash and
 * every agent name is replaced by an HMAC under a random salt that exists only
 * in this process's memory. The same value maps to the same pseudonym across
 * every table in one export, so the analyst can join and group; nobody can
 * reverse it or look an owner up on-chain, and two exports do not share
 * pseudonyms. Token and contract addresses are public market facts and stay.
 * Free text (decision reasons, posts, events) is scrubbed of the same values.
 *
 * READ ONLY, ONE SNAPSHOT. Everything is read in a single REPEATABLE READ,
 * READ ONLY transaction, so the tables agree with each other and the script
 * cannot write even by mistake.
 */
import { createHmac, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import path from "node:path";

/** table → how each sensitive column is treated. Unlisted columns pass through. */
const TABLES = {
  agents: {
    about: "One row per agent: mode (paper/live), strategy limits (caps JSON), epoch, high-water mark, fees.",
    hash: ["smart_account", "owner_address"],
    name: ["name"],
    drop: ["session_key_address", "x_handle", "x_verified"],
  },
  trades: {
    about: "Every operation the wall judged: landed, submitted, reverted, rejected (with reject_rule) and paper fills (status='paper').",
    hash: ["agent_id", "user_op_hash", "tx_hash"],
  },
  decisions: {
    about: "What each agent decided (buy/sell/hold) and why; dropped_rule says what stopped a proposal. hold_kind separates model holds from gate-forced ones.",
    hash: ["agent_id"],
    scrub: ["reason", "signals_json", "evidence_json"],
  },
  equity: {
    about: "Valuations over time. mode separates the paper and live books — never add them together. epoch increments on a reset.",
    hash: ["agent_id"],
  },
  flows: {
    about: "Deposits (direction='in') and withdrawals ('out'). Needed to separate trading P&L from money moved in or out.",
    hash: ["agent_id", "tx_hash"],
  },
  fee_accruals: { about: "Performance fees accrued at each new high-water mark.", hash: ["agent_id"] },
  cost_basis: { about: "Current weighted-average cost per held symbol, per book (mode).", hash: ["agent_id"] },
  positions: { about: "Current holdings with price, value and price source.", hash: ["agent_id"] },
  class_positions: {
    about: "Launch-curve (class) positions: cost, quantity, proceeds and state.",
    hash: ["agent_id", "vault", "entry_tx", "exit_tx"],
  },
  paper_book: { about: "Current paper cash, vault and share balances.", hash: ["agent_id"] },
  risk_periods: { about: "Owner-started risk periods (drawdown baselines).", hash: ["agent_id"], scrub: ["reason"] },
  position_floors: { about: "Per-position stop levels.", hash: ["agent_id"], scrub: ["why"] },
  trench_positions: { about: "Trencher entry baselines (entry time, entry liquidity).", hash: ["agent_id"] },
  posts: { about: "What agents published to the public feed.", hash: ["agent_id"], scrub: ["body"] },
  events: { about: "Each agent's activity feed (fills, refusals, warnings).", hash: ["agent_id"], scrub: ["message"] },
  discovered_pools: { about: "Market data: pools and launches discovered on-chain (public)." },
};

const PAGE = 5000;
const salt = randomBytes(32);
const pseudo = (kind, v) => `${kind}_${createHmac("sha256", salt).update(String(v).toLowerCase()).digest("hex").slice(0, 16)}`;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
/** A value in a hashed column: addresses and hashes get a typed pseudonym. */
function hashValue(v) {
  if (v === null || v === undefined || v === "") return v;
  const s = String(v);
  if (HASH.test(s)) return pseudo("tx", s);
  return pseudo("acct", s);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL (use the public connection URL; see the README printed by --help).");
  const outDir = path.resolve(process.argv[2] ?? `merrymen-export-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(outDir, { recursive: true });

  let pg;
  try {
    pg = (await import("pg")).default;
  } catch {
    throw new Error("The 'pg' package is missing. Run: npm install --no-save pg@8");
  }
  const client = new pg.Client({
    connectionString: url,
    ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
    application_name: "merrymen-analytics-export",
  });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const present = new Set(
      (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map(
        (r) => r.table_name,
      ),
    );

    // Everything personal that may also turn up inside free text, so the text
    // scrubber replaces exactly what the columns replace.
    const personal = new Map(); // lower(value) -> pseudonym
    const names = new Map(); // agent name -> pseudonym
    const learn = async (sql) => {
      for (const r of (await client.query(sql)).rows) {
        for (const v of Object.values(r)) if (v && ADDR.test(String(v))) personal.set(String(v).toLowerCase(), hashValue(v));
      }
    };
    if (present.has("agents")) {
      await learn("SELECT smart_account, owner_address, session_key_address FROM agents");
      for (const r of (await client.query("SELECT name FROM agents WHERE name IS NOT NULL AND length(trim(name)) >= 3")).rows) {
        names.set(r.name.trim(), pseudo("agent", r.name.trim()));
      }
    }
    if (present.has("class_positions")) await learn("SELECT DISTINCT vault FROM class_positions");

    const nameRes = [...names.keys()]
      .sort((a, b) => b.length - a.length)
      .map((n) => [new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), names.get(n)]);
    const scrub = (v) => {
      if (v === null || v === undefined) return v;
      let s = typeof v === "string" ? v : JSON.stringify(v);
      s = s.replace(/0x[0-9a-fA-F]{64}/g, (m) => pseudo("tx", m));
      s = s.replace(/0x[0-9a-fA-F]{40}/g, (m) => personal.get(m.toLowerCase()) ?? m);
      // Shortened addresses ("0x492a…8Bb4") cannot be matched back reliably.
      s = s.replace(/0x[0-9a-fA-F]{3,8}(?:…|\.\.\.)[0-9a-fA-F]{3,8}/g, "[address]");
      for (const [re, p] of nameRes) s = s.replace(re, p);
      return s;
    };

    const dictionary = [];
    for (const [table, rule] of Object.entries(TABLES)) {
      if (!present.has(table)) {
        dictionary.push({ table, rows: 0, columns: [], about: rule.about, missing: true });
        continue;
      }
      const cols = (
        await client.query(
          "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
          [table],
        )
      ).rows.filter((c) => !(rule.drop ?? []).includes(c.column_name));
      const colNames = cols.map((c) => c.column_name);
      const keyset = colNames.includes("id");
      const file = path.join(outDir, `${table}.csv.gz`);
      const gz = createGzip();
      const done = new Promise((res, rej) => gz.pipe(createWriteStream(file)).on("finish", res).on("error", rej));
      const write = (line) => (gz.write(line) ? Promise.resolve() : new Promise((r) => gz.once("drain", r)));
      await write(colNames.map(csv).join(",") + "\n");

      const transform = (row) =>
        colNames.map((c) => {
          const v = row[c];
          if ((rule.hash ?? []).includes(c)) return hashValue(v);
          if ((rule.name ?? []).includes(c)) return v ? pseudo("agent", String(v).trim()) : v;
          if ((rule.scrub ?? []).includes(c)) return scrub(v);
          return v;
        });

      const select = colNames.map((c) => `"${c}"`).join(", ");
      let rows = 0;
      if (keyset) {
        let last = null;
        for (;;) {
          const q = last === null
            ? await client.query(`SELECT ${select} FROM "${table}" ORDER BY id LIMIT ${PAGE}`)
            : await client.query(`SELECT ${select} FROM "${table}" WHERE id > $1 ORDER BY id LIMIT ${PAGE}`, [last]);
          for (const r of q.rows) await write(transform(r).map(csv).join(",") + "\n");
          rows += q.rows.length;
          if (q.rows.length < PAGE) break;
          last = q.rows[q.rows.length - 1].id;
        }
      } else {
        const q = await client.query(`SELECT ${select} FROM "${table}"`);
        for (const r of q.rows) await write(transform(r).map(csv).join(",") + "\n");
        rows = q.rows.length;
      }
      gz.end();
      await done;
      dictionary.push({ table, rows, columns: cols, about: rule.about, rule });
      console.log(`${table.padEnd(18)} ${String(rows).padStart(9)} rows`);
    }
    await client.query("COMMIT");
    writeFileSync(path.join(outDir, "README.md"), readme(dictionary));
    console.log(`\nWrote ${outDir}`);
  } finally {
    await client.end();
  }
}

function csv(v) {
  if (v === null || v === undefined) return "";
  let s;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function readme(dictionary) {
  const L = [
    "# Merrymen analytics export",
    "",
    `Exported ${new Date().toISOString()} from the shared Merrymen ledger, read-only, in one consistent snapshot.`,
    "",
    "## Privacy",
    "- Agent accounts, owner addresses, per-account vaults and transaction hashes are pseudonyms (`acct_…`, `tx_…`).",
    "  Agent names are `agent_…`. They are consistent across every file in this export, so joins work,",
    "  but they cannot be reversed and do not match any other export.",
    "- Token and contract addresses (`sell_token`, `buy_token`, `target`, `token`) are real: they are public market data.",
    "- Signing keys, owner settings, Telegram codes, private chats and login identities are not included.",
    "",
    "## Reading the numbers",
    "- `*_usdg` columns are USDG amounts in whole units (USDG ≈ 1 USD). `*_raw` columns are integer token units",
    "  (usually 18 decimals); `*_wei` is ETH in wei.",
    "- Timestamps named `at`, `created_at`, `updated_at`, `*_sec` are Unix seconds (UTC).",
    "- **Paper and live are different books.** `trades.status = 'paper'` and `equity.mode = 'paper'` are simulated;",
    "  never add paper and live money together.",
    "- `trades.status`: `landed` = on-chain and confirmed; `submitted` = sent, not yet settled; `reverted` = failed",
    "  on-chain; `rejected` = refused before sending (`reject_rule` says why); `paper` = simulated fill.",
    "- Returns: use `equity` together with `flows` (deposits/withdrawals), otherwise a deposit reads as a gain.",
    "  `epoch` increments when an agent's book is reset; compare within one epoch.",
    "",
    "## Files",
    "",
  ];
  for (const d of dictionary) {
    L.push(`### ${d.table}.csv.gz — ${d.missing ? "not present in this database" : `${d.rows} rows`}`);
    L.push(d.about);
    if (!d.missing) {
      const how = (c) =>
        d.rule.hash?.includes(c) ? " — pseudonym" : d.rule.name?.includes(c) ? " — pseudonym" : d.rule.scrub?.includes(c) ? " — text, addresses/names scrubbed" : "";
      L.push("", ...d.columns.map((c) => `- \`${c.column_name}\` (${c.data_type})${how(c.column_name)}`));
    }
    L.push("");
  }
  return L.join("\n");
}

if (process.argv.includes("--help")) {
  console.log(`Usage: DATABASE_URL='postgresql://…' node scripts/export-analytics.mjs [outDir]
Needs: npm install --no-save pg@8
Writes one gzipped CSV per analytics table plus README.md (data dictionary).`);
} else {
  main().catch((e) => {
    console.error(`export failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
