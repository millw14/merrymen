// A metadata-only stub — (app)/layout.tsx mounts the terminal and ignores
// `children`. It exists so /deposit survives a refresh and a shared link.
export const metadata = { title: "Add funds — merrymen" };
export default function Page() {
  return null;
}
