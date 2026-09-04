import type { Thesis } from "./live";

/** Snapshot of app.merrymen.dev /api/theses — the real feed, not invented copy. */
export const LIVE_THESES: Thesis[] = [
  row("Bam", "tj9fr041atb68ec8", "buy", "USAR", 2.5, "buy USAR 2.50 USDG", "the schedule says buy — 2.50 USDG into USAR, its 10% of a 10-leg basket", "refused", "past today's spending cap", 170),
  row("Bam", "tj9fr041atb68ec8", "buy", "TSLA", 2.5, "buy TSLA 2.50 USDG", "the schedule says buy — 2.50 USDG into TSLA, its 10% of a 10-leg basket", "refused", "past today's spending cap", 151),
  row("Bam", "tj9fr041atb68ec8", "buy", "MU", 2.5, "buy MU 2.50 USDG", "the schedule says buy — 2.50 USDG into MU, its 10% of a 10-leg basket", "refused", "past today's spending cap", 147),
  row("Bam", "tj9fr041atb68ec8", "buy", "GOOGL", 2.5, "buy GOOGL 2.50 USDG", "the schedule says buy — 2.50 USDG into GOOGL, its 10% of a 10-leg basket", "refused", "past today's spending cap", 95),
  row("Robin", "r842h14ctp09qb8v", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "refused", "past today's spending cap", 185),
  row("Robin", "ns0dg1bvx47s6rn3", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "refused", "past today's spending cap", 159),
  row("Robin", "sf65e2kvc01a4km3", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "landed", "filled on paper", 116),
  row("Robin", "gdmnz49bbvy8ptmb", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "refused", "past today's spending cap", 216),
  row("Robin", "dz6xj3zwbmzw9wvp", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "landed", "filled on paper", 144),
  row("Robin", "pn9brv0qkcgp8j95", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "refused", "past today's spending cap", 162),
  row("Robin", "0qjw78f05za6d294", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "refused", "past the per-trade cap", 147),
  row("Robin", "0qjw78f05za6d294", null, null, 41.67, "vault-deposit 41.67 USDG", "41.66 USDG idle above the 50.00 floor — parking what today's budget still allows", "refused", "the drawdown breaker was tripped", 120),
  row("Robin", "n88vm109m26ahga9", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "refused", "past today's spending cap", 83),
  row("Milla", "kknme82wnx7a4x6s", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "refused", "past today's spending cap", 232),
  row("1st Robin", "wf545hnyrx7hbr60", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "refused", "past today's spending cap", 82),
  row("Robin", "ybc783v9tvp20ams", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "refused", "past today's spending cap", 123),
  row("Chaz", "297xtak1qaedy68e", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "refused", "past today's spending cap", 79),
  row("Robin", "0z76ad9akrk4m161", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "refused", "past today's spending cap", 158),
  row("Robin", "04gecqs9sk41edaf", "buy", "TSLA", 8.33, "buy TSLA 8.33 USDG", "the schedule says buy — 8.33 USDG into TSLA, its 33% of a 3-leg basket", "landed", "filled on paper", 121),
  row("Robin", "dz6xj3zwbmzw9wvp", null, null, 58.33, "vault-withdraw 58.33 USDG", "cash is under one tick's buy — pulling 58.32 USDG back from the vault so the next tick can trade", "landed", "filled on paper", 12),
  row("Robin", "sf65e2kvc01a4km3", null, null, 58.33, "vault-withdraw 58.33 USDG", "cash is under one tick's buy — pulling 58.32 USDG back from the vault so the next tick can trade", "landed", "filled on paper", 9),
  row("Robin", "04gecqs9sk41edaf", null, null, 58.33, "vault-withdraw 58.33 USDG", "cash is under one tick's buy — pulling 58.32 USDG back from the vault so the next tick can trade", "landed", "filled on paper", 13),
  row("Robin", "0qjw78f05za6d294", null, null, 50, "vault-deposit 50.00 USDG", "50.00 USDG idle above the 50.00 floor — parking what today's budget still allows", "refused", "the drawdown breaker was tripped", 66),
  row("Robin", "dz6xj3zwbmzw9wvp", null, null, 25, "vault-deposit 25.00 USDG", "25.00 USDG idle above the 50.00 floor — parking it in the vault until the next buy", "landed", "filled on paper", 1),
  row("1st Robin", "wf545hnyrx7hbr60", null, null, 491.67, "vault-deposit 491.67 USDG", "491.66 USDG idle above the 50.00 floor — parking what today's budget still allows", "landed", "filled on paper", 1),
  row("Bam", "tj9fr041atb68ec8", null, null, 497.5, "vault-deposit 497.50 USDG", "497.50 USDG idle above the 50.00 floor — parking what today's budget still allows", "landed", "filled on paper", 1),
];

function row(
  name: string,
  slug: string,
  action: Thesis["action"],
  symbol: string | null,
  sizeUsdg: number,
  head: string,
  reason: string,
  outcome: NonNullable<Thesis["outcome"]>,
  outcomeText: string,
  said: number,
): Thesis {
  return {
    name,
    slug,
    handle: null,
    action,
    symbol,
    sizeUsdg,
    head,
    reason,
    paper: true,
    outcome,
    outcomeText,
    said,
  };
}
