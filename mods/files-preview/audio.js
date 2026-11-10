// One copy's audio player: player.jxa runs AVAudioPlayer in its own process.
// Each start gets its own folder; removing the folder stops that player
// within 0.1 s (its heartbeat file is gone).
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { mkdir, readFile, writeFile } from "fs/promises";
import { appHome, exec, theme } from "herdr";

const PLAYER = "mods/files-preview/player.jxa";

function clock(s) {
  if (!Number.isFinite(s)) return "0:00";
  const total = Math.max(0, Math.floor(s));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export class AudioPlayer {
  constructor(slot) {
    this.root = `${appHome()}/data/files-preview-audio/s${slot}`;
    this.dir = null;
    this.state = null;
    this.seq = 0;
    this.runs = 0;
  }

  async start(abs) {
    await this.stop();
    const dir = `${this.root}/${Date.now()}-${++this.runs}`;
    this.dir = dir;
    this.state = { t: 0, dur: 0, playing: false, loading: true };
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/hb`, "");
    const r = await exec("sh", ["-c", 'osascript -l JavaScript "$1" "$2" "$3" </dev/null >/dev/null 2>&1 &', "player", `${appHome()}/${PLAYER}`, abs, dir]);
    if (r.code !== 0) throw new Error("Can't play this file");
  }

  async stop() {
    const dir = this.dir;
    this.dir = null;
    this.state = null;
    if (dir) await exec("rm", ["-rf", dir]);
  }

  async send(op, extra) {
    if (!this.dir) return;
    this.seq += 1;
    await writeFile(`${this.dir}/cmd.json`, JSON.stringify({ seq: this.seq, op, ...extra }));
  }

  // Keeps the player alive and returns true when what it shows changed.
  async poll() {
    const dir = this.dir;
    if (!dir) return false;
    await writeFile(`${dir}/hb`, "");
    let next;
    try { next = JSON.parse(await readFile(`${dir}/state.json`, "utf8")); }
    catch { return false; }
    if (this.dir !== dir) return false;
    const prev = this.state;
    if (next.error) {
      this.state = { error: true };
      return !prev?.error;
    }
    const pending = prev?.pending;
    if (pending && (next.seq ?? 0) < pending.seq && Date.now() - pending.at < 1000) next = { ...next, ...pending.view, pending };
    this.state = next;
    return !prev || prev.loading || prev.playing !== next.playing || Math.floor(prev.t * 4) !== Math.floor(next.t * 4) || prev.dur !== next.dur;
  }

  toggle(cx) {
    const s = this.state;
    if (!s || s.loading || s.error) return;
    const play = !s.playing;
    const t = play && s.dur && s.t >= s.dur - 0.05 ? 0 : s.t;
    this.optimistic({ playing: play, t }, t !== s.t ? 2 : 1);
    cx.spawn(async () => {
      if (t !== s.t) await this.send("seek", { t });
      await this.send(play ? "play" : "pause");
    });
    cx.notify();
  }

  seek(fraction, cx) {
    const s = this.state;
    if (!s?.dur) return;
    const t = Math.max(0, Math.min(1, fraction)) * s.dur;
    this.optimistic({ t }, 1);
    cx.spawn(async () => { await this.send("seek", { t }); });
    cx.notify();
  }

  // The player answers within about 0.2 s; until then the control shows what was asked.
  optimistic(view, sends) {
    this.state = { ...this.state, ...view, pending: { seq: this.seq + sends, at: Date.now(), view } };
  }

  render(name) {
    const t = theme(), s = this.state ?? { loading: true };
    if (s.error) return div().p(12).text_color(t.dim).child("Can't play this file");
    const progress = s.dur ? Math.max(0, Math.min(1, s.t / s.dur)) : 0;
    return v_flex().flex_1().min_h(0).items_center().justify_center().gap(18).px(24)
      .child(svg("mods/files-preview/music.svg").size(56).text_color(t.muted))
      .child(div().max_w_full().truncate().text_size(14).text_color(t.foreground).child(name))
      .child(h_flex().w_full().max_w(420).gap(10).items_center()
        .child(div().id("audio-toggle").size(30).flex_none().flex().items_center().justify_center().rounded_full()
          .bg(s.loading ? t.raised : t.solid).text_color(t.solid_foreground)
          .when(!s.loading, (el) => el.cursor_pointer().hover((st) => st.opacity(0.85)).on_click((_e, cx) => this.toggle(cx)))
          .child(svg(`mods/files-preview/${s.playing ? "pause" : "play"}.svg`).size(14).text_color(t.solid_foreground)))
        .child(div().w(42).flex_none().text_size(11).text_color(t.muted).text_right().child(clock(s.t)))
        .child(div().id("audio-scrub").flex_1().h(16).flex().items_center().cursor_pointer()
          .on_mouse_down("left", (e, cx) => {
            if (e.local_position && e.bounds?.width) this.seek(e.local_position.x / e.bounds.width, cx);
          })
          .child(div().w_full().h(4).rounded(2).bg(t.border).relative()
            .child(div().absolute().left(0).top(0).h(4).rounded(2).bg(t.accent).w(`${(progress * 100).toFixed(2)}%`))))
        .child(div().w(42).flex_none().text_size(11).text_color(t.dim).child(clock(s.dur))));
  }
}
