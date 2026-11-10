// One copy's image viewer: two slot files stacked. A new picture goes into the
// hidden slot, which stays drawn (transparent) so the rewrite reloads behind
// the shown one; it comes to the front once the reload's blank has passed.
// Zoomable layers (images): cmd/ctrl + scroll zooms around the pointer, scroll
// or drag pans, double-click toggles fit and 100%. Others are shown fitted.
import { div, image } from "gpui-kit";
import { placeInSlot } from "./fetch.js";

const RELOAD_MS = 300;
const MAX_SCALE = 32;

export class ImageViewer {
  constructor(slot) {
    this.slot = slot;
    this.layers = { a: null, b: null };
    this.front = "a";
    this.view = null;
    this.box = null;
    this.drag = null;
  }

  shown() {
    return this.layers[this.front];
  }

  async load(staged, cx, alive) {
    const back = this.front === "a" ? "b" : "a";
    const rel = await placeInSlot(staged.abs, `s${this.slot}${back}.${staged.ext}`);
    if (!alive()) return false;
    this.layers[back] = { rel, width: staged.width, height: staged.height, zoomable: staged.zoomable };
    cx.notify();
    await cx.sleep(RELOAD_MS);
    if (!alive()) return false;
    this.front = back;
    this.view = null;
    this.drag = null;
    return true;
  }

  fit(layer) {
    const box = this.box;
    if (!box || !layer?.width || !layer?.height) return 1;
    return Math.min(box.width / layer.width, box.height / layer.height, 1);
  }

  clamp(view, layer) {
    const box = this.box;
    const w = layer.width * view.s, h = layer.height * view.s;
    const x = w <= box.width ? (box.width - w) / 2 : Math.min(0, Math.max(box.width - w, view.x));
    const y = h <= box.height ? (box.height - h) / 2 : Math.min(0, Math.max(box.height - h, view.y));
    return { s: view.s, x, y };
  }

  geometry(layer) {
    if (!this.box || !layer?.width || !layer?.height) return null;
    if (layer === this.shown() && this.view) return this.clamp(this.view, layer);
    return this.clamp({ s: this.fit(layer), x: 0, y: 0 }, layer);
  }

  scale() {
    const g = this.geometry(this.shown());
    return g ? g.s : null;
  }

  zoomTo(s, at, cx) {
    const layer = this.shown(), g = this.geometry(layer);
    if (!g) return;
    const lo = Math.min(this.fit(layer), 1), next = Math.max(lo, Math.min(MAX_SCALE, s));
    const p = at ?? { x: this.box.width / 2, y: this.box.height / 2 };
    const k = next / g.s;
    this.view = this.clamp({ s: next, x: p.x - (p.x - g.x) * k, y: p.y - (p.y - g.y) * k }, layer);
    cx.notify();
  }

  wheel(e, cx) {
    const layer = this.shown(), g = this.geometry(layer);
    if (!g || !layer.zoomable) return;
    if (e.modifiers.platform || e.modifiers.control) {
      this.zoomTo(g.s * Math.exp(e.delta.y * 0.01), e.local_position, cx);
      return;
    }
    this.view = this.clamp({ s: g.s, x: g.x + e.delta.x, y: g.y + e.delta.y }, layer);
    cx.notify();
  }

  press(e, cx) {
    const layer = this.shown(), g = this.geometry(layer);
    if (!g || !layer.zoomable) return;
    if (e.click_count === 2) {
      this.drag = null;
      const fit = this.fit(layer);
      this.zoomTo(Math.abs(g.s - fit) < 1e-3 ? 1 : fit, e.local_position, cx);
      return;
    }
    this.drag = { x: e.position.x, y: e.position.y, ox: g.x, oy: g.y };
  }

  move(e, cx) {
    const drag = this.drag, layer = this.shown(), g = this.geometry(layer);
    if (!drag || !g) return;
    this.view = this.clamp({ s: g.s, x: drag.ox + e.position.x - drag.x, y: drag.oy + e.position.y - drag.y }, layer);
    cx.notify();
  }

  layer(key, visible) {
    const layer = this.layers[key];
    if (!layer) return null;
    const g = visible ? this.geometry(layer) : null;
    const el = image(layer.rel).absolute();
    if (!g) return el.left(0).top(0).w(1).h(1).opacity(0);
    return el.left(g.x).top(g.y).w(layer.width * g.s).h(layer.height * g.s);
  }

  // Both slots are always drawn, so a rewrite of either reloads at once.
  // visible = false keeps them drawn but transparent (another kind is shown).
  render(visible) {
    const back = this.front === "a" ? "b" : "a";
    const layers = [this.layer(back, false), this.layer(this.front, visible)].filter(Boolean);
    if (!visible) return div().absolute().left(0).top(0).w(1).h(1).overflow_hidden().children(layers);
    const g = this.geometry(this.shown());
    const pannable = g && this.box && (this.shown().width * g.s > this.box.width + 0.5 || this.shown().height * g.s > this.box.height + 0.5);
    return div().id("files-image").flex_1().min_h(0).relative().overflow_hidden()
      .when(Boolean(pannable), (el) => el.cursor_grab())
      .on_size_change((size, cx) => {
        const width = Math.round(size.width), height = Math.round(size.height);
        if (width < 2 || height < 2 || (this.box?.width === width && this.box?.height === height)) return;
        this.box = { width, height };
        cx.spawn(async (cx) => { cx.notify(); });
      })
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .on_mouse_down("left", (e, cx) => this.press(e, cx))
      .on_mouse_up("left", () => { this.drag = null; })
      .on_mouse_move((e, cx) => this.move(e, cx))
      .on_hover((hovered) => { if (!hovered) this.drag = null; })
      .children(layers);
  }
}
