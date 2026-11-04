// A metadata-only stub, like every route in this group: (app)/layout.tsx mounts
// the terminal and ignores `children`, and nav.ts maps /leaders to Explore's
// leaderboard. It has to exist, or the view 404s on refresh and on every link
// anybody shares.
export const metadata = { title: "Leaders — merrymen" };
export default function Page() {
  return null;
}
