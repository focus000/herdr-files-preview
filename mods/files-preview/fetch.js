// Local vs remote bytes. Callers pass a Source and get a local file back.
// The cache is data/files-preview-cache, not this mod folder: a write under
// mods/files-preview reloads the mod, and image() only draws a path relative
// to the app home. hc exec cuts one stdout at 8 MiB and that stdout is a
// UTF-8 string, so chunks well under that are appended by the local shell.
// At about 1 MB/s, 2 MB chunks keep the progress moving.
import { createHash } from "crypto";
import { exists, mkdir, unlink } from "fs/promises";
import { appHome, exec, home } from "herdr";

const CHUNK = 2000000;
export const PREVIEW_CAP = 50 * 1000 * 1000;
const MAX_FILES = 200;
const MAX_BYTES = 500 * 1000 * 1000;

const inflight = new Map();
const VIEWABLE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);

export function cacheDir() {
  return `${appHome()}/data/files-preview-cache`;
}

export function baseName(path) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function extension(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function cacheId(source, size, mtime) {
  return createHash("sha256").update(`${source.on ?? ""}\0${source.path}\0${mtime}\0${size}`).digest("hex").slice(0, 32);
}

export async function statSource(source) {
  const r = await exec("sh", ["-c", 'stat -c "%s %Y" "$1" 2>/dev/null || stat -f "%z %m" "$1"', "s", source.path], { on: source.on });
  if (r.code !== 0) return null;
  const [size, mtime] = r.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(size) || !Number.isFinite(mtime)) return null;
  return { size, mtime };
}

export async function fileSize(abs) {
  const r = await exec("sh", ["-c", 'stat -c "%s" "$1" 2>/dev/null || stat -f "%z" "$1"', "s", abs]);
  if (r.code !== 0) return -1;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : -1;
}

async function ensureCache() {
  await mkdir(cacheDir(), { recursive: true });
}

function share(id, work) {
  let job = inflight.get(id);
  if (!job) {
    const listeners = new Set();
    const promise = work((got, total) => {
      for (const fn of listeners) fn(got, total);
    }).finally(() => inflight.delete(id));
    job = { promise, listeners };
    inflight.set(id, job);
  }
  return job;
}

async function fetchChunks(machine, remotePath, part, size, onProgress) {
  await exec("rm", ["-f", part]);
  if (size === 0) {
    const touch = await exec("touch", [part]);
    if (touch.code !== 0) throw new Error(touch.stderr.trim() || "Could not fetch the file");
    onProgress?.(0, 0);
    return;
  }
  let got = 0;
  onProgress?.(0, size);
  const limit = Math.ceil(size / CHUNK) + 1;
  for (let i = 0; got < size && i < limit; i++) {
    const r = await exec("sh", ["-c", 'hc exec --on "$1" dd if="$2" bs="$5" skip="$3" count=1 status=none >> "$4"', "sh", machine, remotePath, String(i), part, String(CHUNK)], { timeout: 120000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "Could not fetch the file");
    const now = await fileSize(part);
    if (now <= got) throw new Error("Could not fetch the file");
    got = now;
    onProgress?.(Math.min(got, size), size);
  }
  if (got !== size) throw new Error("Fetched file size does not match");
}

let prunedAt = 0;

export async function pruneCache() {
  const now = Date.now();
  if (now - prunedAt < 60000) return;
  prunedAt = now;
  const dir = cacheDir();
  const listed = await exec("sh", ["-c", 'cd "$1" 2>/dev/null || exit 0; for f in *; do [ -f "$f" ] || continue; case "$f" in *.part) continue;; esac; stat -f "%m %z %N" "$f" 2>/dev/null || stat -c "%Y %s %n" "$f"; done', "prune", dir]);
  if (listed.code !== 0 && !listed.stdout) return;
  const files = [];
  for (const line of listed.stdout.split("\n")) {
    const match = /^(\d+) (\d+) (.+)$/.exec(line.trim());
    if (!match || match[3].endsWith(".part")) continue;
    files.push({ name: match[3], mtime: Number(match[1]), size: Number(match[2]) });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let kept = 0, bytes = 0;
  for (const file of files) {
    const over = kept > 0 && (kept >= MAX_FILES || bytes + file.size > MAX_BYTES);
    if (over) await unlink(`${dir}/${file.name}`).catch(() => {});
    else { kept += 1; bytes += file.size; }
  }
}

// Local: the original path. Remote: one cache file per (machine, path, mtime, size).
// Concurrent callers for that key share one fetch. maxBytes limits preview fetches;
// an explicit download omits it.
export async function materialize(source, onProgress, opts = {}) {
  const st = await statSource(source);
  if (!st) {
    const error = new Error("This file is no longer available");
    error.code = "missing";
    throw error;
  }
  if (source.on && opts.maxBytes != null && st.size > opts.maxBytes) {
    const error = new Error("Too large to preview");
    error.code = "too-large";
    error.size = st.size;
    throw error;
  }
  if (!source.on) return { abs: source.path, rel: null, size: st.size, mtime: st.mtime };
  await ensureCache();
  const id = cacheId(source, st.size, st.mtime);
  const ext = extension(source.path);
  const name = ext ? `${id}.${ext}` : id;
  const rel = `data/files-preview-cache/${name}`;
  const abs = `${cacheDir()}/${name}`;
  if (await fileSize(abs) === st.size) {
    onProgress?.(st.size, st.size);
    return { abs, rel, size: st.size, mtime: st.mtime };
  }
  const job = share(id, async (progress) => {
    const part = `${abs}.part`;
    try {
      await fetchChunks(source.on, source.path, part, st.size, progress);
      const mv = await exec("mv", ["-f", part, abs]);
      if (mv.code !== 0) throw new Error(mv.stderr.trim() || "Could not store the file");
    } catch (error) {
      await exec("rm", ["-f", part]);
      throw error;
    }
    await pruneCache();
  });
  const mine = (got, total) => onProgress?.(got, total);
  job.listeners.add(mine);
  try {
    await job.promise;
  } finally {
    job.listeners.delete(mine);
  }
  return { abs, rel, size: st.size, mtime: st.mtime };
}

function splitName(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

export async function downloadToDownloads(source, onProgress) {
  const dir = `${home()}/Downloads`;
  const { base, ext } = splitName(baseName(source.path) || "download");
  let dest = `${dir}/${base}${ext}`;
  for (let n = 1; await exists(dest); n++) dest = `${dir}/${base} (${n})${ext}`;
  if (!source.on) {
    const cp = await exec("cp", ["-f", source.path, dest]);
    if (cp.code !== 0) throw new Error(cp.stderr.trim() || "Could not copy the file");
    return dest;
  }
  const st = await statSource(source);
  if (!st) throw new Error("This file is no longer available");
  const part = `${dest}.part`;
  try {
    await fetchChunks(source.on, source.path, part, st.size, onProgress);
    const mv = await exec("mv", ["-f", part, dest]);
    if (mv.code !== 0) throw new Error(mv.stderr.trim() || "Could not save the download");
  } catch (error) {
    await exec("rm", ["-f", part]);
    throw error;
  }
  return dest;
}

export async function pixels(abs) {
  const r = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", abs]).catch(() => ({ stdout: "" }));
  const width = Number(/pixelWidth: (\d+)/.exec(r.stdout)?.[1]);
  const height = Number(/pixelHeight: (\d+)/.exec(r.stdout)?.[1]);
  return { width: width || undefined, height: height || undefined };
}

// image() draws an encoded file up to 16 MiB and a side up to 16384 px; past
// either it draws nothing. Pixel count is not the limit: 6016 × 6016 draws.
const MAX_ENCODED = 16 * 1024 * 1024;
const MAX_SIDE = 16384;

async function sips(args) {
  const r = await exec("sips", args, { timeout: 120000 });
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "No preview");
}

// The original when image() can draw it, else a full-size copy re-encoded to
// fit: PNG for formats image() can't decode, JPEG when PNG is still too big,
// and smaller only when JPEG at full size is too big.
// Returns { abs, ext } to draw and the original's pixel size.
export async function stageImage(source, file) {
  const ext = extension(source.path);
  const dim = ext === "svg" ? {} : await pixels(file.abs);
  const side = Math.max(dim.width || 0, dim.height || 0);
  if (VIEWABLE.has(ext) && file.size <= MAX_ENCODED && side <= MAX_SIDE) return { abs: file.abs, ext, ...dim };
  await ensureCache();
  const id = cacheId(source, file.size, file.mtime);
  for (const out of ["png", "jpg"]) {
    const abs = `${cacheDir()}/${id}.view.${out}`;
    const have = await fileSize(abs);
    if (have > 0 && have <= MAX_ENCODED) return { abs, ext: out, ...dim };
  }
  const png = `${cacheDir()}/${id}.view.png`;
  const fits = side <= MAX_SIDE ? [] : ["-Z", String(MAX_SIDE)];
  if (!VIEWABLE.has(ext) || side > MAX_SIDE) {
    await sips([...fits, "-s", "format", "png", file.abs, "--out", png]);
    if (await fileSize(png) <= MAX_ENCODED) return { abs: png, ext: "png", ...dim };
    await unlink(png).catch(() => {});
  }
  const jpg = `${cacheDir()}/${id}.view.jpg`;
  let limit = Math.min(side || MAX_SIDE, MAX_SIDE);
  for (let i = 0; i < 8; i++) {
    await sips(["-Z", String(limit), "-s", "format", "jpeg", "-s", "formatOptions", "92", file.abs, "--out", jpg]);
    if (await fileSize(jpg) <= MAX_ENCODED) return { abs: jpg, ext: "jpg", ...dim };
    limit = Math.floor(limit * 0.8);
  }
  throw new Error("No preview");
}

// image() keeps every path it has drawn decoded for the life of the app, so
// previews reuse a fixed set of slot files. A rewrite under mods/ redraws the
// slot; under data/ it stays stale.
export const SLOT_DIR = "mods/files-preview-slots";

export async function placeInSlot(abs, name) {
  const dir = `${appHome()}/${SLOT_DIR}`;
  await mkdir(dir, { recursive: true });
  const r = await exec("sh", ["-c", 'cp -f "$1" "$2.tmp" && mv -f "$2.tmp" "$2"', "slot", abs, `${dir}/${name}`]);
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || "No preview");
  return `${SLOT_DIR}/${name}`;
}
