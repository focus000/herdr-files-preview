# Files Preview

Herdr's Files panel, with Quick Look-style previews. Click a file in the tree and the panel shows it: photos at full resolution with zoom and pan (HEIC and huge images included), an audio player, PDFs page by page, Word/Excel/Keynote/video thumbnails through macOS Quick Look, rendered markdown, and code. It works the same for a space on another machine: the file is fetched through herdr-core, no ssh setup needed. Right-click any file for Quick Look, Open, Open in VS Code, Download to Downloads, Reveal in Finder and Copy Path.

![Files Preview](preview.png)

## What you see

- One panel, same shape as the shipped Files: a 42px header (`←` back, "Files", the shown file or folder name on the right in `dim`, 12px), then either the tree or one file's preview. Colors all come from `theme()` (`background`, `border`, `foreground`, `muted`, `dim`, `hover`, `selected`, `popover`).
- Tree: 28px rows, 18px indent per level, chevron + folder/file icon + name, git marks (`A` ansi2, `M` blocked color, `D`/`U` ansi1) on the right. Unchanged from Herdr's Files.
- Preview area by kind:
  - image: the original's pixels, fitted (never upscaled) until zoomed; footer shows the zoom (`78%`, click toggles fit / 100%), size and the original's `W × H`.
  - pdf: one page rendered at 1600px long side, fitted; footer has `‹ p / N ›` buttons.
  - quicklook (docx, xlsx, pptx, pages, numbers, key, rtf, mp4, mov, zip, psd, ...): Quick Look's 1200px thumbnail, fitted.
  - audio (mp3, m4a, wav, aac, flac, aiff, caf): a 56px music icon, the name, then a row: a 30px round `solid` play/pause button, elapsed time, a 4px scrubber (`border` track, `accent` fill), duration.
  - markdown: `TextView.markdown`, scrollable, selectable (tables, code blocks).
  - text/code up to 1 MiB: the read-only `Editor` with syntax colors. Bigger text shows its Quick Look thumbnail with `Over 1 MB · right-click for Quick Look` in the footer, never a cut-off file.
- While a remote file is fetched: `Fetching 12.0 / 34.5 MB`.
- While a menu action fetches or downloads: a strip at the panel's bottom, `Downloading big.bin   6.0 MB / 30 MB`, one row per job, 12px `muted`.
- Errors replace the preview in `dim`: `No preview`, `Too large to preview` (remote over 50 MB), `This file is no longer available`, `Binary file · no text preview`.
- Right-click menu: a 220px popup, file name header in `dim` 11px, 30px rows, `selected` for the keyboard row.

## How it behaves

- The panel follows the focused pane's folder and machine, like Herdr's Files. Back (`←`) returns to the tree.
- Click a file: the preview loads. The previous picture stays up until the next is ready (no blank frame between pictures).
- Images: cmd/ctrl + scroll zooms around the pointer (from fit, or 100% if smaller, up to 3200%); scroll or drag pans once the image is bigger than the area; double-click toggles fit and 100%. There is no pinch zoom: GPUI reports no magnify gesture.
- Audio: nothing plays until the button is pressed. Click the scrubber to seek. Choosing another file, Back, or closing the panel stops it. Selecting another file cancels the old one's result (a request token), so a slow fetch never overwrites a newer choice.
- Remote files are fetched once per (machine, path, mtime, size) into the cache; reopening is instant, and a changed file gets a new cache entry.
- Right-click a row, the header, or the preview to open the menu. Up/Down/Enter/Esc work in it. Items by case:
  - Quick Look (`qlmanage -p`) and Open (`open`): macOS; a remote file is fetched first.
  - Open in VS Code: local files only, when `code` or the app is installed (a remote file would open the cache copy, and edits would not reach the machine).
  - Download to Downloads: remote files; never overwrites (`name (1).ext`); toast with the path.
  - Reveal in Finder: local files. Copy Path: always (the path on its own machine).
- `props.file` (relative to the folder, or absolute) opens that file directly: `pane.split {direction:"right", mod:"files-preview", props:{file:"README.md"}}` is a file viewer.
- Agent status is not shown here (no agent display in this mod).

## Built from

- `mods/files-preview/`, place `none`. Use it by pointing a layout block at it. With Herdr's default layout: `herdr-app do layout.clone '{"name":"main","as":"main-preview"}'`, then in `layouts/main-preview.json` change the block `{"id":"files", "content":{"mod":"files"}}` to `"mod":"files-preview"`. The tab bar's Files button keeps working (it toggles the stack child by id `files`).
- `main.js`: the tree (from Herdr's `files` 0.1.14), the request token, `props.file`, right-click wiring. When `props().role === "menu"` the same mod renders the popup instead.
- `fetch.js`: the only local-vs-remote boundary. `materialize(source)` returns a local file: local paths as they are, remote ones copied in 2,000,000-byte chunks with `hc exec --on <machine> dd ... >> file.part` run locally, then `mv`. Concurrent requests for one cache key share one fetch. `stageImage` returns the original when `image()` can draw it (png/jpg/gif/webp/bmp/svg/ico, at most 16 MiB encoded and 16384px a side); otherwise a full-size PNG (`sips`), or JPEG quality 92 when PNG is over 16 MiB, shrunk by 0.8 steps only while JPEG is still over. `placeInSlot` copies a picture into `mods/files-preview-slots/s<copy><a|b>.<ext>`. `downloadToDownloads`. Cache pruned to 200 files / 500 MB.
- `preview.js`: `KINDS` table (extension → image | pdf | markdown | text | quicklook), one preview value `{state: idle | loading | ready | error}`, the PDF page renderer (JXA: PDFKit page drawn into a CGBitmapContext, PNG), `qlmanage -t -s 1200` for quicklook.
- `viewer.js`: `ImageViewer`, two slot layers stacked absolutely in an `overflow_hidden` box. A new picture is written into the back slot, which is drawn (transparent, 1×1) so it reloads; after 300 ms it becomes the front. State `{s, x, y}` (scale, offset), clamped so a bigger image never leaves a gap and a smaller one is centered. Both slots are drawn hidden under every other kind too. Each live copy takes a slot number from a module counter, so reloads reuse the same few files.
- `audio.js` + `player.jxa`: `osascript -l JavaScript player.jxa <file> <dir>` runs AVAudioPlayer in the background. The panel writes `dir/cmd.json` `{seq, op: play | pause | seek, t}` and touches `dir/hb`; the player writes `dir/state.json` `{t, dur, playing, seq}` every 0.2 s. The panel polls every 250 ms and redraws only when the quarter-second, play state or duration changed; a click shows its result at once until the player reports that `seq`. Each start gets its own `data/files-preview-audio/s<n>/<run>/`; removing it stops that player within 0.1 s, and a heartbeat older than 4 s stops it too (a crash never leaves audio playing). `close()` removes it.
- `mods/files-preview-slots/`: an empty mod (`main.js` renders `div()`, place `none`) that only holds the slot files.
- `menu.js`: `MENU`, a list of `{id, label, verb?, when(entry, ctx), run(entry, progress)}`, and the popup view (`openOverlay({mod:"files-preview", kind:"popup", width:220, props:{role:"menu", entry, from, ids}})`). Choosing an item writes shared `files-preview.request` `{to: from, seq, id, entry}` and closes the popup; the panel whose random `uid` equals `to` runs the item in its render-time `take()` and shows the progress strip.
- Herdr API: `spaces`, `panes`, `focused`, `exec` (with `on`), `readTextFile`, `watchFolder`, `openOverlay`, `closeOverlay`, `notify`, `props`, `theme`, `window`, `appHome`, `home`. Programs: `sh`, `stat`, `dd`, `hc`, `mv`, `cp`, `sips`, `qlmanage`, `osascript`, `open`, `pbcopy`, `code` (optional), `git`.

## Watch out

- `image()` only draws paths relative to the app home (`~/.config/herdr-app`). Absolute and `~` paths draw nothing.
- `image()` keeps every path it ever drew decoded until the app quits, even after the pane closes (measured: about 184 MB per 6000×4000 path). A new file name per picture grows memory without bound, so pictures go through two fixed slot files per copy. Measured: 18 different 2400×2400 images through the slots added 0 MB.
- A rewritten file under `mods/` reloads; under `data/` it keeps the old picture. The reload shows blank for about 175 ms, hence the hidden back slot and the 300 ms wait.
- `image()` draws nothing for an encoded file over 16 MiB (15.9 MB draws, 19.9 MB doesn't) or a side over 16384px. Pixel count isn't the limit: a 9 MB 6016×6016 JPEG draws, the same image as a 57 MB PNG doesn't. Never shrink below that: a 2048px copy blurs as soon as you zoom.
- Never write the cache inside `mods/files-preview/`: every write hot-reloads the mod.
- A popup that closes itself cancels its own tasks after their first `await`. Running a download from the menu popup silently stops before any byte arrives. Hand the work to the long-lived panel (shared request) instead.
- `exec` stdout is a UTF-8 string and `hc exec` keeps only the first 8 MB of output, so binary must go to a local file through a shell redirect, in chunks. At about 1 MB/s, 2 MB chunks keep progress moving.
- ssh/scp can't be assumed (jump hosts with passwords); herdr-core's connection always exists.
- `PDFPage.thumbnailOfSize` is not callable from JXA; draw the page into a bitmap context.
- `qlmanage -t` can hang on files no generator understands; it has a 15 s timeout.
- `cx.notify()` is refused during render, including in a `cx.spawn` before its first `await`; `on_size_change` can fire during render.
- `fs/promises` has no `stat`; sizes come from the `stat` program (GNU and BSD forms).
- macOS only for PDF, Quick Look, Open, Reveal, HEIC. Elsewhere, images, markdown and text still preview.
- Videos show one frame; there is no video element. Multi-page Office documents show their first page.
- Markdown images draw nothing, whatever the path (relative, absolute, `file://`, `data:`, even `https://`). gpui-kit's shell installs its own image resolver on every `TextView` (`crates/shell/src/materialize/text_view.rs`), which only accepts an absolute HTTP(S) URL with a `capabilities.network` GET grant, and mods get no such grant. It replaces TextView's own resolver, so even `data:` URLs are refused. Nothing in a mod can change this.
- The read-only `Editor` takes about 2 s for 1 MB and didn't finish a 3.6 MB file in 20 s, hence the 1 MiB limit. `readTextFile` reads at most 1 MiB anyway.
- `afplay` can't seek or pause; AVAudioPlayer through JXA can. `exec` waits for its program (10 minutes at most), so the player starts in the background (`... &` with stdio to `/dev/null`) and talks through files.
- Opening a remote file in a local app opens a read-only copy; edits don't go back.

## Done when

- `herdr-app check mods/files-preview` passes.
- In a local folder: a PNG and a JPEG show fitted with correct `W × H`; a 6016×6016 HEIC shows with `6016 × 6016` in the footer; a 22 MB PNG shows (from a full-size JPEG); a 2px checkerboard zoomed to 400% shows crisp 8px squares; switching between pictures never shows a blank frame or the previous file's picture; cycling 18 different large images doesn't grow Herdr's memory; a 2-page PDF shows page 1 and `‹ 1 / 2 ›`, `›` shows page 2; a .docx shows its Quick Look page; a .md shows a rendered table; a 1.5 MB .txt shows its Quick Look thumbnail and the `Over 1 MB` note; a 20 s .wav plays, seeks to 10 s from the middle of the scrubber, pauses with time frozen, and its `osascript` exits when another file is chosen.
- In a space on another machine: the same PNG shows identical pixels; a 9 MB file shows `Fetching … MB`, then the cache file's md5 equals `hc exec --on <m> md5sum <file>`.
- Right-click a remote file → Download to Downloads: the menu closes, the panel shows `Downloading name  x MB / y MB`, and the file lands in `~/Downloads` with the remote md5 (checked with a 30 MB file); a second download becomes `name (1).ext`.
- Right-click a local file shows Quick Look, Open, (Open in VS Code), Reveal in Finder, Copy Path; Quick Look opens the system panel.
- `herdr-app status` shows no files-preview error.
