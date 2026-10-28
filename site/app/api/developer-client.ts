/**
 * The console's one way to the gateway: this site's own /api/developer proxy,
 * same-origin, with the session in an HttpOnly cookie the page never sees.
 */

/**
 * The status and body as the proxy returned them, whatever the status. The
 * body is `any`, as response.json() is: callers read the fields they know, and
 * the billing views go through their normalizers before anything is shown.
 */
export async function requestRaw(action: string, body?: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(`/api/developer/${action}`, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  // An HTML error page from a proxy in between is "something went wrong", not a JSON parse error on screen.
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data: data && typeof data === "object" ? data : {} };
}

/** The body of a 2xx, or an Error carrying the gateway's message, status and code. */
export async function request(action: string, body?: unknown) {
  const { status, data } = await requestRaw(action, body);
  if (status < 200 || status > 299) throw Object.assign(new Error(data.error?.message || "Something went wrong. Please try again."), { status, code: data.error?.code });
  return data;
}
