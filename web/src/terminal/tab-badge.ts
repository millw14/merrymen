/**
 * THE TAB TITLE'S COUNT — "(3) merrymen" — of real-money fills that landed
 * while the tab was hidden (see arrivals.ts for what counts).
 *
 * Prefixed onto the page's own title and removed from it again, never written
 * as a fixed string: the title belongs to the route, and a badge that replaced
 * it would leave the reader's tab misnamed after they came back.
 */
const COUNT = /^\(\d+\+?\) /;

export function plainTitle(title: string): string {
  return title.replace(COUNT, "");
}

export function badgedTitle(title: string, count: number): string {
  const plain = plainTitle(title);
  if (!(count > 0)) return plain;
  return `(${count > 99 ? "99+" : Math.floor(count)}) ${plain}`;
}
