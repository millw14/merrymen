// A metadata-only stub, like every route in this group: (app)/layout.tsx mounts
// the terminal and ignores `children`, and nav.ts maps /markets to Explore's
// market list. It has to exist, or the view 404s on refresh and on every link
// anybody shares.
export const metadata = { title: "Markets — merrymen" };
export default function Page() {
  return null;
}
