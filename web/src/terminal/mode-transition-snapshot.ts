export type FrozenModeScene = {
  element: HTMLElement;
  /** Apply after insertion: detached elements cannot retain a clamped scroll offset. */
  restoreScroll: () => void;
  /** Remove the private visual copy and release its pixels and retained node references. */
  dispose: () => void;
};

let nextScene = 0;
const OMIT = new Set(["SCRIPT", "STYLE", "LINK", "META", "BASE", "IFRAME", "OBJECT", "EMBED", "AUDIO", "VIDEO", "SOURCE", "TRACK", "ANIMATE", "ANIMATETRANSFORM", "ANIMATEMOTION", "SET"]);
const ACTION_ATTRIBUTES = new Set(["autofocus", "autoplay", "action", "formaction", "form", "name", "ping", "download", "target", "srcdoc", "nonce", "popover", "popovertarget", "popovertargetaction"]);
const VISUAL_ARIA = new Set(["aria-pressed", "aria-selected", "aria-current", "aria-expanded", "aria-checked", "aria-disabled", "aria-invalid", "aria-busy"]);
const INHERITED = ["color", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-transform", "direction", "writing-mode", "color-scheme"];
const IMAGE_STYLE = ["display", "width", "height", "max-width", "max-height", "min-width", "min-height", "border-radius", "object-fit", "object-position", "vertical-align", "opacity"];

/**
 * An in-memory, inert picture of this owner's current screen. No second React
 * tree, event handlers, requests, or account readers are mounted. The caller
 * owns its short lifetime and must dispose it on owner changes as well as exit.
 */
export function freezeModeScene(source: HTMLElement): FrozenModeScene {
  const doc = source.ownerDocument;
  const view = doc.defaultView;
  if (!view) throw new Error("A mode scene needs a browser document");
  const prefix = `mm-frozen-${++nextScene}-`;
  const ids = new Map<string, string>();
  for (const node of [source, ...source.querySelectorAll("[id]")]) {
    if (node.id && !ids.has(node.id)) ids.set(node.id, `${prefix}${ids.size}`);
  }
  const remap = (value: string) => value.replace(/url\(\s*(["']?)#([^\s)'"\\]+)\1\s*\)/g,
    (whole, quote: string, id: string) => ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : whole);
  const scrollers: Array<{ element: Element; left: number; top: number }> = [];
  const canvases: HTMLCanvasElement[] = [];
  let pixelsLeft = 8_000_000;
  let rastersStyled = 0;
  const animated = new Map<Element, Set<string>>();
  // Most chart/feed nodes require no computed-style read. Sample only actual
  // animated targets, with a bound so a busy dashboard stays cheap on phones.
  for (const animation of source.getAnimations?.({ subtree: true }).slice(0, 64) ?? []) {
    const effect = animation.effect as KeyframeEffect | null;
    if (!effect?.target || effect.pseudoElement) continue;
    const properties = animated.get(effect.target) ?? new Set<string>();
    for (const frame of effect.getKeyframes()) {
      for (const property of Object.keys(frame)) {
        if (!["offset", "computedOffset", "easing", "composite"].includes(property)) properties.add(property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`));
      }
    }
    animated.set(effect.target, properties);
  }

  const copyStyle = (original: Element, copy: HTMLElement | SVGElement) => {
    copy.style.cssText = remap(original.getAttribute("style") ?? "");
    const properties = animated.get(original);
    if (properties?.size) {
      const computed = view.getComputedStyle(original);
      for (const property of properties) copy.style.setProperty(property, remap(computed.getPropertyValue(property)));
    }
    copy.style.setProperty("animation", "none", "important");
    copy.style.setProperty("transition", "none", "important");
    copy.style.setProperty("pointer-events", "none", "important");
    copy.style.setProperty("caret-color", "transparent", "important");
    copy.style.setProperty("scroll-behavior", "auto", "important");
  };

  const clone = (original: Node): Node | null => {
    if (original.nodeType === 3) return doc.createTextNode(original.textContent ?? "");
    if (original.nodeType !== 1) return null;
    const node = original as Element;
    if (OMIT.has(node.tagName.toUpperCase())) return null;
    const tag = node.tagName.toUpperCase();
    // drawImage copies already decoded pixels; copying an img's src/srcset
    // would create another loading element, including for an unloaded image.
    const raster = tag === "CANVAS" || tag === "IMG";
    const copy = raster ? doc.createElement("canvas") : tag === "FORM" || tag === "DIALOG" || node.localName.includes("-") ? doc.createElement("div") : doc.createElementNS(node.namespaceURI, node.localName);
    const copyAttribute = (attribute: Attr, value: string) => {
      // React can create xmlns/xlink attributes with setAttribute, leaving a
      // null namespace. setAttributeNS(null, "xmlns", ...) would throw even
      // though the source SVG is valid and already renders in the app.
      if (attribute.namespaceURI) copy.setAttributeNS(attribute.namespaceURI, attribute.name, value);
      else copy.setAttribute(attribute.name, value);
    };
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || (name.startsWith("aria-") && !VISUAL_ARIA.has(name)) || ACTION_ATTRIBUTES.has(name) || name === "tabindex" || name === "role" || name === "style" || name === "value" || name === "checked" || name === "selected" || (tag === "DIALOG" && name === "open")) continue;
      if (name === "src" || name === "srcset" || name === "sizes" || name === "crossorigin") continue;
      if (name === "href" || name === "xlink:href") {
        // Only SVG references within the frozen scene can remain active.
        const id = attribute.value.startsWith("#") ? ids.get(attribute.value.slice(1)) : undefined;
        if (tag !== "A" && node.namespaceURI === "http://www.w3.org/2000/svg" && id) copyAttribute(attribute, `#${id}`);
        continue;
      }
      if (name === "id") copy.setAttribute("id", ids.get(attribute.value)!);
      else copyAttribute(attribute, remap(attribute.value));
    }
    const styled = copy as HTMLElement | SVGElement;
    copyStyle(node, styled);
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") {
      // A visual transition must never copy typed passwords, account details,
      // or pending order values into attributes or another form control.
      // The inert wrapper prevents interaction; retain the original disabled
      // state so enabled controls do not suddenly dim in the frozen picture.
      if (tag === "INPUT" || tag === "TEXTAREA") (copy as HTMLInputElement).value = "";
    }
    if (tag === "FORM") copy.setAttribute("inert", "");
    if (copy.hasAttribute("contenteditable")) copy.setAttribute("contenteditable", "false");
    if (node.scrollLeft || node.scrollTop) scrollers.push({ element: copy, left: node.scrollLeft, top: node.scrollTop });
    if (raster) {
      const canvas = copy as HTMLCanvasElement;
      const image = node as HTMLImageElement;
      const originalCanvas = node as HTMLCanvasElement;
      const width = tag === "IMG" ? image.naturalWidth : originalCanvas.width;
      const height = tag === "IMG" ? image.naturalHeight : originalCanvas.height;
      const scale = width && height ? Math.min(1, 4096 / width, 4096 / height, Math.sqrt(pixelsLeft / (width * height))) : 0;
      canvas.width = Math.floor(width * scale);
      canvas.height = Math.floor(height * scale);
      pixelsLeft -= canvas.width * canvas.height;
      canvases.push(canvas);
      if (rastersStyled++ < 64) {
        // The canvas retains the image's measured CSS box despite img-only
        // styling. No screen-wide style serialization is needed.
        const computed = view.getComputedStyle(node);
        for (const property of IMAGE_STYLE) canvas.style.setProperty(property, computed.getPropertyValue(property));
      }
      if (canvas.width && canvas.height && (tag !== "IMG" || image.complete)) {
        try { canvas.getContext("2d")?.drawImage(node as CanvasImageSource, 0, 0, canvas.width, canvas.height); }
        catch { /* An unavailable bitmap leaves its measured space intact. */ }
      }
    } else if (tag !== "TEXTAREA") {
      for (const child of Array.from(node.childNodes)) {
        const frozen = clone(child);
        if (frozen) copy.appendChild(frozen);
      }
    }
    return copy;
  };

  const element = doc.createElement("div");
  element.className = "terminal-host mode-frozen-scene";
  element.dataset.modeSnapshot = prefix;
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("inert", "");
  element.style.cssText = "position:fixed;inset:0;overflow:hidden;contain:paint;pointer-events:none;user-select:none;";
  const inherited = view.getComputedStyle(source.parentElement ?? source);
  for (const property of INHERITED) element.style.setProperty(property, inherited.getPropertyValue(property));
  for (let index = 0; index < inherited.length; index++) {
    const property = inherited.item(index);
    if (property.startsWith("--")) element.style.setProperty(property, inherited.getPropertyValue(property));
  }
  const backdrop = view.getComputedStyle(source).backgroundColor;
  const opaque = (value: string) => value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent";
  element.style.backgroundColor = opaque(backdrop) ? backdrop : opaque(inherited.backgroundColor) ? inherited.backgroundColor : "#070806";
  const rect = source.getBoundingClientRect();
  const frozen = clone(source) as HTMLElement;
  Object.assign(frozen.style, {
    position: "absolute", top: `${rect.top}px`, left: `${rect.left}px`,
    width: `${rect.width}px`, height: `${rect.height}px`, minWidth: "0", maxWidth: "none",
    boxSizing: "border-box", margin: "0", transform: "none",
  });
  const style = doc.createElement("style");
  // All other presentation remains in the existing class-based theme rules;
  // Merrymen's terminal CSS has no ID selectors. Pseudo-elements cannot keep a
  // shimmer running behind the tear.
  style.textContent = `[data-mode-snapshot="${prefix}"] *::before,[data-mode-snapshot="${prefix}"] *::after{animation:none!important;transition:none!important;pointer-events:none!important}`;
  element.append(style, frozen);
  let disposed = false;
  return {
    element,
    restoreScroll: () => {
      if (disposed) return;
      for (const entry of scrollers) {
        entry.element.scrollLeft = entry.left;
        entry.element.scrollTop = entry.top;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      element.remove();
      for (const canvas of canvases) { canvas.width = 0; canvas.height = 0; }
      element.replaceChildren();
      scrollers.length = 0;
      canvases.length = 0;
      ids.clear();
      animated.clear();
    },
  };
}
