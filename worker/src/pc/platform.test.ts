import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureChainFor, hotkeyOutcome, installArgvFor, resolveToolChain, sessionType, sudoProbeArgvFor, typingChainFor, typingOfferFor, typingOutcome, typingServicePlanFor } from "./platform";

// The env surface sessionType() reads. Tests snapshot and restore it so the
// host's real session can't leak into (or out of) a case.
const SESSION_KEYS = ["XDG_SESSION_TYPE", "WAYLAND_DISPLAY", "DISPLAY"] as const;
const saved = new Map<string, string | undefined>();

function withSession(env: Record<string, string | undefined>, fn: () => void) {
  for (const k of SESSION_KEYS) saved.set(k, process.env[k]);
  for (const k of SESSION_KEYS) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of SESSION_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("sessionType — auto-detects from the environment", () => {
  it("XDG_SESSION_TYPE=wayland wins even with DISPLAY set (XWayland mixed)", () => {
    withSession({ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, () => assert.equal(sessionType(), "wayland"));
  });

  it("WAYLAND_DISPLAY alone implies wayland", () => {
    withSession({ WAYLAND_DISPLAY: "wayland-1" }, () => assert.equal(sessionType(), "wayland"));
  });

  it("XDG_SESSION_TYPE=x11 with no wayland vars means x11", () => {
    withSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, () => assert.equal(sessionType(), "x11"));
  });

  it("DISPLAY alone implies x11", () => {
    withSession({ DISPLAY: ":0" }, () => assert.equal(sessionType(), "x11"));
  });

  it("no display env at all means headless", () => {
    withSession({}, () => assert.equal(sessionType(), "headless"));
  });

  it("an unknown XDG_SESSION_TYPE falls back to the display vars", () => {
    withSession({ XDG_SESSION_TYPE: "tty", DISPLAY: ":1" }, () => assert.equal(sessionType(), "x11"));
  });
});

describe("resolveToolChain — first present tool wins, in order", () => {
  it("returns the first tool the predicate accepts", () => {
    const present = new Set(["maim", "gnome-screenshot"]);
    assert.equal(resolveToolChain(["scrot", "maim", "import"], (n) => present.has(n)), "maim");
  });

  it("returns null when nothing is present", () => {
    assert.equal(resolveToolChain(["scrot", "maim"], () => false), null);
  });

  it("respects order even when the preferred tool is absent", () => {
    const present = new Set(["import"]);
    assert.equal(resolveToolChain(["scrot", "maim", "import"], (n) => present.has(n)), "import");
  });
});

describe("sudoProbeArgvFor — probes the same binary a scoped NOPASSWD rule would whitelist", () => {
  it("pacman probes sudo -n pacman -V", () => {
    assert.deepEqual(sudoProbeArgvFor("pacman"), ["-n", "pacman", "-V"]);
  });

  it("apt-get / dnf / apk probe their --version", () => {
    assert.deepEqual(sudoProbeArgvFor("apt-get"), ["-n", "apt-get", "--version"]);
    assert.deepEqual(sudoProbeArgvFor("dnf"), ["-n", "dnf", "--version"]);
    assert.deepEqual(sudoProbeArgvFor("apk"), ["-n", "apk", "--version"]);
  });

  it("brew needs no sudo — empty argv", () => {
    assert.deepEqual(sudoProbeArgvFor("brew"), []);
  });
});

describe("installArgvFor — every package manager installs non-interactively", () => {
  it("pacman carries --noconfirm (its own prompt, not silenced by sudo -n)", () => {
    assert.deepEqual(installArgvFor("pacman", "wl-clipboard"), ["sudo", "-n", "pacman", "-S", "--needed", "--noconfirm", "wl-clipboard"]);
  });

  it("apt-get and dnf carry -y, apk add prompts never, brew needs no sudo", () => {
    assert.deepEqual(installArgvFor("apt-get", "x"), ["sudo", "-n", "apt-get", "install", "-y", "x"]);
    assert.deepEqual(installArgvFor("dnf", "x"), ["sudo", "-n", "dnf", "install", "-y", "x"]);
    assert.deepEqual(installArgvFor("apk", "x"), ["sudo", "-n", "apk", "add", "x"]);
    assert.deepEqual(installArgvFor("brew", "x"), ["brew", "install", "x"]);
  });
});

describe("captureChainFor — DE-native tool first, then session fallbacks", () => {
  const any = () => true;

  it("Wayland + wlroots compositor prefers grim, then gnome-screenshot/spectacle", () => {
    assert.deepEqual(captureChainFor(undefined, any, "wayland"), ["grim", "gnome-screenshot", "spectacle"]);
  });

  it("Wayland + GNOME prefers gnome-screenshot", () => {
    assert.deepEqual(captureChainFor("GNOME", any, "wayland"), ["gnome-screenshot", "grim", "spectacle"]);
  });

  it("Wayland + KDE prefers spectacle", () => {
    assert.deepEqual(captureChainFor("KDE", any, "wayland"), ["spectacle", "grim", "gnome-screenshot"]);
  });

  it("Wayland + GNOME but gnome-screenshot missing → keeps base order", () => {
    const onlyGrim = (n: string) => n === "grim";
    assert.deepEqual(captureChainFor("GNOME", onlyGrim, "wayland"), ["grim", "gnome-screenshot", "spectacle"]);
  });

  it("X11 chain is scrot → maim → import → gnome-screenshot regardless of DE", () => {
    assert.deepEqual(captureChainFor("GNOME", any, "x11"), ["scrot", "maim", "import", "gnome-screenshot"]);
    assert.deepEqual(captureChainFor(undefined, any, "x11"), ["scrot", "maim", "import", "gnome-screenshot"]);
  });
});

describe("typingChainFor — the desktop's native typing tool comes first", () => {
  it("Wayland + KDE/GNOME prefers ydotool (wtype can't type on KWin/mutter)", () => {
    assert.deepEqual(typingChainFor("KDE", "wayland"), ["ydotool", "wtype"]);
    assert.deepEqual(typingChainFor("plasma", "wayland"), ["ydotool", "wtype"]);
    assert.deepEqual(typingChainFor("GNOME", "wayland"), ["ydotool", "wtype"]);
  });

  it("Wayland + wlroots compositor (undefined/Sway/Hyprland) prefers wtype", () => {
    assert.deepEqual(typingChainFor(undefined, "wayland"), ["wtype", "ydotool"]);
    assert.deepEqual(typingChainFor("sway", "wayland"), ["wtype", "ydotool"]);
    assert.deepEqual(typingChainFor("Hyprland", "wayland"), ["wtype", "ydotool"]);
  });

  it("X11 uses xdotool regardless of DE", () => {
    assert.deepEqual(typingChainFor("KDE", "x11"), ["xdotool"]);
    assert.deepEqual(typingChainFor(undefined, "x11"), ["xdotool"]);
  });

  it("headless has no typing chain at all", () => {
    assert.deepEqual(typingChainFor(undefined, "headless"), []);
    assert.deepEqual(typingChainFor("KDE", "headless"), []);
  });
});

describe("typingOfferFor — only offer a tool that's genuinely missing", () => {
  const has = (...have: string[]) => (n: string) => have.includes(n);

  it("KDE chain → offers ydotool first, never the installed-but-useless wtype", () => {
    assert.equal(typingOfferFor(["ydotool", "wtype"], has("wtype")), "ydotool");
  });

  it("wlroots chain → offers wtype first", () => {
    assert.equal(typingOfferFor(["wtype", "ydotool"], has()), "wtype");
  });

  it("both installed → nothing to offer (a runtime problem, not a missing install)", () => {
    assert.equal(typingOfferFor(["wtype", "ydotool"], has("wtype", "ydotool")), null);
  });

  it("preferred missing but fallback present → still offers the preferred", () => {
    assert.equal(typingOfferFor(["ydotool", "wtype"], has("wtype")), "ydotool");
  });
});

describe("typingServicePlanFor — offer to START a down daemon, not reinstall", () => {
  it("ydotool in the chain + daemon down → user-level start plan (no sudo)", () => {
    assert.deepEqual(typingServicePlanFor(["ydotool", "wtype"], false), {
      tool: "ydotool",
      argv: ["systemctl", "--user", "enable", "--now", "ydotool"],
    });
  });

  it("daemon running → nothing to start", () => {
    assert.equal(typingServicePlanFor(["ydotool", "wtype"], true), null);
  });

  it("unknown daemon state (headless / read-fail) → no offer", () => {
    assert.equal(typingServicePlanFor(["ydotool", "wtype"], null), null);
  });

  it("chain without ydotool → no service-start for wtype", () => {
    assert.equal(typingServicePlanFor(["wtype"], false), null);
    assert.equal(typingServicePlanFor(["xdotool"], false), null);
  });
});

describe("typingOutcome — the full next-step decision after a typing chain fails", () => {
  const has = (...have: string[]) => (n: string) => have.includes(n);
  const KDE: readonly string[] = ["ydotool", "wtype"];
  const WLROOTS: readonly string[] = ["wtype", "ydotool"];
  const X11: readonly string[] = ["xdotool"];
  const DEAD = {
    chain: KDE,
    present: has("ydotool", "wtype"),
    daemonRunning: false,
  };

  it("KDE + ydotool missing → offer ydotool even though wtype is installed (the original loop bug)", () => {
    assert.deepEqual(typingOutcome({ chain: KDE, present: has("wtype"), daemonRunning: false }), {
      kind: "missing",
      tool: "ydotool",
    });
  });

  it("KDE + both installed + daemon DOWN → offer to start the daemon", () => {
    assert.deepEqual(typingOutcome(DEAD), {
      kind: "service",
      plan: { tool: "ydotool", argv: ["systemctl", "--user", "enable", "--now", "ydotool"] },
    });
  });

  it("KDE + both installed + daemon UP → plain failure (nothing to offer)", () => {
    assert.deepEqual(typingOutcome({ ...DEAD, daemonRunning: true }), { kind: "failed" });
  });

  it("KDE + both absent → offer ydotool (preferred-first)", () => {
    assert.deepEqual(typingOutcome({ chain: KDE, present: has(), daemonRunning: true }), {
      kind: "missing",
      tool: "ydotool",
    });
  });

  it("KDE + both installed + daemon UNKNOWN → plain failure, never a service offer", () => {
    assert.deepEqual(typingOutcome({ ...DEAD, daemonRunning: null }), { kind: "failed" });
  });

  it("wlroots + wtype missing → offer wtype", () => {
    assert.deepEqual(typingOutcome({ chain: WLROOTS, present: has("ydotool"), daemonRunning: false }), {
      kind: "missing",
      tool: "wtype",
    });
  });

  it("wlroots + both installed + daemon DOWN → still offer service (ydotool is the fallback)", () => {
    assert.deepEqual(
      typingOutcome({ chain: WLROOTS, present: has("wtype", "ydotool"), daemonRunning: false }),
      { kind: "service", plan: { tool: "ydotool", argv: ["systemctl", "--user", "enable", "--now", "ydotool"] } },
    );
  });

  it("wlroots + both installed + daemon UP → plain failure", () => {
    assert.deepEqual(
      typingOutcome({ chain: WLROOTS, present: has("wtype", "ydotool"), daemonRunning: true }),
      { kind: "failed" },
    );
  });

  it("X11 + xdotool missing → offer xdotool", () => {
    assert.deepEqual(typingOutcome({ chain: X11, present: has(), daemonRunning: false }), {
      kind: "missing",
      tool: "xdotool",
    });
  });

  it("X11 + xdotool installed → plain failure, NEVER a service offer", () => {
    assert.deepEqual(typingOutcome({ chain: X11, present: has("xdotool"), daemonRunning: false }), {
      kind: "failed",
    });
  });

  it("headless (empty chain) → plain failure, nothing to offer", () => {
    assert.deepEqual(typingOutcome({ chain: [], present: has(), daemonRunning: false }), { kind: "failed" });
  });
});

describe("hotkeyOutcome — never offers a tool the executor can't drive", () => {
  const has = (...have: string[]) => (n: string) => have.includes(n);
  const KDE: readonly string[] = ["ydotool", "wtype"];
  const X11: readonly string[] = ["xdotool"];

  it("KDE + only ydotool installed but wtype missing → offers wtype (the only offerable executor)", () => {
    assert.deepEqual(hotkeyOutcome({ chain: KDE, present: has("ydotool") }), { kind: "missing", tool: "wtype" });
  });

  it("KDE + ydotool AND wtype installed → plain failure (nothing missing)", () => {
    assert.deepEqual(hotkeyOutcome({ chain: KDE, present: has("ydotool", "wtype") }), { kind: "failed" });
  });

  it("KDE + only ydotool installed (wtype missing) → offers wtype, the only offerable executor", () => {
    assert.deepEqual(hotkeyOutcome({ chain: KDE, present: has("ydotool") }), { kind: "missing", tool: "wtype" });
  });

  it("X11 + xdotool missing → offer xdotool", () => {
    assert.deepEqual(hotkeyOutcome({ chain: X11, present: has() }), { kind: "missing", tool: "xdotool" });
  });

  it("X11 + xdotool installed → plain failure", () => {
    assert.deepEqual(hotkeyOutcome({ chain: X11, present: has("xdotool") }), { kind: "failed" });
  });
});
