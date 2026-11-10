// One preview value: idle, loading, ready, or error. The kind comes from KINDS.
// A missing extension is text when the bytes have no NUL, otherwise Quick Look.
import { div, image } from "gpui-kit";
import { Editor, EditorState, TextView, h_flex, v_flex } from "gpui-base";
import { appHome, exec, readTextFile, settings, theme, window } from "herdr";
import { PREVIEW_CAP, cacheDir, cacheId, extension, fileSize, materialize, pixels, stageImage } from "./fetch.js";

const TEXT_CAP = 1024 * 1024;

// PDFPage.thumbnailOfSize is not a function in JavaScript for Automation on
// this Mac, so the page is drawn into a bitmap and encoded as PNG.
const PDF_SCRIPT = `function run(argv) {
  ObjC.import("Quartz");
  ObjC.import("AppKit");
  var file = argv[0], out = argv[1];
  var pageNo = Math.max(1, parseInt(argv[2], 10) || 1);
  var maxSide = Math.max(1, parseInt(argv[3], 10) || 1600);
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(file));
  if (!doc || doc.isNil()) throw new Error("Cannot open PDF");
  var pages = Number(doc.pageCount);
  if (!pages) throw new Error("Cannot open PDF");
  var page = doc.pageAtIndex(Math.min(pageNo, pages) - 1);
  var bounds = page.boundsForBox($.kPDFDisplayBoxMediaBox);
  var pw = Number(bounds.size.width), ph = Number(bounds.size.height);
  var scale = maxSide / Math.max(pw, ph);
  var w = Math.max(1, Math.round(pw * scale)), h = Math.max(1, Math.round(ph * scale));
  var ctx = $.CGBitmapContextCreate(null, w, h, 8, 0, $.CGColorSpaceCreateDeviceRGB(), $.kCGImageAlphaPremultipliedLast);
  if (!ctx || (ctx.isNil && ctx.isNil())) throw new Error("Cannot draw PDF");
  $.CGContextSetRGBFillColor(ctx, 1, 1, 1, 1);
  $.CGContextFillRect(ctx, $.CGRectMake(0, 0, w, h));
  $.CGContextScaleCTM(ctx, scale, scale);
  page.drawWithBoxToContext($.kPDFDisplayBoxMediaBox, ctx);
  var rep = $.NSBitmapImageRep.alloc.initWithCGImage($.CGBitmapContextCreateImage(ctx));
  var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  if (!png || png.isNil() || !png.writeToFileAtomically(out, true)) throw new Error("Cannot write PNG");
  return JSON.stringify({ pages: pages, page: Math.min(pageNo, pages), width: w, height: h });
}`;

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

export const KINDS = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image",
  svg: "image", ico: "image", heic: "image", heif: "image", tif: "image", tiff: "image",
  pdf: "pdf",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  txt: "text", text: "text", log: "text", csv: "text", tsv: "text", json: "text", jsonc: "text",
  yaml: "text", yml: "text", toml: "text", xml: "text", html: "text", htm: "text", css: "text",
  scss: "text", less: "text", js: "text", jsx: "text", mjs: "text", cjs: "text", ts: "text",
  tsx: "text", mts: "text", cts: "text", py: "text", rb: "text", go: "text", rs: "text",
  java: "text", c: "text", h: "text", cpp: "text", hpp: "text", cc: "text", hh: "text",
  cs: "text", php: "text", swift: "text", kt: "text", kts: "text", scala: "text", lua: "text",
  sql: "text", sh: "text", bash: "text", zsh: "text", fish: "text", ps1: "text", r: "text",
  pl: "text", dart: "text", vim: "text", ini: "text", conf: "text", cfg: "text", properties: "text",
  gradle: "text", lock: "text", diff: "text", patch: "text", rst: "text", tex: "text", bib: "text",
  proto: "text", graphql: "text", gql: "text", tf: "text", hcl: "text", nix: "text", zig: "text",
  vue: "text", svelte: "text", env: "text", gitignore: "text", editorconfig: "text",
  doc: "quicklook", docx: "quicklook", docm: "quicklook", dot: "quicklook", dotx: "quicklook",
  rtf: "quicklook", odt: "quicklook", pages: "quicklook", numbers: "quicklook", key: "quicklook",
  xls: "quicklook", xlsx: "quicklook", xlsm: "quicklook", xlsb: "quicklook", ods: "quicklook",
  ppt: "quicklook", pptx: "quicklook", pptm: "quicklook", odp: "quicklook",
  mp4: "quicklook", mov: "quicklook", m4v: "quicklook", avi: "quicklook", mkv: "quicklook",
  webm: "quicklook", mpg: "quicklook", mpeg: "quicklook",
  mp3: "quicklook", m4a: "quicklook", wav: "quicklook", aac: "quicklook", flac: "quicklook",
  aiff: "quicklook", aif: "quicklook",
  zip: "quicklook", gz: "quicklook", tgz: "quicklook", tar: "quicklook", bz2: "quicklook",
  xz: "quicklook", rar: "quicklook", "7z": "quicklook", dmg: "quicklook", iso: "quicklook",
  psd: "quicklook", ai: "quicklook", sketch: "quicklook", eps: "quicklook",
};

export function isMac() {
  return window()?.platform === "macos";
}

function mb(n) {
  return (Number(n) / 1e6).toFixed(1);
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(n >= 10000 ? 0 : 1)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

function clip(text) {
  return text.length >= TEXT_CAP ? `${text.slice(0, TEXT_CAP)}\n… (file truncated)` : text;
}

async function readText(source) {
  let text;
  try { text = await readTextFile(source.path, { on: source.on }); }
  catch { return undefined; }
  if (text == null) return null;
  if (text.includes("\0")) return undefined;
  return clip(text);
}

export function textEditor(text, path) {
  const t = theme();
  const ext = extension(path);
  return EditorState.new({
    language: LANG[ext] || ext || "txt",
    readonly: true,
    value: text,
    font_family: settings().font_family,
    font_size: 12,
    syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
  });
}

export async function renderPdf(abs, page, id, knownPages) {
  let next = Math.max(1, page || 1);
  if (knownPages) next = Math.min(next, knownPages);
  const name = `${id}.p${next}.png`;
  const rel = `data/files-preview-cache/${name}`;
  const out = `${cacheDir()}/${name}`;
  if (knownPages && await fileSize(out) > 0) {
    return { rel, page: next, pages: knownPages, cacheKey: id, ...(await pixels(out)) };
  }
  const r = await exec("osascript", ["-l", "JavaScript", "-e", PDF_SCRIPT, abs, out, String(next), "1600"], { timeout: 60000 });
  if (r.code !== 0) throw new Error("No preview");
  let meta;
  try { meta = JSON.parse(r.stdout.trim()); }
  catch { throw new Error("No preview"); }
  return { rel, page: meta.page, pages: meta.pages, width: meta.width, height: meta.height, cacheKey: id };
}

async function quicklook(abs, id) {
  const name = `${id}.ql.png`;
  const rel = `data/files-preview-cache/${name}`;
  const out = `${cacheDir()}/${name}`;
  if (await fileSize(out) > 0) return { rel, ...(await pixels(out)) };
  const dir = `${cacheDir()}/${id}.qldir`;
  await exec("rm", ["-rf", dir]);
  await mkdirQuiet(dir);
  // qlmanage -t can hang on files no generator understands.
  const r = await exec("qlmanage", ["-t", "-s", "1200", "-o", dir, abs], { timeout: 15000 }).catch(() => ({ code: 1 }));
  const produced = `${dir}/${abs.split("/").pop()}.png`;
  const mv = await exec("mv", ["-f", produced, out]);
  await exec("rm", ["-rf", dir]);
  if (r.code !== 0 || mv.code !== 0 || await fileSize(out) <= 0) throw new Error("No preview");
  return { rel, ...(await pixels(out)) };
}

async function mkdirQuiet(dir) {
  const r = await exec("mkdir", ["-p", dir]);
  if (r.code !== 0) throw new Error("No preview");
}

function fail(error) {
  if (error?.code === "too-large") return { state: "error", message: "Too large to preview", size: error.size };
  if (error?.code === "missing") return { state: "error", message: "This file is no longer available" };
  return { state: "error", message: error?.message || "No preview" };
}

export async function loadPreview(source, hooks) {
  const { alive, update } = hooks;
  const known = KINDS[extension(source.path)] ?? null;
  try {
    if (known === "text" || known === "markdown") {
      // show() already set loading. Notifying here still runs inside render when
      // a folder change calls show() from render, and Herdr refuses that.
      const text = await readText(source);
      if (!alive()) return;
      if (text == null) return update({ state: "error", message: "This file is no longer available" });
      if (text === undefined) return update({ state: "error", message: known === "text" ? "Binary file · no text preview" : "No preview" });
      update({ state: "ready", kind: known, text });
      return;
    }
    if (known == null) {
      const text = await readText(source);
      if (!alive()) return;
      if (typeof text === "string") {
        update({ state: "ready", kind: "text", text });
        return;
      }
    }
    const kind = known ?? "quicklook";
    if ((kind === "pdf" || kind === "quicklook") && !isMac()) {
      update({ state: "error", message: "No preview" });
      return;
    }
    const file = await materialize(source, (got, total) => {
      if (alive()) update({ state: "loading", got, total, progress: total ? got / total : undefined });
    }, { maxBytes: PREVIEW_CAP });
    if (!alive()) return;
    update({ state: "loading" });
    if (kind === "image") {
      const staged = await stageImage(source, file);
      if (!alive()) return;
      update({ state: "ready", kind, size: file.size, abs: file.abs, ...staged });
      return;
    }
    const id = cacheId(source, file.size, file.mtime);
    if (kind === "pdf") {
      const rendered = await renderPdf(file.abs, 1, id);
      if (!alive()) return;
      update({ state: "ready", kind, size: file.size, abs: file.abs, ...rendered });
      return;
    }
    const thumb = await quicklook(file.abs, id);
    if (!alive()) return;
    update({ state: "ready", kind: "quicklook", size: file.size, abs: file.abs, ...thumb });
  } catch (error) {
    if (alive()) update(fail(error));
  }
}

export async function loadPage(preview, page) {
  const rendered = await renderPdf(preview.abs, page, preview.cacheKey, preview.pages);
  return { ...preview, state: "ready", ...rendered };
}

function contain(width, height, box) {
  const bw = Math.max(1, Math.floor((box?.width ?? 280) - 24));
  const bh = Math.max(1, Math.floor((box?.height ?? 280) - 56));
  if (!width || !height) return { w: Math.min(bw, 320), h: Math.min(bh, 240) };
  const scale = Math.min(bw / width, bh / height, 1);
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

function step(id, label, enabled, onClick) {
  const t = theme();
  return div().id(id).w(28).h(22).flex().items_center().justify_center().rounded(4).text_size(14)
    .text_color(enabled ? t.foreground : t.dim)
    .opacity(enabled ? 1 : 0.45)
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
    .child(label);
}

export function renderPreview(preview, editor, box, turn) {
  const t = theme();
  if (!preview || preview.state === "idle") return div().p(12).text_color(t.dim).child("");
  if (preview.state === "loading") {
    const label = preview.total != null ? `Fetching ${mb(preview.got || 0)} / ${mb(preview.total)} MB` : "Loading…";
    return div().p(12).text_color(t.dim).child(label);
  }
  if (preview.state === "error") return div().p(12).text_color(t.dim).child(preview.message);
  if (preview.kind === "markdown") {
    return v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(12)
      .child(TextView.markdown("files-preview-md", preview.text || ""));
  }
  if (preview.kind === "text") {
    return editor ? Editor.new(editor).flex_1().min_h(0) : div().p(12).text_color(t.dim).child("Loading…");
  }
  const fit = contain(preview.width, preview.height, box);
  const bits = [formatBytes(preview.size), preview.width && preview.height ? `${preview.width} × ${preview.height}` : ""].filter(Boolean);
  return v_flex().flex_1().min_h(0)
    .child(v_flex().flex_1().min_h(0).items_center().justify_center().overflow_hidden()
      .child(preview.rel ? image(preview.rel).flex_none().w(fit.w).h(fit.h).rounded(4) : div()))
    .child(h_flex().h(32).flex_none().px(10).gap(8).items_center().border_t(1).border_color(t.border)
      .when(preview.kind === "pdf", (el) => el
        .child(step("pdf-prev", "‹", preview.page > 1, (cx) => turn(-1, cx)))
        .child(div().text_size(12).text_color(t.muted).child(`${preview.page} / ${preview.pages}`))
        .child(step("pdf-next", "›", preview.page < preview.pages, (cx) => turn(1, cx))))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(bits.join("   "))));
}
