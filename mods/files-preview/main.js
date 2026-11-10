// A lazy file browser for the focused pane's folder, with previews and a right-click menu.
// props.file (relative to the folder, or absolute on that machine) opens that file.
// props.role === "menu" is the right-click popup.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, props } from "herdr";
import Menu, { openFileMenu } from "./menu.js";
import { loadPage, loadPreview, renderPreview, textEditor } from "./preview.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;

function paneProps() {
  let value = props();
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" ? value : {};
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(initial, cx) {
    if (initial?.role === "menu" || paneProps().role === "menu") {
      this.menu = new Menu();
      this.menu.init(initial, cx);
      return;
    }
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.preview = { state: "idle" };
    this.dismissed = false;
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      const wanted = !this.dismissed && paneProps().file;
      if (wanted && cwd) this.show(wanted, cx);
      else if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  sourceFor(path) {
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return { on: this.on ?? null, path };
    const root = this.root?.replace(/[\\/]$/, "") ?? "";
    return { on: this.on ?? null, path: root ? `${root}/${path}` : path };
  }

  entryFor(path, dir, name) {
    const source = this.sourceFor(path);
    return { name: name || source.path.split(/[\\/]/).pop(), dir: Boolean(dir), source };
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.token = (this.token ?? 0) + 1;
    this.pageReq = (this.pageReq ?? 0) + 1;
    if (!path) {
      this.preview = { state: "idle" };
      this.source = null;
      return;
    }
    const token = this.token;
    const context = this.context;
    const source = this.sourceFor(path);
    this.source = source;
    this.preview = { state: "loading" };
    if (!cx) return;
    const alive = () => this.token === token && this.file === path && this.current(context);
    cx.spawn(async cx => {
      await loadPreview(source, {
        alive,
        update: (next) => {
          if (!alive()) return;
          if (next.state === "ready" && next.kind === "text") {
            this.code?.release();
            this.code = textEditor(next.text, source.path);
          } else if (next.state !== "loading") {
            this.code?.release();
            this.code = null;
          }
          this.preview = next;
          cx.notify();
        },
      });
    });
  }

  turn(delta, cx) {
    const preview = this.preview;
    if (preview?.state !== "ready" || preview.kind !== "pdf") return;
    const page = preview.page + delta;
    if (page < 1 || page > preview.pages) return;
    const token = this.token;
    const req = (this.pageReq = (this.pageReq ?? 0) + 1);
    cx.spawn(async cx => {
      try {
        const next = await loadPage(preview, page);
        if (this.token !== token || this.pageReq !== req) return;
        this.preview = next;
      } catch {
        if (this.token === token && this.pageReq === req) this.preview = { state: "error", message: "No preview" };
      }
      cx.notify();
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); cx.spawn(async () => { await openFileMenu(this.entryFor(path, entry.dir, entry.name)); }); })
        .child(entry.dir ? svg(`mods/files-preview/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-preview/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (paneProps().role === "menu") return this.menu.render(cx);
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const title = this.file ? this.file.split(/[\\/]/).pop() : this.root?.split(/[\\/]/).pop() ?? "";
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .on_mouse_down("right", (_e, cx) => {
          if (!this.file) return;
          cx.stop_propagation();
          cx.spawn(async () => { await openFileMenu(this.entryFor(this.file, false)); });
        })
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.dismissed = true; this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(title)))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(v_flex().id("files-preview").flex_1().min_h(0)
        .on_size_change((size, cx) => {
          const width = Math.round(size.width), height = Math.round(size.height);
          if (width < 2 || height < 2) return;
          if (this.box?.width === width && this.box?.height === height) return;
          this.box = { width, height };
          // The size can be reported during render, where notify() is refused.
          cx.spawn(async (cx) => { cx.notify(); });
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          cx.spawn(async () => { await openFileMenu(this.entryFor(this.file, false)); });
        })
        .child(renderPreview(this.preview, this.code, this.box, (delta, cx) => this.turn(delta, cx)))));
  }
}
