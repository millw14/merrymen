import { App } from "@/terminal/App";
import { Providers } from "@/terminal/Providers";
import { OnboardWizard } from "@/components/OnboardWizard";

// The whole terminal mounts here and nowhere else, so this is the one place a
// provider has to sit for every screen to be inside it. Still a SERVER
// component — it imports a client module and passes a client element as
// children, which does not make this file client code.
//
// The first-run wizard mounts here (it used to live on the old dashboard root,
// which no longer renders anything). It gates itself on !webOnboarded and never
// re-shows after finish/skip, so on configured installs this renders nothing.
export default function AppLayout() {
  return (
    <Providers>
      <App />
      <OnboardWizard />
    </Providers>
  );
}
