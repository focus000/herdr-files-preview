// Declarative right-click menu. The popup is another copy of this mod
// (props.role === "menu") so it can run an item after the panel is gone.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, exec, notify, openOverlay, props, theme, window } from "herdr";
import { baseName, downloadToDownloads, materialize } from "./fetch.js";

export const MENU = [
  { id: "quicklook", label: "Quick Look", when: (entry, ctx) => ctx.macos && !entry.dir, run: quickLook },
  { id: "open", label: "Open", when: (entry, ctx) => ctx.macos && !entry.dir, run: openDefault },
  { id: "vscode", label: "Open in VS Code", when: (entry, ctx) => ctx.vscode && !entry.dir && !entry.source?.on, run: openCode },
  { id: "download", label: "Download to Downloads", when: (entry) => Boolean(entry.source?.on) && !entry.dir, run: download },
  { id: "reveal", label: "Reveal in Finder", when: (entry, ctx) => ctx.macos && !entry.source?.on, run: reveal },
  { id: "copy", label: "Copy Path", when: () => true, run: copyPath },
];

let vscodeKnown = null;

function vscodeInstalled() {
  if (!vscodeKnown) {
    vscodeKnown = exec("sh", ["-c", 'command -v code >/dev/null 2>&1 || [ -d "/Applications/Visual Studio Code.app" ] || [ -d "$HOME/Applications/Visual Studio Code.app" ]'])
      .then((r) => r.code === 0, () => false);
  }
  return vscodeKnown;
}

export function menuHeight(n) {
  return 8 + 24 + n * 30 + 8;
}

async function localFile(entry) {
  if (!entry.source?.on) return entry.source.path;
  notify({ title: "Fetching", body: entry.name || baseName(entry.source.path) });
  const file = await materialize(entry.source);
  return file.abs;
}

async function quickLook(entry) {
  const abs = await localFile(entry);
  // qlmanage -p runs until the Quick Look panel closes.
  exec("qlmanage", ["-p", abs]).then((r) => {
    if (r.code !== 0) notify({ title: "Quick Look", body: (r.stderr || "").trim() || "Could not preview the file", level: "error" });
  }, (error) => notify({ title: "Quick Look", body: String(error?.message || error), level: "error" }));
}

async function openDefault(entry) {
  const abs = await localFile(entry);
  const r = await exec("open", [abs]);
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "Could not open the file");
}

async function openCode(entry) {
  const which = await exec("sh", ["-c", "command -v code"]);
  const r = which.code === 0
    ? await exec(which.stdout.trim(), [entry.source.path])
    : await exec("open", ["-a", "Visual Studio Code", entry.source.path]);
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "Could not open the file");
}

async function download(entry) {
  const dest = await downloadToDownloads(entry.source);
  notify({ title: "Downloaded", body: dest });
}

async function reveal(entry) {
  const r = await exec("open", ["-R", entry.source.path]);
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "Could not reveal the file");
}

async function copyPath(entry) {
  const r = await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", entry.source?.path ?? ""]);
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "Could not copy the path");
}

export async function openFileMenu(entry) {
  try {
    const macos = window()?.platform === "macos";
    const vscode = macos ? await vscodeInstalled() : false;
    const ctx = { macos, vscode };
    const items = MENU.filter((item) => item.when(entry, ctx));
    if (!items.length) return;
    openOverlay({
      mod: "files-preview",
      kind: "popup",
      width: 220,
      height: menuHeight(items.length),
      props: { role: "menu", entry, ids: items.map((item) => item.id) },
    });
  } catch (error) {
    notify({ title: "Files", body: String(error?.message || error), level: "error" });
  }
}

export default class Menu {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  list() {
    const ids = new Set(props()?.ids ?? []);
    return MENU.filter((item) => ids.has(item.id));
  }

  choose(index) {
    const here = props();
    const item = this.list()[index];
    if (!item || !here?.entry) return;
    closeOverlay(here.overlay);
    Promise.resolve(item.run(here.entry)).catch((error) => {
      notify({ title: item.label, body: String(error?.message || error), level: "error" });
    });
  }

  render() {
    const t = theme();
    const here = props() ?? {};
    const list = this.list();
    const name = here.entry?.name || baseName(here.entry?.source?.path || "");
    return v_flex().id("files-preview-menu").track_focus(this.handle).w_full().min_h(0).p(4).bg(t.popover).text_size(13)
      .on_key_down((event, cx) => {
        if (!list.length) return;
        if (event.key === "down") this.at = (this.at + 1) % list.length;
        else if (event.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (event.key === "enter") this.choose(this.at);
        else if (event.key === "escape") closeOverlay(here.overlay);
        else return;
        cx.notify();
      })
      .child(div().h(24).px(8).text_size(11).text_color(t.dim).truncate().child(name || "File"))
      .children(list.map((item, index) => h_flex().id(`fp-menu-${item.id}`).h(30).px(8).gap(8).rounded(6).items_center().cursor_pointer()
        .text_color(t.foreground)
        .when(index === this.at, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.choose(index))
        .child(div().flex_1().truncate().child(item.label))));
  }
}
