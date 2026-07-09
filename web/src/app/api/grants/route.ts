/**
 * Dev-mode grant handoff: the browser POSTs a signed grant here and the worker
 * picks it up from .data/grant.json at the repo root. Replaced by Supabase
 * (encrypted, per-user) once persistence lands — this is single-user local dev.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import type { StoredGrant } from "@merrymen/core";

const DATA_DIR = path.join(process.cwd(), "..", ".data");
const GRANT_FILE = path.join(DATA_DIR, "grant.json");

export async function POST(req: Request) {
  const grant = (await req.json()) as StoredGrant;
  if (!grant?.serialized || !grant?.smartAccount) {
    return NextResponse.json({ error: "not a grant" }, { status: 400 });
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(GRANT_FILE, JSON.stringify(grant, null, 2), "utf8");
  return NextResponse.json({ ok: true, file: GRANT_FILE });
}

export async function GET() {
  try {
    const raw = await readFile(GRANT_FILE, "utf8");
    const grant = JSON.parse(raw) as StoredGrant;
    return NextResponse.json({
      exists: true,
      smartAccount: grant.smartAccount,
      expiresAt: grant.expiresAt,
      chainId: grant.chainId,
    });
  } catch {
    return NextResponse.json({ exists: false });
  }
}
