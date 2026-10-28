/** This URL is also the Android App Link. No caller chooses a return origin. */
export const ANDROID_AUTH_URL = "https://app.merrymen.dev/auth/android";
const RETURN_KEYS = ["privy_oauth_code", "privy_oauth_state", "privy_oauth_provider"];

export function androidOAuthEnabled(origin: string, enabled: string | undefined, privyReady: boolean): boolean {
  return origin === "https://app.merrymen.dev" && enabled === "1" && privyReady;
}

/** Only presentation differs for the native WebView; this does not authenticate anybody. */
export function isAndroidAuthWebView(userAgent: string): boolean {
  return /(?:^|\s)MerrymenAndroid\/1(?:\s|$)/.test(userAgent);
}

/** A browser may display a manual App Link, never consume the native PKCE flow itself. */
export function androidAuthReturnHref(search: URLSearchParams): string | null {
  if ([...search.keys()].some((key) => !RETURN_KEYS.includes(key)) ||
    RETURN_KEYS.some((key) => search.getAll(key).length !== 1)) return null;
  const code = search.get("privy_oauth_code")!;
  const state = search.get("privy_oauth_state")!;
  if (search.get("privy_oauth_provider") !== "twitter" || !/^[!-~]{1,4096}$/.test(code) ||
    !/^[!-~]{16,512}$/.test(state)) return null;
  const out = new URL(ANDROID_AUTH_URL);
  for (const key of RETURN_KEYS) out.searchParams.set(key, search.get(key)!);
  return out.href;
}
