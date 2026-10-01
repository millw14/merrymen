/** Owner-only PNG previews: real components, scripted authenticated image responses. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import { act, createElement } from "react";
import { PnlCardDialog } from "./PnlCardDialog";
import { SwapsTable } from "./SwapsTable";
import { swapRowsOfDesk, swapRowsOfProfile, type SwapRow } from "./swaps";
import type { Thesis } from "./live";
import { deferred, json, testDom } from "./test-dom";

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let calls: { url: string; init?: RequestInit }[];
let created: Blob[];
let revoked: string[];
let printed: number;
let respond: (url: string, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  ui = testDom();
  calls = []; created = []; revoked = []; printed = 0;
  const proto = ui.dom.window.HTMLDialogElement.prototype;
  // jsdom does not implement native dialogs; use the same focus model as the
  // settings dialog tests. The component itself must restore the opener.
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>("[autofocus], button:not([disabled])")?.focus();
  };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  ui.dom.window.print = () => { printed++; };
  URL.createObjectURL = (blob) => { created.push(blob as Blob); return `blob:private-pnl-${created.length}`; };
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  respond = () => png();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
});
afterEach(async () => {
  mock.timers.reset();
  await ui.close();
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
const ownerRow = (over: Partial<Thesis> = {}): SwapRow => swapRowsOfDesk([{
  name: "Shogun", slug: "shogun", handle: null, head: "curve-trade", action: "sell", symbol: "CASHCAT",
  sizeUsdg: 12, reason: "took profit", paper: false, at: 1_800_000_000, outcome: "landed", outcomeText: null,
  tradeId: 731, fillCashUsdg: 12.5, realizedPnlUsdg: 2.5, realizedVouched: true, ...over,
}])[0]!;
const table = (rows = [ownerRow()], opts: { showMoney?: boolean; allowPnlCards?: boolean } = {}) =>
  createElement(SwapsTable, { rows, tokens: [], showMoney: true, emptyTitle: "No trades", limit: 30, ...opts });
const buttons = (label: string) => [...ui.dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
  .filter((button) => button.textContent?.trim() === label);
const dialog = () => ui.dom.window.document.querySelector("dialog");
const image = () => ui.dom.window.document.querySelector<HTMLImageElement>(".pnl-card-image");
const download = () => ui.dom.window.document.querySelector<HTMLAnchorElement>("a[download]");
async function press(button: HTMLButtonElement | undefined) {
  assert.ok(button, "expected button is available");
  await act(async () => { button.click(); });
}
async function showOwnerCard() {
  await ui.render(table(undefined, { allowPnlCards: true }));
  const opener = buttons("P&L image")[0]!;
  opener.focus();
  await press(opener);
  return opener;
}
async function loadImage() {
  assert.ok(image(), "an image preview is available");
  await act(async () => { image()!.dispatchEvent(new ui.dom.window.Event("load")); });
}

it("public tables never offer export, even when their owner published the dollars", async () => {
  await ui.render(table());
  assert.equal(buttons("P&L image").length, 0, "the default shared table has no export capability");
  await ui.render(table(undefined, { allowPnlCards: true, showMoney: false }));
  assert.equal(buttons("P&L image").length, 0, "private dollar data cannot become an image");
  const published = swapRowsOfProfile([{ id: "731", action: "sell", symbol: "CASHCAT", displayName: null,
    at: 1_800_000_000, paper: false, sizeUsdg: 12.5, realizedPnlUsdg: 2.5, realizedPnlBps: 2_500 }]);
  await ui.render(table(published, { allowPnlCards: true }));
  assert.equal(buttons("P&L image").length, 0, "a public row ID is not owner export authority");
  assert.equal(calls.length, 0, "viewing a tape does not fetch financial images");
});

it("offers an owner image only on a measured live sell with a known label and basis", async () => {
  const changes: Partial<Thesis>[] = [
    { paper: true }, { outcome: "pending" }, { outcome: "refused" }, { outcome: "reverted" }, { action: "buy" },
    { action: null }, { head: "transfer" }, { realizedVouched: false }, { realizedVouched: undefined },
    { symbol: null }, { symbol: "0xabcdef" }, { symbol: "T3139F043B88" }, { tradeId: null },
    { tradeId: 0 }, { tradeId: Number.MAX_SAFE_INTEGER + 1 }, { realizedPnlUsdg: null },
    { fillCashUsdg: null }, { fillCashUsdg: -1 }, { fillCashUsdg: 2.501 },
  ];
  const rows = [ownerRow(), ...changes.map((change) => ownerRow(change))].map((row, i) => ({ ...row, id: `row-${i}` }));
  await ui.render(table(rows, { allowPnlCards: true }));
  assert.equal(buttons("P&L image").length, 1);
  assert.equal(buttons("P&L image")[0]!.getAttribute("aria-label"), "P&L image for CASHCAT");
  assert.equal(calls.length, 0, "only pressing the image action starts generation");
});

it("a generated curve-token identifier uses its recorded human name and a safe download filename", async () => {
  await ui.render(table([ownerRow({ symbol: "T3139F043B88", displayName: "Cash Cat / USDG" })], { allowPnlCards: true }));
  const opener = buttons("P&L image")[0]!;
  assert.equal(opener.getAttribute("aria-label"), "P&L image for Cash Cat / USDG");
  await press(opener);
  assert.equal(dialog()?.querySelector("h2")?.textContent, "Cash Cat / USDG P&L image");
  await loadImage();
  assert.equal(download()?.download, "CashCatUSDG-731-pnl.png");
  assert.deepEqual(calls.map((call) => call.url), ["/api/pnl?trade=731"], "the human label is never a lookup key");
});

it("fetches the canonical ledger ID, then enables a private PNG download and print only once loaded", async () => {
  await showOwnerCard();
  assert.deepEqual(calls.map((call) => call.url), ["/api/pnl?trade=731"], "not the table's timestamp/index key");
  assert.equal(calls[0]!.init?.credentials, "same-origin");
  assert.equal(calls[0]!.init?.cache, "no-store");
  assert.equal(calls[0]!.init?.signal?.aborted, false);
  assert.equal(dialog()?.hasAttribute("open"), true);
  assert.match(dialog()?.textContent ?? "", /partial sell shows only the portion sold/);
  assert.equal(image()?.getAttribute("src"), "blob:private-pnl-1");
  assert.equal(created[0]?.type, "image/png");
  assert.equal(download(), null);
  assert.equal(buttons("Print")[0]?.disabled, true);
  await press(buttons("Print")[0]);
  assert.equal(printed, 0);
  await loadImage();
  assert.equal(download()?.getAttribute("href"), "blob:private-pnl-1");
  assert.equal(download()?.download, "CASHCAT-731-pnl.png");
  assert.equal(buttons("Print")[0]?.disabled, false);
  await press(buttons("Print")[0]);
  assert.equal(printed, 1);
  assert.equal(ui.dom.window.localStorage.length, 0, "images are not persisted beside wallet data");
});

it("closing restores the triggering button and releases the private image", async () => {
  const opener = await showOwnerCard();
  assert.equal(ui.dom.window.document.activeElement?.textContent, "Close");
  await press(buttons("Close")[0]);
  assert.equal(dialog(), null);
  assert.deepEqual(revoked, ["blob:private-pnl-1"]);
  assert.equal(calls[0]!.init?.signal?.aborted, true);
  assert.equal(ui.dom.window.document.activeElement === opener, true, "keyboard users return to the trade they opened");
});

it("Escape closes the preview through its cancel event and clears the object URL", async () => {
  await showOwnerCard();
  const event = new ui.dom.window.Event("cancel", { cancelable: true, bubbles: true });
  await act(async () => { dialog()!.dispatchEvent(event); });
  assert.equal(event.defaultPrevented, true);
  assert.equal(dialog(), null);
  assert.deepEqual(revoked, ["blob:private-pnl-1"]);
});

it("a trade disappearing from the owner's tape closes and forgets its private preview", async () => {
  await showOwnerCard();
  await ui.render(table([ownerRow({ tradeId: 732, symbol: "OTHER" })], { allowPnlCards: true }));
  assert.equal(dialog(), null);
  assert.deepEqual(revoked, ["blob:private-pnl-1"]);
  await ui.render(table(undefined, { allowPnlCards: true }));
  assert.equal(dialog(), null, "the old image does not reopen when the previous feed comes back");
  assert.equal(calls.length, 1);
});

it("revoking export capability closes and forgets an already generated image", async () => {
  await showOwnerCard();
  await ui.render(table(undefined, { allowPnlCards: false }));
  assert.equal(dialog(), null);
  assert.deepEqual(revoked, ["blob:private-pnl-1"]);
  await ui.render(table(undefined, { allowPnlCards: true }));
  assert.equal(dialog(), null, "restoring capability requires an explicit new action");
  assert.equal(calls.length, 1);
});

it("removing evidence while an image is generating aborts it and ignores its late response", async () => {
  const pending = deferred<Response>();
  respond = () => pending.promise;
  await showOwnerCard();
  await ui.render(table([ownerRow({ realizedVouched: false })], { allowPnlCards: true }));
  assert.equal(dialog(), null);
  assert.equal(calls[0]!.init?.signal?.aborted, true);
  await act(async () => { pending.resolve(png()); });
  assert.equal(created.length, 0);
});

it("rejects a non-image response without displaying server content, and retry can recover", async () => {
  respond = () => new Response("<h1>private server details</h1>", { headers: { "content-type": "text/html" } });
  await showOwnerCard();
  assert.match(dialog()?.querySelector('[role="alert"]')?.textContent ?? "", /could not be loaded/);
  assert.doesNotMatch(dialog()?.textContent ?? "", /private server details/);
  assert.equal(image(), null);
  assert.equal(created.length, 0);
  respond = () => png();
  await press(buttons("Try again")[0]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.init?.signal?.aborted, true, "retry disposes the previous request");
  assert.ok(image());
  assert.equal(buttons("Print")[0]?.disabled, true);
});

it("an inaccessible trade gives a useful recovery message and no printable result", async () => {
  respond = () => json({ error: "hidden tenant details" }, 404);
  await showOwnerCard();
  assert.match(dialog()?.textContent ?? "", /no longer available in this account.*refresh your trades/s);
  assert.doesNotMatch(dialog()?.textContent ?? "", /hidden tenant details/);
  assert.equal(image(), null);
  assert.equal(download(), null);
  assert.equal(buttons("Print").length, 0);
});

it("a failed evidence check cannot become an image, while network failures explain retry", async () => {
  respond = () => json({ error: "no basis" }, 409);
  await showOwnerCard();
  assert.match(dialog()?.textContent ?? "", /verified P&L image is not available/);
  respond = () => { throw new TypeError("internal network implementation detail"); };
  await press(buttons("Try again")[0]);
  assert.match(dialog()?.textContent ?? "", /Check your connection and try again/);
  assert.doesNotMatch(dialog()?.textContent ?? "", /internal network implementation detail/);
  assert.equal(created.length, 0);
});

it("a preview decode error removes print/download and retry releases its old image", async () => {
  await showOwnerCard();
  await loadImage();
  await act(async () => { image()!.dispatchEvent(new ui.dom.window.Event("error")); });
  assert.match(dialog()?.textContent ?? "", /could not be displayed/);
  assert.equal(download(), null);
  assert.equal(buttons("Print").length, 0);
  await press(buttons("Try again")[0]);
  assert.deepEqual(revoked, ["blob:private-pnl-1"]);
  assert.equal(image()?.getAttribute("src"), "blob:private-pnl-2");
  assert.equal(buttons("Print")[0]?.disabled, true, "retry waits for its own preview load");
});

it("closing during generation aborts the fetch and ignores its late response", async () => {
  const pending = deferred<Response>();
  respond = () => pending.promise;
  await showOwnerCard();
  assert.match(dialog()?.textContent ?? "", /Creating your image/);
  await press(buttons("Close")[0]);
  assert.equal(calls[0]!.init?.signal?.aborted, true);
  await act(async () => { pending.resolve(png()); });
  assert.equal(dialog(), null);
  assert.equal(created.length, 0, "a response that ignored abort cannot resurrect private data");
});

it("a changed trade ignores a late old response and uses only the new trade's preview", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  respond = (url) => url.endsWith("=731") ? first.promise : second.promise;
  const render = (tradeId: number, symbol: string) => ui.render(createElement(PnlCardDialog, { tradeId, symbol, onClose() {} }));
  await render(731, "OLD");
  await render(732, "NEW");
  assert.equal(calls[0]!.init?.signal?.aborted, true);
  await act(async () => { second.resolve(png()); });
  await loadImage();
  await act(async () => { first.resolve(png()); });
  assert.equal(created.length, 1);
  assert.equal(download()?.download, "NEW-732-pnl.png");
  await ui.render(null);
  assert.deepEqual(revoked, ["blob:private-pnl-1"]);
  assert.equal(calls[1]!.init?.signal?.aborted, true);
});

it("a timed-out request stops waiting and offers a bounded retry", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  respond = (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  await showOwnerCard();
  await act(async () => { mock.timers.tick(20_000); });
  assert.equal(calls[0]!.init?.signal?.aborted, true);
  assert.match(dialog()?.textContent ?? "", /took too long to load/);
  assert.equal(buttons("Try again").length, 1);
  assert.equal(image(), null);
});
