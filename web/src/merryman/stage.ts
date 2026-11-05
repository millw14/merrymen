/**
 * ONE MERRYMAN ON ONE CANVAS: renderer, lights, island, mixer, effects, input.
 *
 * Imported only through a dynamic import() from Merryman.tsx, so three.js is a
 * separate chunk that a page pays for only when it actually shows a merryman,
 * and never on the server.
 *
 * THE MIXER. A base loop (the mood: napping, scouting, dancing) plays forever
 * and crossfades when the mood changes; one-shots (a wave, an arrow, a
 * backflip) play over it with their own fade and hand back. While the base is
 * a calm one, the stage picks a fidget every several seconds, so a merryman
 * left on screen keeps finding something to do. Blinks, breath and the gaze
 * that follows your pointer are layered on top of whatever is playing.
 *
 * IT STOPS WHEN NOBODY IS LOOKING. Off screen, in a background tab, or with
 * the page hidden, the loop is not scheduled at all.
 */
import {
  AdditiveBlending,
  AmbientLight,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  DoubleSide,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  PlaneGeometry,
  Raycaster,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  type CanvasTexture,
  type Material,
} from "three";
import { CALM_BASES, CALM_SHOTS, CALM_STAND_IN, CLIPS, FIDGETS, FIDGETY_BASES, clipOf, type Clip, type Fx } from "./clips";
import { DEFAULT_OUTFIT, outfitKey, type Outfit } from "./outfit";
import { blendPose, copyPose, restPose, smooth, type Pose } from "./pose";
import { buildIsland } from "./island";
import { applyPose, buildRig, createKit, glyphTexture, type Kit, type Rig } from "./rig";

export type Framing = "full" | "portrait" | "wide";

export type StageOptions = {
  outfit?: Outfit;
  base?: string;
  framing?: Framing;
  interactive?: boolean;
  ground?: boolean;
  /** Fidgets and ambient effects. Off under prefers-reduced-motion. */
  lively?: boolean;
  seed?: number;
  onTap?: () => void;
  onLost?: () => void;
};

export type Stage = {
  setOutfit(o: Outfit): void;
  setBase(id: string): void;
  play(id: string): void;
  setFraming(f: Framing): void;
  setLively(on: boolean): void;
  snapshot(): string | null;
  dispose(): void;
};

const FRAMES: Record<Framing, { look: [number, number, number]; eye: [number, number, number]; fov: number }> = {
  // Headroom above the hat for his speech bubble and the effects that rise.
  full: { look: [0, 1.02, 0], eye: [0, 1.18, 5.3], fov: 30 },
  portrait: { look: [0, 1.28, 0], eye: [0, 1.36, 2.25], fov: 30 },
  wide: { look: [0.15, 0.8, 0], eye: [0, 1.15, 5.8], fov: 30 },
};

type Particle = {
  obj: Object3D;
  vel: Vector3;
  spin: number;
  age: number;
  life: number;
  gravity: number;
  drag: number;
  grow: number;
  wobble: number;
  baseScale: number;
  mat?: Material & { opacity: number };
  orbit?: { center: Vector3; r: number; speed: number; phase: number };
};

const CONFETTI = ["#ffd34a", "#ff5d73", "#4fd1ff", "#7cf29a", "#c38bff", "#ff9a3c"];

export function createStage(host: HTMLElement, opts: StageOptions = {}): Stage {
  const canvas = document.createElement("canvas");
  canvas.className = "mm-stage-canvas";
  host.appendChild(canvas);
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "default", preserveDrawingBuffer: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.1, 60);
  let framing: Framing = opts.framing ?? "full";
  const frame = () => {
    const f = FRAMES[framing];
    camera.fov = f.fov;
    camera.position.set(...f.eye);
    camera.lookAt(new Vector3(...f.look));
    camera.updateProjectionMatrix();
  };
  frame();

  scene.add(new HemisphereLight(new Color("#fff1d6"), new Color("#1d2a20"), 1.15));
  scene.add(new AmbientLight(new Color("#ffffff"), 0.25));
  const key = new DirectionalLight(new Color("#fff4e0"), 2.1);
  key.position.set(2.2, 4, 3.5);
  scene.add(key);
  const rim = new DirectionalLight(new Color("#6fd6ff"), 1.4);
  rim.position.set(-3, 2.5, -3);
  scene.add(rim);
  const warm = new DirectionalLight(new Color("#ffb066"), 0.6);
  warm.position.set(3, 0.5, -2);
  scene.add(warm);

  const kit: Kit = createKit();
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(d: T) => (disposables.push(d), d);

  // ── the island (island.ts) ──
  const groundOn = opts.ground !== false;
  const island = track(buildIsland(kit));
  island.group.visible = groundOn;
  scene.add(island.group);
  // blob shadow
  const shadowTex = glyphTexture("glow", "rgba(0,0,0,0.55)", 128);
  if (shadowTex) track(shadowTex);
  const shadowMat = new MeshBasicMaterial({ map: shadowTex ?? undefined, transparent: true, depthWrite: false, color: new Color("#000000"), opacity: 0.55 });
  track(shadowMat);
  const shadow = new Mesh(track(new PlaneGeometry(0.9, 0.9)), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  scene.add(shadow);

  // ── the merryman ──
  let outfit = opts.outfit ?? DEFAULT_OUTFIT;
  let rig: Rig = buildRig(outfit, kit);
  scene.add(rig.object);

  // ── textures for effects ──
  const tex = new Map<string, CanvasTexture | null>();
  const glyph = (text: string, color: string) => {
    const k = `${text}:${color}`;
    if (!tex.has(k)) {
      const t = glyphTexture(text, color);
      if (t) track(t);
      tex.set(k, t);
    }
    return tex.get(k) ?? null;
  };

  // ── particles ──
  const particles: Particle[] = [];
  const fxRoot = new Group();
  scene.add(fxRoot);
  const confettiGeo = track(new PlaneGeometry(0.05, 0.03));
  const coinGeo = track(new CylinderGeometry(0.05, 0.05, 0.012, 16));
  const leafGeo = track(new CircleGeometry(0.035, 5));
  const puffGeo = track(new SphereGeometry(0.08, 10, 8));
  const arrowGeo = track(new CylinderGeometry(0.008, 0.008, 0.6, 5));
  const arrowTipGeo = track(new ConeGeometry(0.02, 0.07, 6));
  const shieldGeo = track(new SphereGeometry(0.9, 24, 16));

  const headWorld = () => rig.head.getWorldPosition(new Vector3());
  const spawn = (obj: Object3D, init: Partial<Particle>) => {
    fxRoot.add(obj);
    particles.push({
      obj, vel: new Vector3(), spin: 0, age: 0, life: 1, gravity: 0, drag: 0, grow: 0, wobble: 0, baseScale: obj.scale.x,
      ...init,
    });
  };
  const sprite = (text: string, color: string, size: number, additive = false) => {
    const map = glyph(text, color);
    const mat = new SpriteMaterial({ map: map ?? undefined, transparent: true, depthWrite: false, blending: additive ? AdditiveBlending : undefined });
    const s = new Sprite(mat);
    s.scale.setScalar(size);
    return { s, mat };
  };
  const rand = (a: number, b: number) => a + Math.random() * (b - a);

  function fx(kind: Fx) {
    if (!lively && kind !== "arrow") return;
    const head = headWorld();
    switch (kind) {
      case "confetti":
        for (let i = 0; i < 46; i++) {
          const mat = new MeshBasicMaterial({ color: new Color(CONFETTI[i % CONFETTI.length]!), side: DoubleSide, transparent: true });
          const m = new Mesh(confettiGeo, mat);
          m.position.copy(head).add(new Vector3(rand(-0.15, 0.15), 0.25, rand(-0.1, 0.1)));
          m.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
          spawn(m, { vel: new Vector3(rand(-1.6, 1.6), rand(1.8, 3.4), rand(-0.8, 1.2)), spin: rand(-12, 12), life: rand(1.6, 2.4), gravity: 4.2, drag: 1.6, wobble: 3, mat });
        }
        break;
      case "arrow": {
        const g = new Group();
        const shaft = new Mesh(arrowGeo, kit.toon("#8a5a2e"));
        const tip = new Mesh(arrowTipGeo, kit.toon("#b9c2cc"));
        tip.position.y = 0.33;
        g.add(shaft, tip);
        const from = rig.handL.getWorldPosition(new Vector3());
        const dir = new Vector3(0, -1, 0).applyQuaternion(rig.handL.getWorldQuaternion(new Quaternion())).normalize();
        g.position.copy(from);
        g.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
        spawn(g, { vel: dir.multiplyScalar(9), life: 0.7 });
        for (let i = 0; i < 6; i++) {
          const { s, mat } = sprite("glow", "rgba(255,240,200,0.9)", 0.12, true);
          s.position.copy(from);
          spawn(s, { vel: new Vector3(rand(-0.5, 0.5), rand(-0.2, 0.6), rand(-0.5, 0.5)), life: 0.45, grow: 1.5, mat });
        }
        break;
      }
      case "coin":
      case "coins": {
        const n = kind === "coin" ? 1 : 12;
        for (let i = 0; i < n; i++) {
          const m = new Mesh(coinGeo, kit.toon("#e3b341", { emissive: "#6b4a10", emissiveIntensity: 0.5 }));
          m.position.copy(head).add(new Vector3(rand(-0.1, 0.1), 0.2, 0.1));
          m.rotation.x = Math.PI / 2;
          spawn(m, { vel: new Vector3(rand(-1.2, 1.2), rand(1.5, 3), rand(0, 1)), spin: rand(8, 16), life: 1.4, gravity: 6 });
        }
        break;
      }
      case "z": {
        const { s, mat } = sprite(Math.random() < 0.5 ? "Z" : "z", "#cfe6ff", rand(0.14, 0.2));
        s.position.copy(head).add(new Vector3(0.22, 0.25, 0));
        spawn(s, { vel: new Vector3(0.18, 0.32, 0), life: 2.2, wobble: 2, grow: 0.6, mat });
        break;
      }
      case "question":
      case "exclaim": {
        const { s, mat } = sprite(kind === "question" ? "?" : "!", kind === "question" ? "#ffe27a" : "#ff6b6b", 0.24);
        s.position.copy(head).add(new Vector3(0.28, 0.32, 0));
        spawn(s, { vel: new Vector3(0, 0.25, 0), life: 1.3, grow: 0.3, mat });
        break;
      }
      case "note": {
        const { s, mat } = sprite(Math.random() < 0.5 ? "♪" : "♫", CONFETTI[Math.floor(rand(0, CONFETTI.length))]!, 0.2);
        s.position.copy(head).add(new Vector3(rand(-0.35, 0.35), 0.1, 0));
        spawn(s, { vel: new Vector3(rand(-0.15, 0.15), 0.45, 0), life: 1.6, wobble: 3, mat });
        break;
      }
      case "drop": {
        const { s, mat } = sprite("💧", "#8fd3ff", 0.14);
        s.position.copy(head).add(new Vector3(0.22, 0.12, 0.1));
        spawn(s, { vel: new Vector3(0.12, -0.05, 0), life: 1.1, gravity: 0.8, mat });
        break;
      }
      case "heart": {
        for (let i = 0; i < 3; i++) {
          const { s, mat } = sprite("♥", "#ff5d8a", 0.16);
          s.position.copy(head).add(new Vector3(rand(-0.2, 0.2), 0.25, 0.1));
          spawn(s, { vel: new Vector3(rand(-0.2, 0.2), rand(0.4, 0.6), 0), life: 1.4, wobble: 2, mat });
        }
        break;
      }
      case "stars":
        for (let i = 0; i < 4; i++) {
          const { s, mat } = sprite("★", "#ffe27a", 0.12);
          const center = head.clone().add(new Vector3(0, 0.3, 0));
          s.position.copy(center);
          spawn(s, { life: 1.2, mat, orbit: { center, r: 0.24, speed: 5, phase: (i / 4) * Math.PI * 2 } });
        }
        break;
      case "spark":
      case "sparkles": {
        const n = kind === "spark" ? 5 : 10;
        const at = kind === "spark" ? rig.handR.getWorldPosition(new Vector3()) : head.clone().add(new Vector3(0, -0.4, 0));
        for (let i = 0; i < n; i++) {
          const { s, mat } = sprite("✦", i % 2 ? "#fff3b0" : "#ffffff", rand(0.06, 0.12), true);
          s.position.copy(at).add(new Vector3(rand(-0.4, 0.4), rand(-0.3, 0.5), rand(-0.1, 0.3)));
          spawn(s, { vel: new Vector3(rand(-0.3, 0.3), rand(0.1, 0.5), 0), life: rand(0.6, 1.1), grow: -0.5, mat });
        }
        break;
      }
      case "puff":
        for (let i = 0; i < 7; i++) {
          const mat = new MeshBasicMaterial({ color: new Color("#f4f1ea"), transparent: true, opacity: 0.85, depthWrite: false });
          const m = new Mesh(puffGeo, mat);
          m.position.copy(head).add(new Vector3(0, -0.15, 0.3));
          spawn(m, { vel: new Vector3(rand(-0.6, 0.6), rand(-0.2, 0.4), rand(0.4, 1)), life: 0.7, grow: 2, drag: 3, mat });
        }
        break;
      case "shield": {
        const mat = new MeshBasicMaterial({ color: new Color("#6fd6ff"), transparent: true, opacity: 0.25, depthWrite: false, blending: AdditiveBlending });
        const m = new Mesh(shieldGeo, mat);
        m.position.set(0, 0.85, 0);
        spawn(m, { life: 0.9, grow: 0.15, mat });
        break;
      }
    }
  }

  // ── ambient aura ──
  let auraClock = 0;
  function aura(dt: number) {
    if (!lively || rig.outfit.aura === "none") return;
    auraClock += dt;
    const every = rig.outfit.aura === "fireflies" ? 0.45 : rig.outfit.aura === "coins" ? 0.9 : 0.35;
    while (auraClock > every) {
      auraClock -= every;
      const a = Math.random() * Math.PI * 2;
      const r = rand(0.45, 1.0);
      const at = new Vector3(Math.cos(a) * r, rand(0.2, 1.6), Math.sin(a) * r * 0.6);
      switch (rig.outfit.aura) {
        case "fireflies": {
          const { s, mat } = sprite("glow", "rgba(214,255,120,1)", rand(0.06, 0.1), true);
          s.position.copy(at);
          spawn(s, { vel: new Vector3(rand(-0.08, 0.08), rand(0.02, 0.1), rand(-0.05, 0.05)), life: rand(2.5, 4), wobble: 1.2, mat });
          break;
        }
        case "sparkles": {
          const { s, mat } = sprite("✦", "#ffffff", rand(0.05, 0.09), true);
          s.position.copy(at);
          spawn(s, { life: rand(0.8, 1.4), grow: -0.4, mat });
          break;
        }
        case "embers": {
          const { s, mat } = sprite("glow", "rgba(255,140,60,1)", rand(0.04, 0.08), true);
          s.position.set(at.x * 0.6, 0.05, at.z * 0.6);
          spawn(s, { vel: new Vector3(rand(-0.05, 0.05), rand(0.35, 0.6), 0), life: rand(1.6, 2.4), wobble: 2, mat });
          break;
        }
        case "leaves": {
          const mat = new MeshBasicMaterial({ color: new Color(Math.random() < 0.5 ? "#7ccf6a" : "#d9a032"), side: DoubleSide, transparent: true });
          const m = new Mesh(leafGeo, mat);
          m.position.set(at.x, 2.0, at.z);
          spawn(m, { vel: new Vector3(rand(-0.1, 0.1), -0.35, 0), spin: rand(-3, 3), life: 4, wobble: 2.5, mat });
          break;
        }
        case "coins": {
          const m = new Mesh(coinGeo, kit.toon("#e3b341", { emissive: "#6b4a10", emissiveIntensity: 0.5 }));
          m.position.set(at.x, 2.0, at.z);
          m.rotation.x = Math.PI / 2;
          spawn(m, { vel: new Vector3(0, -0.6, 0), spin: rand(4, 9), life: 3.2 });
          break;
        }
      }
    }
  }

  function stepParticles(dt: number) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        p.obj.removeFromParent();
        // `mat` is only ever a material this particle owns (shared kit
        // materials are never passed as `mat`), so it is safe to free.
        p.mat?.dispose();
        particles.splice(i, 1);
        continue;
      }
      if (p.orbit) {
        const a = p.orbit.phase + p.age * p.orbit.speed;
        p.obj.position.set(p.orbit.center.x + Math.cos(a) * p.orbit.r, p.orbit.center.y + Math.sin(a * 2) * 0.03, p.orbit.center.z + Math.sin(a) * p.orbit.r * 0.5);
      } else {
        p.vel.y -= p.gravity * dt;
        if (p.drag) p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
        p.obj.position.addScaledVector(p.vel, dt);
        if (p.wobble) p.obj.position.x += Math.sin(p.age * p.wobble * 3 + i) * 0.004 * p.wobble;
      }
      if (p.spin) {
        p.obj.rotation.x += p.spin * dt;
        p.obj.rotation.y += p.spin * dt * 0.6;
      }
      if (p.grow) p.obj.scale.setScalar(Math.max(0.001, p.baseScale * (1 + p.grow * k)));
      if (p.mat) p.mat.opacity = k < 0.15 ? k / 0.15 : k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    }
  }

  // ── the mixer ──
  const seed = opts.seed ?? Math.random() * 10;
  let lively = opts.lively !== false;
  let base: Clip = clipOf(lively || CALM_BASES.has(opts.base ?? "idle") ? opts.base ?? "idle" : "idle");
  let baseAt = 0;
  let prevBase: Clip | null = null;
  let prevBaseAt = 0;
  let fadeAt = -10;
  let shot: Clip | null = null;
  let shotAt = 0;
  const queue: string[] = [];
  let nextFidget = 4 + Math.random() * 5;
  let nextBlink = 2 + Math.random() * 3;
  let blinkAt = -1;
  let lastEmit = 0;
  let firedCues = new Set<number>();
  const pose = restPose();
  const scratch = restPose();
  const scratch2 = restPose();
  let clock = 0;

  /**
   * REDUCE MOTION MEANS HE STAYS PUT. With the OS setting on (lively false)
   * the bouncy, sweeping and dancing loops become the quiet idle, and the
   * jumps, spins and flips become a nod or a thumbs-up in place: the reading
   * still comes through, without whole-body motion nobody asked for. The
   * requested mood is remembered so turning the setting off restores it.
   */
  let wantedBase = opts.base ?? "idle";
  const calmBase = (id: string) => (lively || CALM_BASES.has(id) ? id : "idle");
  const calmShot = (id: string) => (lively || CALM_SHOTS.has(id) ? id : CALM_STAND_IN[id] ?? "nodYes");
  function setBase(id: string) {
    wantedBase = id;
    const next = clipOf(calmBase(id));
    if (next.id === base.id) return;
    prevBase = base;
    prevBaseAt = baseAt;
    fadeAt = clock;
    base = next;
    baseAt = clock;
    lastEmit = clock;
  }
  function play(id: string) {
    const asked = clipOf(id);
    if (asked.loop) { setBase(asked.id); return; }
    const c = clipOf(calmShot(asked.id));
    if (shot) { if (queue.length < 3) queue.push(c.id); return; }
    shot = c;
    shotAt = clock;
    firedCues = new Set();
  }

  // ── input: gaze, drag to spin, tap to poke ──
  const pointer = new Vector2(0, 0);
  const gaze = { x: 0, y: 0, tx: 0, ty: 0 };
  let yaw = 0;
  let yawVel = 0;
  let dragging = false;
  let dragMoved = 0;
  let lastX = 0;
  let lastInput = -10;
  let taps: number[] = [];
  let petReact = 0;
  const raycaster = new Raycaster();
  const interactive = opts.interactive !== false;
  const pointers = new Set<number>();
  const onMove = (e: PointerEvent) => {
    // Gaze is irrelevant while the loop is paused; don't force a layout read
    // on every pointer move anywhere on the page for a stage nobody sees.
    if (!dragging && raf === 0) return;
    const r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
    gaze.tx = Math.max(-1, Math.min(1, pointer.x * 1.4));
    gaze.ty = Math.max(-1, Math.min(1, pointer.y * 1.2 - 0.2));
    lastInput = clock;
    if (dragging) {
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      dragMoved += Math.abs(dx);
      yawVel = dx * 0.012;
      yaw += yawVel;
    }
  };
  const onDown = (e: PointerEvent) => {
    pointers.add(e.pointerId);
    // A second finger is a pinch, not a spin: let the browser zoom.
    if (pointers.size > 1) { dragging = false; yawVel = 0; return; }
    dragging = true;
    dragMoved = 0;
    lastX = e.clientX;
    canvas.setPointerCapture?.(e.pointerId);
  };
  const onUp = (e: PointerEvent) => {
    const multi = pointers.size > 1;
    pointers.delete(e.pointerId);
    if (multi) return;
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
    if (dragMoved > 6) return;
    const r = canvas.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(rig.hitMeshes, false)[0];
    if (!hit) return;
    taps = taps.filter((t) => clock - t < 1.6);
    taps.push(clock);
    const onPet = rig.pet && hit.object.parent && isUnder(hit.object, rig.pet.group);
    if (onPet) { petReact = 1; opts.onTap?.(); return; }
    const reaction = taps.length >= 4 ? "dizzy" : (["hop", "giggle", "wave", "surprised", "spin", "hatTip", "thumbsUp"] as const)[Math.floor(Math.random() * 7)]!;
    if (taps.length >= 4) taps = [];
    if (!shot || shot.id === "hop") { shot = null; play(reaction); }
    opts.onTap?.();
  };
  const onLeave = () => { gaze.tx = 0; gaze.ty = 0; };
  // A phone that decides the gesture was a vertical scroll (touch-action:
  // pan-y) sends pointercancel, never pointerup. Without this the drag never
  // ended, and every later pointer move anywhere on the page spun him.
  const onCancel = (e: PointerEvent) => { pointers.delete(e.pointerId); dragging = false; yawVel = 0; };
  if (interactive) {
    // Pointer moves come through the window listener alone: captured canvas
    // events reach it too, and handling each twice zeroed the spin's inertia.
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointercancel", onCancel);
    window.addEventListener("pointermove", onMove, { passive: true });
  }

  function isUnder(o: Object3D, ancestor: Object3D) {
    for (let x: Object3D | null = o; x; x = x.parent) if (x === ancestor) return true;
    return false;
  }

  // ── sizing and visibility ──
  let visible = true;
  let lost = false;
  let raf = 0;
  let last = performance.now();
  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  ro?.observe(host);
  resize();
  // The observer's word is trusted when it says "on screen"; when it says
  // "off", the box is measured too, because an entry computed while the page
  // was in the background can report a visible element as hidden and nothing
  // would ever ask again until the next scroll.
  const onScreen = () => {
    const r = host.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth && r.width > 0;
  };
  const io = typeof IntersectionObserver !== "undefined"
    ? new IntersectionObserver((entries) => { visible = entries.some((e) => e.isIntersecting) || onScreen(); schedule(); }, { rootMargin: "120px" })
    : null;
  io?.observe(host);
  const onVis = () => { if (document.visibilityState === "visible") visible = visible || onScreen(); schedule(); };
  document.addEventListener("visibilitychange", onVis);
  // A lost context ends this stage for good: the host falls back to the flat
  // figure and disposes us. Restarting on a later visibility change would draw
  // a second merryman under the flat one.
  const onLost = (e: Event) => { e.preventDefault(); lost = true; cancelAnimationFrame(raf); raf = 0; opts.onLost?.(); };
  canvas.addEventListener("webglcontextlost", onLost);

  function schedule() {
    const run = !lost && visible && document.visibilityState !== "hidden";
    if (run && !raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
    if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function tick(now: number) {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    clock += dt;
    step(dt);
    renderer.render(scene, camera);
    schedule();
  }

  function sampleInto(into: Pose, c: Clip, t: number) {
    copyPose(into, REST);
    const local = c.loop ? t % c.duration : Math.min(t, c.duration);
    c.sample(into, local, seed);
  }

  function step(dt: number) {
    // base, crossfading from the previous base
    const bt = clock - baseAt;
    sampleInto(pose, base, bt);
    const fade = smooth((clock - fadeAt) / 0.45);
    if (prevBase && fade < 1) {
      sampleInto(scratch, prevBase, clock - prevBaseAt);
      blendPose(scratch, pose, fade);
      copyPose(pose, scratch);
    } else prevBase = null;

    // loop effects
    if (base.emit && lively) {
      const every = base.emit.every;
      const phase = bt - (base.emit.offset ?? 0);
      if (phase > 0 && Math.floor(phase / every) !== Math.floor((clock - dt - baseAt - (base.emit.offset ?? 0)) / every)) fx(base.emit.fx);
    }

    // the one-shot over it
    let reacting = petReact;
    if (shot) {
      const st = clock - shotAt;
      if (st >= shot.duration) {
        shot = null;
        const next = queue.shift();
        if (next) play(next);
      } else {
        sampleInto(scratch2, shot, st);
        const w = Math.min(smooth(st / 0.16), 1 - smooth((st - (shot.duration - 0.22)) / 0.22));
        blendPose(pose, scratch2, w);
        shot.cues?.forEach((c, i) => {
          if (st >= c.at && !firedCues.has(i)) { firedCues.add(i); fx(c.fx); }
        });
        if (shot.id === "celebrate" || shot.id === "jump" || shot.id === "backflip") reacting = 1;
      }
    }
    petReact = Math.max(0, petReact - dt * 0.8);

    // fidgets while calm
    if (lively && !shot && FIDGETY_BASES.has(base.id) && clock > nextFidget) {
      const options = FIDGETS.filter((f) => f !== "coinToss" || rig.outfit.held === "coinbag" || rig.outfit.held === "none");
      play(options[Math.floor(Math.random() * options.length)]!);
      nextFidget = clock + 7 + Math.random() * 7;
    }

    // one blink every few seconds, unless the clip already has the eyes shut
    if (clock > nextBlink) {
      blinkAt = clock;
      nextBlink = clock + 2.2 + Math.random() * 3.5;
    }
    const sinceBlink = clock - blinkAt;
    if (blinkAt >= 0 && sinceBlink < 0.15 && pose.blink < 0.5) pose.blink = Math.max(pose.blink, Math.sin((sinceBlink / 0.15) * Math.PI));

    // gaze follows the pointer, gently, and drifts home when it leaves
    if (clock - lastInput > 3) { gaze.tx *= 0.98; gaze.ty *= 0.98; }
    gaze.x += (gaze.tx - gaze.x) * Math.min(1, dt * 5);
    gaze.y += (gaze.ty - gaze.y) * Math.min(1, dt * 5);
    const sleeping = pose.blink > 0.95;
    if (!sleeping) {
      pose.turn += gaze.x * 0.35;
      pose.nod -= gaze.y * 0.18;
      pose.lookX += gaze.x * 0.6;
      pose.lookY += gaze.y * 0.6;
    }

    // drag spin with inertia, settling back to face the viewer
    if (!dragging) {
      yaw += yawVel;
      yawVel *= 0.92;
      if (Math.abs(yawVel) < 0.002 && clock - lastInput > 2.5) yaw += (Math.round(yaw / (Math.PI * 2)) * Math.PI * 2 - yaw) * Math.min(1, dt * 2.5);
    }

    applyPose(rig, pose, clock, yaw, reacting);
    if (groundOn) island.update(clock);
    const s = Math.max(0.45, 1 - pose.rootY * 0.9);
    shadow.scale.set(s, s, s);
    shadow.position.x = pose.rootX;
    shadowMat.opacity = 0.5 * s;
    aura(dt);
    stepParticles(dt);
  }
  const REST = restPose();

  schedule();

  return {
    setOutfit(o: Outfit) {
      if (outfitKey(o) === outfitKey(outfit)) return;
      outfit = o;
      rig.dispose();
      rig = buildRig(o, kit);
      scene.add(rig.object);
    },
    setBase,
    play,
    setFraming(f: Framing) {
      framing = f;
      frame();
    },
    setLively(on: boolean) {
      lively = on;
      const wanted = wantedBase;
      setBase(wanted);
    },
    snapshot() {
      renderer.render(scene, camera);
      try { return canvas.toDataURL("image/png"); } catch { return null; }
    },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("webglcontextlost", onLost);
      if (interactive) {
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("pointerleave", onLeave);
        canvas.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("pointermove", onMove);
      }
      for (const p of particles) { p.obj.removeFromParent(); p.mat?.dispose(); }
      particles.length = 0;
      rig.dispose();
      kit.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
  };
}

/** Every clip id, for tests and the emote list. */
export const CLIP_IDS = CLIPS.map((c) => c.id);

// ── portraits: one shared offscreen renderer for every small face ─────────

let portraitStage: { renderer: WebGLRenderer; scene: Scene; camera: PerspectiveCamera; kit: Kit; rig: Rig | null } | null = null;
const portraitCache = new Map<string, string>();

/**
 * A still of a merryman's head and shoulders, as a data URL, for lists where a
 * live canvas per row would exhaust the browser's WebGL contexts. Cached per
 * exact outfit, so a leaderboard of 16 costs 16 renders once per visit.
 */
export function portraitOf(outfit: Outfit, size = 160): string | null {
  const key = `${outfitKey(outfit)}@${size}`;
  const hit = portraitCache.get(key);
  if (hit) return hit;
  try {
    if (!portraitStage) {
      const canvas = document.createElement("canvas");
      const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.setClearColor(0x000000, 0);
      const scene = new Scene();
      scene.add(new HemisphereLight(new Color("#fff1d6"), new Color("#1d2a20"), 1.2));
      const k = new DirectionalLight(new Color("#fff4e0"), 2.1);
      k.position.set(2.2, 4, 3.5);
      scene.add(k);
      const r = new DirectionalLight(new Color("#6fd6ff"), 1.3);
      r.position.set(-3, 2.5, -3);
      scene.add(r);
      const camera = new PerspectiveCamera(28, 1, 0.1, 20);
      camera.position.set(0, 1.4, 2.1);
      camera.lookAt(new Vector3(0, 1.3, 0));
      portraitStage = { renderer, scene, camera, kit: createKit(0.014), rig: null };
    }
    const ps = portraitStage;
    if (ps.renderer.getContext().isContextLost()) {
      ps.renderer.dispose();
      ps.kit.dispose();
      portraitStage = null;
      return null;
    }
    ps.renderer.setPixelRatio(1);
    ps.renderer.setSize(size, size, false);
    ps.rig?.dispose();
    const rig = buildRig({ ...outfit, pet: "none" }, ps.kit);
    ps.scene.add(rig.object);
    ps.rig = rig;
    const p = restPose();
    p.smile = 0.6;
    p.lFwd = 0.05; p.rFwd = 0.05; p.lOut = 0.15; p.rOut = 0.15;
    p.turn = 0.25;
    p.tilt = -0.05;
    applyPose(rig, p, 0);
    ps.renderer.render(ps.scene, ps.camera);
    const url = ps.renderer.domElement.toDataURL("image/png");
    portraitCache.set(key, url);
    return url;
  } catch {
    return null;
  }
}
