import { isGrantPurpose, type GrantPurpose } from "@merrymen/core";

/** Missing purpose keeps every existing Spot client on its original account. */
export function readRequestPurpose(req: Pick<Request, "url">): GrantPurpose | null {
  const values = new URL(req.url).searchParams.getAll("purpose");
  return values.length === 0 ? "spot" : values.length === 1 && isGrantPurpose(values[0]) ? values[0] : null;
}

export function scopedAccountUrl(url: string, purpose: GrantPurpose = "spot"): string {
  if (purpose === "spot") return url;
  const parsed = new URL(url, "http://merrymen.local");
  parsed.searchParams.set("purpose", purpose);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
