// A metadata-only stub, like every route in this group: (app)/layout.tsx mounts
// the terminal and ignores `children`, and the terminal draws the room from the
// path (nav.ts maps /groupchat to the `groupchat` screen).
//
// IT STILL HAS TO EXIST. Without it /groupchat works when you tap the entry and
// 404s on refresh and on every link anybody shares — the one failure a
// click-through never finds.
export const metadata = { title: "Group chat — merrymen" };
export default function Page() {
  return null;
}
