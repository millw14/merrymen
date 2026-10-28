/** The running build's version — so you can tell what's actually deployed. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

/**
 * WHICH COMMIT, FROM WHICH BRANCH. The package version only moves on a
 * release, so on its own it cannot say whether the web service runs main's
 * head, last week's main, or a feature branch somebody pointed it at. Railway
 * sets both variables at RUNTIME for a git-sourced deploy; this route reads
 * them per request, never at build. Anything that is not a full hex SHA, or
 * a plain branch name, is null rather than echoed — they are environment
 * values, not ours. null also means "not a git deploy" (a CLI upload, local
 * dev), which a reader comparing against main must treat as not main.
 */
function deployedSource(): { commit: string | null; branch: string | null } {
  const sha = (process.env.RAILWAY_GIT_COMMIT_SHA ?? "").toLowerCase();
  const branch = process.env.RAILWAY_GIT_BRANCH ?? "";
  return {
    commit: /^[0-9a-f]{40}$/.test(sha) ? sha : null,
    branch: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) && !branch.includes("..") ? branch : null,
  };
}

export async function GET() {
  let version = "unknown";
  try {
    // web/ is nested under the package root at runtime (…/merrymen/web).
    const pkg = JSON.parse(await readFile(join(process.cwd(), "..", "package.json"), "utf8")) as { version?: string };
    version = pkg.version ?? "unknown";
  } catch {
    // dev-mode or unexpected layout — leave "unknown"
  }
  // no-store: a cached answer would name the PREVIOUS deployment's commit,
  // which is the one thing this route exists to get right.
  return NextResponse.json({ version, ...deployedSource() }, { headers: { "Cache-Control": "no-store" } });
}
