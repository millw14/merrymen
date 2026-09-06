import { App } from "@/terminal/App";
import { Providers } from "@/terminal/Providers";

// The whole terminal mounts here and nowhere else, so this is the one place a
// provider has to sit for every screen to be inside it. Still a SERVER
// component — it imports a client module and passes a client element as
// children, which does not make this file client code.
export default function AppLayout() {
  return (
    <Providers>
      <App />
    </Providers>
  );
}
