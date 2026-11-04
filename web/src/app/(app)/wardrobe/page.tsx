// A metadata-only stub, like every route in this group: (app)/layout.tsx mounts
// the terminal and ignores `children`, and nav.ts maps /wardrobe to the
// dressing room. It has to exist, or the screen 404s on refresh and on every
// link anybody shares.
export const metadata = { title: "Wardrobe — merrymen" };
export default function Page() {
  return null;
}
