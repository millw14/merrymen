// A metadata-only stub, like every route in this group: (app)/layout.tsx mounts
// the terminal and ignores `children`.
//
// IT STILL HAS TO EXIST. Without it /alpha works when you tap the tab and 404s
// on refresh and on every link anybody shares — the one failure a click-through
// never finds.
export const metadata = { title: "Alpha — merrymen" };
export default function Page() {
  return null;
}
