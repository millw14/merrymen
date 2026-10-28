/**
 * NO FLEET HANDOVER WHILE A PERPS PAPER BOOK EXISTS — decided for Perps slice
 * 4: fail closed, and say why.
 *
 * A Perps wallet's worker keeps its book at `<fleet home>/children-perps/
 * <owner>` (worker-key.ts), beside Spot's `children/` so no Spot path moves.
 * Every step of the fleet handover walks `children/` only: the roster is
 * `grants`, the source book set and the target coverage are `children/`
 * entries (ledger-handover-cli.ts), the memory backup's homes are
 * `children/` entries (memory-safeguard.ts captureFleetMemory), and the fleet
 * ledger checkpoint walks the Spot roster (ledger-safeguard.ts). A Perps
 * book would not be refused by any of them. It would be silently LEFT OUT:
 * captured by nothing, restored to nothing, and its practice money — whose
 * only other copy is the shared mirror and the checkpoint's perp_json — not
 * on the new volume at all.
 *
 * So, until the handover learns `perps_grants` and the Perps homes, every
 * mode of the handover and of the memory safeguard that would move or vouch
 * for the fleet's homes refuses while any Perps home holds a book. The
 * message names the reason and a count, never an owner: these runners print
 * public counts only.
 */
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { PERPS_CHILDREN_DIR } from "./worker-key";

/** The operator-facing refusal, with no private content in it. */
export class PerpsBooksNotHandedOver extends Error {
  constructor(readonly books: number | null) {
    super(
      `Fleet handover refused: ${books === null ? `${PERPS_CHILDREN_DIR}/ could not be read` : `${books} Perps paper book(s) under ${PERPS_CHILDREN_DIR}/`}, ` +
        "and Perps paper books are not covered by the fleet handover yet. Keep this deployment and its volume as they are; " +
        "no handover, memory capture or fleet checkpoint runs while a Perps paper book exists. No private content was logged.",
    );
    this.name = "PerpsBooksNotHandedOver";
  }
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Throws PerpsBooksNotHandedOver while `<home>/children-perps` holds a
 * `merrymen.db` in any of its homes. No Perps root at all is the fleet as it
 * has always been, and passes. Anything that cannot be read — the root, an
 * entry, a book's lstat — is counted as a book or refuses outright, never
 * read as absence.
 */
export function refuseWhilePerpsBooks(home: string): void {
  const root = path.join(home, PERPS_CHILDREN_DIR);
  let names: string[];
  try {
    if (!lstatSync(root).isDirectory()) throw new PerpsBooksNotHandedOver(null);
    names = readdirSync(root);
  } catch (e) {
    if (e instanceof PerpsBooksNotHandedOver) throw e;
    if (missing(e)) return;
    throw new PerpsBooksNotHandedOver(null);
  }
  let books = 0;
  for (const name of names) {
    try {
      lstatSync(path.join(root, name, "merrymen.db"));
      books++;
    } catch (e) {
      // Not there, or an entry that is not a directory and so holds nothing.
      if (!missing(e) && (e as NodeJS.ErrnoException).code !== "ENOTDIR") books++;
    }
  }
  if (books > 0) throw new PerpsBooksNotHandedOver(books);
}
