import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { freezeModeScene } from "./mode-transition-snapshot";
import { testDom } from "./test-dom";

describe("frozen mode scene", () => {
  let ui: ReturnType<typeof testDom>;
  beforeEach(() => { ui = testDom(); });
  afterEach(async () => { await ui.close(); });
  const source = (html: string) => {
    const app = document.createElement("div");
    app.className = "app";
    app.innerHTML = html;
    app.getBoundingClientRect = () => ({ x: 7, y: -20, top: -20, left: 7, width: 390, height: 900, right: 397, bottom: 880, toJSON: () => ({}) });
    ui.container.append(app);
    return app;
  };

  it("keeps the actual source geometry, native elements, theme and nested scroll without mutating the live page", () => {
    ui.container.style.setProperty("--radar", "#d2f653");
    ui.container.style.fontFamily = "monospace";
    const app = source('<section class="body"><button>Spot</button><p>Private position</p></section>');
    app.style.backgroundColor = "rgb(13, 16, 11)";
    app.querySelector("section")!.scrollTop = 345;
    app.querySelector("section")!.scrollLeft = 18;
    const scene = freezeModeScene(app);
    ui.container.append(scene.element);
    scene.restoreScroll();
    const copy = scene.element.querySelector<HTMLElement>(".app")!;
    assert.equal(copy.style.top, "-20px");
    assert.equal(copy.style.left, "7px");
    assert.equal(copy.style.width, "390px");
    assert.equal(copy.style.height, "900px");
    assert.equal(copy.querySelector("section")!.scrollTop, 345);
    assert.equal(copy.querySelector("section")!.scrollLeft, 18);
    assert.ok(copy.querySelector("button") instanceof ui.dom.window.HTMLButtonElement);
    assert.equal(scene.element.style.getPropertyValue("--radar"), "#d2f653");
    assert.equal(scene.element.style.fontFamily, "monospace");
    assert.equal(scene.element.style.backgroundColor, "rgb(13, 16, 11)");
    assert.equal(scene.element.getAttribute("aria-hidden"), "true");
    assert.ok(scene.element.hasAttribute("inert"));
    assert.equal(app.style.top, "");
    assert.equal(app.querySelector("button")!.disabled, false);
    scene.dispose();
    assert.equal(scene.element.isConnected, false);
    assert.equal(scene.element.textContent, "");
    scene.restoreScroll();
    scene.dispose();
    assert.match(app.textContent!, /Private position/);
  });

  it("isolates SVG IDs and references without breaking chart fills or clip paths", () => {
    const app = source('<svg><defs><linearGradient id="price"><stop offset="0" /></linearGradient><clipPath id="frame"><rect width="10" /></clipPath></defs><path id="plot" fill="url(#price)" clip-path="url(\'#frame\')" style="filter:url(#frame)" /><use href="#plot" /></svg>');
    const first = freezeModeScene(app);
    const second = freezeModeScene(app);
    document.body.append(first.element, second.element);
    const path = first.element.querySelector("path")!;
    const gradient = first.element.querySelector("linearGradient")!;
    const frame = first.element.querySelector("clipPath")!;
    assert.notEqual(gradient.id, "price");
    assert.equal(path.getAttribute("fill"), `url(#${gradient.id})`);
    assert.equal(path.getAttribute("clip-path"), `url('#${frame.id}')`);
    assert.ok((path as SVGElement).style.filter.includes(`#${frame.id}`));
    assert.equal(first.element.querySelector("use")!.getAttribute("href"), `#${path.id}`);
    const ids = [...document.querySelectorAll("[id]")].map(node => node.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(document.getElementById("price"), app.querySelector("linearGradient"));
    first.dispose(); second.dispose();
  });

  it("copies React-created SVG namespace attributes without aborting the scene", () => {
    const app = source('<button>Enabled</button><button disabled>Disabled</button>');
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("id", "react-path");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("xlink:href", "#react-path");
    svg.append(path, use);
    app.append(svg);
    assert.equal(svg.getAttributeNode("xmlns")!.namespaceURI, null);
    assert.equal(use.getAttributeNode("xlink:href")!.namespaceURI, null);
    const scene = freezeModeScene(app);
    const copiedSvg = scene.element.querySelector("svg")!;
    assert.equal(copiedSvg.getAttribute("xmlns"), "http://www.w3.org/2000/svg");
    assert.equal(copiedSvg.querySelector("use")!.getAttribute("xlink:href"), `#${copiedSvg.querySelector("path")!.id}`);
    assert.deepEqual([...scene.element.querySelectorAll("button")].map(button => button.disabled), [false, true]);
    scene.dispose();
  });

  it("cannot replay controls, event handlers, navigation, media or form values", () => {
    const app = source('<form action="/transfer"><input name="amount" value="initial" autofocus /><input type="password" value="secret" /><textarea>private draft</textarea><button formaction="/trade" onclick="window.didTrade=true">Trade</button></form><a href="https://example.test" ping="/ping">External</a><dialog open>Review</dialog><iframe src="/private"></iframe><video autoplay src="/movie"></video><script>window.active=true</script><style>body{color:red}</style><svg><animate attributeName="opacity" /><image href="https://example.test/image" /></svg>');
    app.querySelector("input")!.value = "new amount";
    let clicks = 0;
    app.querySelector("button")!.addEventListener("click", () => clicks++);
    const scene = freezeModeScene(app);
    document.body.append(scene.element);
    assert.equal(scene.element.querySelector("form,dialog,iframe,video,script,animate"), null);
    assert.equal(scene.element.querySelector("input")!.value, "");
    assert.equal(scene.element.querySelector("textarea")!.value, "");
    assert.equal(scene.element.querySelector("textarea")!.textContent, "");
    assert.equal(scene.element.querySelector("[value],[name],[autofocus],[action],[formaction],[onclick],[ping]"), null);
    assert.equal(scene.element.querySelector("a")!.hasAttribute("href"), false);
    assert.equal(scene.element.querySelector("image")!.hasAttribute("href"), false);
    scene.element.querySelector("button")!.click();
    assert.equal(clicks, 0);
    assert.equal(app.querySelector("input")!.value, "new amount");
    scene.dispose();
  });

  it("copies existing raster pixels without another image URL and releases canvas memory", () => {
    const app = source('<canvas width="300" height="150"></canvas><img src="https://example.test/avatar.png" />');
    const img = app.querySelector("img")!;
    Object.defineProperties(img, { naturalWidth: { value: 40 }, naturalHeight: { value: 40 }, complete: { value: true } });
    const draws: unknown[][] = [];
    Object.defineProperty(ui.dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({ drawImage: (...args: unknown[]) => draws.push(args) }) });
    const scene = freezeModeScene(app);
    const canvases = [...scene.element.querySelectorAll("canvas")];
    assert.equal(canvases.length, 2);
    assert.equal(scene.element.querySelector("[src],[srcset],img"), null);
    assert.deepEqual(draws.map(args => args[0]), [app.querySelector("canvas"), img]);
    assert.deepEqual(canvases.map(canvas => [canvas.width, canvas.height]), [[300, 150], [40, 40]]);
    scene.dispose();
    assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  });

  it("bounds raster memory and avoids per-node computed styles on large charts", () => {
    const app = source(`<svg>${'<path d="M0 0L1 1" />'.repeat(1500)}</svg><canvas width="10000" height="10000"></canvas>`);
    Object.defineProperty(ui.dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({ drawImage: () => {} }) });
    const original = ui.dom.window.getComputedStyle.bind(ui.dom.window);
    let reads = 0;
    ui.dom.window.getComputedStyle = (...args) => { reads++; return original(...args); };
    const scene = freezeModeScene(app);
    const canvas = scene.element.querySelector("canvas")!;
    assert.ok(canvas.width * canvas.height <= 8_000_000);
    assert.ok(canvas.width <= 4096 && canvas.height <= 4096);
    assert.ok(reads <= 4, `${reads} style reads for one raster and 1500 chart nodes`);
    scene.dispose();
  });

  it("freezes the currently animated properties and retains state selectors without interactive semantics", () => {
    const app = source('<button aria-pressed="true" aria-controls="panel" style="transform:translateX(20px);opacity:.5">Perps</button>');
    const button = app.querySelector("button")!;
    Object.defineProperty(app, "getAnimations", { value: () => [{ effect: {
      target: button, pseudoElement: null,
      getKeyframes: () => [{ transform: "translateX(0)", opacity: 0, offset: 0 }, { transform: "translateX(30px)", opacity: 1, offset: 1 }],
    } }] });
    const scene = freezeModeScene(app);
    const copy = scene.element.querySelector("button")!;
    assert.equal(copy.style.transform, "translateX(20px)");
    assert.equal(copy.style.opacity, "0.5");
    assert.equal(copy.style.animation, "none");
    assert.equal(copy.getAttribute("aria-pressed"), "true");
    assert.equal(copy.hasAttribute("aria-controls"), false);
    scene.dispose();
  });
});
