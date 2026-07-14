/** The running build's version — so you can tell what's actually deployed. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export async function GET() {
  let version = "unknown";
  try {
    // web/ is nested under the package root at runtime (…/merrymen/web).
    const pkg = JSON.parse(await readFile(join(process.cwd(), "..", "package.json"), "utf8")) as { version?: string };
    version = pkg.version ?? "unknown";
  } catch {
    // dev-mode or unexpected layout — leave "unknown"
  }
  return NextResponse.json({ version });
}
