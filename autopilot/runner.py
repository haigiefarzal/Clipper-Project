"""Tangan KlipKu: mengambil tugas dari otak cloud lalu mengerjakannya di laptop.
Dua jalur paralel supaya analisis VOD panjang tidak menahan render/upload:
  jalur 'analisis' : analyze, resolve
  jalur 'produksi' : upload, recaption, render (render memakai antrean KlipKu yang sama dengan render manual)
Tambahan: pantau channel Twitch (tiap 10 menit) & cek apakah posting terjadwal sudah tayang."""
import collections
import json
import os
import re
import socket
import subprocess
import threading
import time
import traceback

from . import analyze as AN
from . import cloud as CL
from . import net, telegram as TG, uploader as UP

LANES = {"analisis": ["analyze", "resolve"], "produksi": ["upload", "recaption", "render"]}
STATE = {"running": False, "connected": False, "last_poll": 0, "last_error": "", "lanes": {}, "log": collections.deque(maxlen=200)}
_stop = threading.Event()
_threads = []
_lock = threading.Lock()


def log(msg):
    line = time.strftime("%H:%M:%S ") + str(msg)
    STATE["log"].append(line)
    try:
        APP.log("autopilot: " + str(msg))
    except Exception:  # noqa
        pass


APP = None   # modul app (KlipKu) diisi saat start()
ES = None


def cfg():
    return dict((APP.load_settings().get("autopilot") or {}))


def save_cfg(upd):
    with _lock:
        st = APP.load_settings()
        a = dict(st.get("autopilot") or {})
        a.update(upd)
        st["autopilot"] = a
        APP.save_settings(st)
        return a


def keys():
    return dict(APP.load_settings().get("keys") or {})


def _store(name):
    p = APP.WORK / "autopilot"
    p.mkdir(parents=True, exist_ok=True)
    return p / name


def _load(name, default):
    try:
        return json.loads(_store(name).read_text(encoding="utf-8"))
    except Exception:  # noqa
        return default


def _save(name, data):
    _store(name).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def cloud():
    c = cfg()
    if not c.get("worker_url") or not c.get("worker_key"):
        return None
    return CL.Cloud(c["worker_url"], c["worker_key"])


def ready():
    c = cfg()
    return bool(c.get("worker_url") and c.get("worker_key") and c.get("tg_token") and c.get("owner_id"))


# ============================================================================ caption

def credit_name(info):
    if info.get("platform") == "twitch" and str(info.get("channel_id") or "").startswith("twitch:"):
        return "twitch.tv/" + info["channel_id"][7:]
    return info.get("channel") or info.get("uploader") or ""


def default_tags(info):
    name = re.sub(r"[^A-Za-z0-9]", "", (info.get("channel") or "").lower())
    return " ".join(t for t in (f"#{name}" if name else "", "#clip", "#fyp", "#streamer" if info.get("was_live") else "") if t)


def finish_caption(text, info, c):
    text = re.sub(r"[*|]", "", text or "").strip()
    if not text:
        return ""
    if not re.search(r"#\w", text):
        text += "\n\n" + default_tags(info)
    if c.get("caption_credit", True) and "Sumber" not in text:
        text += f"\n🎥 Sumber: {credit_name(info)}"
    return text[:2100]


def ai_captions(hook, moment_caption, info, extra_rule="", old=None):
    """3 pilihan caption dari Gemini/Claude (pakai contoh caption yang pernah dipilih Agie)."""
    k = keys()
    prov = "gemini" if k.get("gemini") else "claude" if k.get("claude") else None
    if not prov:
        return []
    taste = []
    try:
        st = cloud().call("/api/state", {}, timeout=20)
        taste = [t["caption"] for t in st.get("taste") or [] if t.get("caption")][:8]
    except Exception:  # noqa
        pass
    prompt = ("Buat 3 caption TikTok bahasa Indonesia untuk clip ini.\n"
              f"Channel: {info.get('channel')}. Judul video: {info.get('title')}.\n"
              f"Judul hook clip: {re.sub(r'[*|]', '', hook or '')}\nDeskripsi momen: {moment_caption or '-'}\n"
              "Gaya 1: santai & natural. Gaya 2: bikin penasaran. Gaya 3: lucu/gaul. Masing-masing 1-2 kalimat, "
              "maksimal 1-2 emoji, lalu 3-5 hashtag relevan (termasuk nama channel). Jujur, jangan clickbait bohong.\n"
              + (f"Contoh caption yang disukai pemilik akun (tiru gayanya): {json.dumps(taste, ensure_ascii=False)}\n" if taste else "")
              + (f"Harus BEDA dari caption sebelumnya: {json.dumps(old, ensure_ascii=False)}\n" if old else "")
              + extra_rule + 'Jawab HANYA JSON: {"captions": ["...", "...", "..."]}')
    try:
        if prov == "gemini":
            res = ES._http_json(ES.GEMINI_URL.format(model=cfg().get("gemini_model") or "gemini-flash-latest"),
                                {"contents": [{"parts": [{"text": prompt}]}],
                                 "generationConfig": {"temperature": 0.9, "responseMimeType": "application/json"}},
                                {"x-goog-api-key": k["gemini"]}, timeout=90)
            text = res["candidates"][0]["content"]["parts"][0]["text"]
        else:
            res = ES._http_json(ES.CLAUDE_URL, {"model": "claude-haiku-5-5", "max_tokens": 1200,
                                                "messages": [{"role": "user", "content": prompt}]},
                                {"x-api-key": k["claude"], "anthropic-version": "2023-06-01"}, timeout=90)
            text = "".join(b.get("text", "") for b in res.get("content", []))
        m = re.search(r"\{.*\}", text, flags=re.S)
        return [str(x).strip() for x in (json.loads(m.group(0)).get("captions") or []) if str(x).strip()][:3] if m else []
    except Exception as ex:  # noqa
        log(f"caption AI gagal: {ex}")
        return []


def clip_text(cid, meta, captions):
    nums = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"]
    head = (f"🎞️ <b>Clip #{cid} siap</b> · {APP_esc(meta.get('channel'))} · {meta.get('duration', 0):.0f} dtk\n"
            f"⏱ {APP.fmt_time(meta.get('start', 0))}–{APP.fmt_time(meta.get('end', 0))}"
            + (f"\n🪝 {APP_esc(re.sub(r'[*|]', '', meta.get('hook') or ''))}" if meta.get("hook") else "") + "\n\n<b>Pilih caption:</b>\n")
    tail = "\n✍️ Atau <b>balas (reply)</b> pesan ini dengan caption sendiri."
    room = max(80, (1000 - len(head) - len(tail)) // max(1, len(captions)) - 6)
    body = "\n".join(f"{nums[i]} {APP_esc(c[:room] + ('…' if len(c) > room else ''))}" for i, c in enumerate(captions[:4]))
    return tg_fit(head + body + tail)


def tg_fit(text, n=1024):
    """Potong teks HTML Telegram dengan aman (tag tidak terpotong setengah)."""
    if len(text) <= n:
        return text
    plain = re.sub(r"<[^>]+>", "", text)
    plain = plain[:n - 1]
    plain = re.sub(r"&[a-z#0-9]*$", "", plain)
    return plain + "…"


def APP_esc(s):
    return str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ============================================================================ tugas

class JobCtx:
    def __init__(self, cl, job):
        self.cl, self.job = cl, job
        self.cancelled = False
        self._last = 0

    def progress(self, text, force=False):
        log(f"#{self.job['id']} {text}")
        if force or time.time() - self._last > 15:
            self._last = time.time()
            r = self.cl.progress(self.job["id"], text, self.job["payload"].get("title"))
            if r.get("cancel"):
                self.cancelled = True


def do_analyze(ctx):
    p = ctx.job["payload"]
    c = cfg()
    res = AN.analyze(APP, ES, p, c, keys(), ctx.progress, lambda: ctx.cancelled)
    moments = res["moments"]
    tok, owner = c["tg_token"], c["owner_id"]
    if moments:
        payload = [{k: m.get(k) for k in ("start", "end", "intro", "skor", "kategori", "info", "hooks", "caption")} for m in moments]
        ids = ctx.cl.call("/api/moments", {"video_id": p["video_id"], "moments": payload})["ids"]
        items = []
        icon = {"lucu": "😂", "kaget": "😱", "menakjubkan": "🤯", "clutch": "🎯", "drama": "🎭", "wholesome": "🥹", "quote": "💬"}
        for i, (mid, m) in enumerate(zip(ids, moments)):
            text = (f"🃏 <b>Momen {i + 1}/{len(moments)}</b> · {icon.get(m['kategori'], '✨')} {APP_esc(m['kategori'] or 'momen')}"
                    f" · skor {m['skor']}{' · 🤔 ragu' if m.get('ragu') else ''}\n"
                    f"📺 {APP_esc(res['channel'])}, {APP_esc(res['title'][:80])}\n"
                    f"⏱ {APP.fmt_time(m['start'])}–{APP.fmt_time(m['end'])} ({m['end'] - m['start']:.0f} dtk)\n"
                    + (f"\n{APP_esc(m['info'])}" if m.get("info") else "")
                    + (f"\n💬 “{APP_esc(m['kutipan'])}”" if m.get("kutipan") else "")
                    + ("\n🪝 " + " / ".join(APP_esc(re.sub(r'[*|]', '', h)) for h in m["hooks"][:2]) if m.get("hooks") else ""))
            text = tg_fit(text)
            try:
                if m.get("preview"):
                    r = TG.send_video(tok, owner, str(m["preview"]), text, duration=m["end"] - m["start"])
                else:
                    r = TG.call(tok, "sendMessage", {"chat_id": owner, "text": text, "parse_mode": "HTML"})
                items.append({"type": "moment", "id": mid, "msg_id": r["message_id"]})
            except TG.TgError as ex:
                log(f"kartu momen gagal: {ex}")
            time.sleep(1.2)
        ctx.cl.call("/api/msgs", {"items": items})
    AN.cleanup(res["workdir"])
    note = "; ".join(res["notes"])[:300]
    return {"moments": len(moments), "title": res["title"], "note": note}


def build_opts(p, info):
    st = APP.load_settings()
    base = {"aspect": "9:16", "layout": "static", "zoom": 1.65, "pan_x": 0.5, "pan_y": 0.5, "bg": "blur", "fps": "30",
            "subs": True, "model": "large-v3-turbo", "lang": "id", "sub_style": "highlight", "sub_size": 80, "per_line": 3,
            "uppercase": True, "sub_color": "kuning", "sub_text": "putih", "sub_outline": 9, "credit": True,
            "hook_tpl": "kutipan", "hook_size": 58, "loud_on": True, "cover_on": True, "encoder": "auto", "crf": 18}
    base.update(st.get("last") or {})
    preset = (st.get("presets") or {}).get(p.get("gaya") or "")
    if preset:
        base.update(preset)
    ch = APP.channel_settings(info.get("channel_id"))
    o = dict(base)
    o["url"] = info["url"]
    o["review"] = False
    o["cam"] = ch.get("cam") or base.get("cam")
    if ch.get("terms") and not o.get("prompt"):
        o["prompt"] = ch["terms"]
    k = keys()
    hook = p.get("hook") or ""
    if hook:
        o["hook_ai"] = "off"
    elif o.get("subs", True) and (k.get("gemini") or k.get("claude")):
        o["hook_ai"] = "gemini" if k.get("gemini") else "claude"
    else:
        o["hook_ai"] = "off"
    notes = []
    if o.get("layout") == "facecam" and not o.get("cam"):
        o["layout"] = "static"
        notes.append("posisi facecam channel ini belum pernah diatur di KlipKu, jadi pakai layout Tengah")
    intro = p.get("intro")
    # 1 desimal: "1234.50" akan dibaca parse_time sebagai 1234:50 (menit:detik), "1234.5" aman
    clip = {"start": f"{float(p['start']):.1f}", "end": f"{float(p['end']):.1f}", "title": hook,
            "intro": f"{float(intro):.1f}" if (intro is not None and o.get("intro_on")) else ""}
    o["clips"] = [clip]
    return o, notes


def do_render(ctx):
    p = ctx.job["payload"]
    c = cfg()
    info = APP.get_info(p["url"])
    o, notes = build_opts(p, info)
    job = APP.Job(o)
    job.source = "autopilot"
    APP.JOBS[job.id] = job
    APP.JOBQ.put(job)
    ctx.progress("menunggu giliran render di KlipKu...", force=True)
    while job.status in ("antre", "jalan", "cek_subtitle"):
        time.sleep(2)
        ctx.progress(f"{job.stage} · {int(job.progress * 100)}%")
        if _stop.is_set():
            raise RuntimeError("KlipKu ditutup saat render")
    if job.status != "selesai" or not job.outputs:
        raise RuntimeError(job.error or "Render gagal")
    out = job.outputs[0]
    path = APP.OUT / out["name"]
    _, _, _, dur = APP.probe(path)
    ctx.progress("menyiapkan preview & caption...", force=True)
    # preview untuk Telegram (bot maks 50 MB)
    prev = path
    if path.stat().st_size > 45 * 1024 * 1024:
        prev = APP.WORK / "autopilot" / f"prev_{p['clip_id']}.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-vf", "scale=-2:1280", "-c:v", "libx264",
                        "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
                        str(prev)], capture_output=True)
    hook = out.get("title") or p.get("hook") or ""
    caps = []
    m_cap = p.get("caption") or ""
    if m_cap:
        caps.append(finish_caption(m_cap, info, c))
    for x in ai_captions(hook, p.get("info") or m_cap, info, old=p.get("old_captions")):
        fx = finish_caption(x, info, c)
        if fx and fx not in caps:
            caps.append(fx)
    if len(caps) < 2:
        base_cap = out.get("caption", "").split("\n\nSumber:")[0] if out.get("caption") else ""
        for x in (base_cap, hook, f"{hook} 😭" if hook else ""):
            fx = finish_caption(x, info, c)
            if fx and fx not in caps:
                caps.append(fx)
    caps = caps[:3] or [finish_caption(info.get("title") or "clip", info, c)]
    meta = {"channel": info.get("channel"), "start": float(p["start"]), "end": float(p["end"]), "duration": dur,
            "hook": hook, "file": out["name"], "url": info["url"], "info": p.get("info", ""), "title": info.get("title"),
            "platform": info.get("platform"), "channel_id": info.get("channel_id"), "was_live": info.get("was_live")}
    clips = _load("clips.json", {})
    clips[str(p["clip_id"])] = meta
    _save("clips.json", clips)
    cover = APP.OUT / (path.stem + "_cover.jpg")
    w, h, _, _ = APP.probe(prev)
    r = TG.send_video(c["tg_token"], c["owner_id"], str(prev), clip_text(p["clip_id"], meta, caps), w, h, dur,
                      thumb=str(cover) if cover.exists() else None)
    ctx.cl.call("/api/msgs", {"items": [{"type": "clip", "id": p["clip_id"], "msg_id": r["message_id"], "captions": caps,
                                         "file_key": out["name"], "duration": dur, "hook": hook}]})
    if prev != path:
        prev.unlink(missing_ok=True)
    if notes or job.warnings:
        ctx.cl.call("/api/notify", {"text": f"ℹ️ Clip #{p['clip_id']}: " + "; ".join(notes + list(dict.fromkeys(job.warnings)))[:900]})
    return {"clip_id": p["clip_id"], "file": out["name"]}


def do_recaption(ctx):
    p = ctx.job["payload"]
    meta = _load("clips.json", {}).get(str(p["clip_id"]))
    if not meta:
        raise RuntimeError("Data clip ini tidak ada di laptop (mungkin dirender di komputer lain).")
    info = {"channel": meta.get("channel"), "title": meta.get("title"), "platform": meta.get("platform"),
            "channel_id": meta.get("channel_id"), "was_live": meta.get("was_live")}
    caps = [finish_caption(x, info, cfg()) for x in ai_captions(meta.get("hook"), meta.get("info"), info, old=p.get("captions"))]
    caps = [x for x in caps if x]
    if not caps:
        raise RuntimeError("AI tidak memberi caption (cek API key Gemini/Claude).")
    return {"captions": caps, "text": clip_text(p["clip_id"], meta, caps)}


def do_upload(ctx):
    p = ctx.job["payload"]
    c = cfg()
    path = APP.OUT / (p.get("file_key") or "")
    if not p.get("file_key") or not path.exists():
        raise UP.UploadError("File clip tidak ditemukan di folder hasil (mungkin sudah dihapus/dipindah).")
    ctx.progress("mengirim video ke layanan upload...", force=True)
    sched = int(p.get("scheduled_at") or time.time())
    res = UP.post(c, str(path), p.get("caption") or "", sched)
    if res.get("post_id") and not res.get("url"):   # cek nanti sampai link TikTok-nya ada
        posts = _load("posts.json", [])
        posts.append({"clip_id": p["clip_id"], "post_id": res["post_id"], "at": sched})
        _save("posts.json", posts)
    return res


def do_resolve(ctx):
    p = ctx.job["payload"]
    url = p["url"].rstrip("/")
    target = url if re.search(r"/(videos|streams|featured)$", url) else url + "/videos"
    code, out = AN._run(APP.ytdlp() + ["--flat-playlist", "-I", "1", "-J", "--no-warnings", target], timeout=180)
    try:
        data = json.loads(out[out.index("{"):])
    except ValueError:
        raise RuntimeError("Gagal membaca channel: " + out[-300:])
    ref = data.get("channel_id") or data.get("uploader_id") or data.get("id")
    if not ref or not str(ref).startswith("UC"):
        m = re.search(r"(UC[\w-]{22})", json.dumps(data))
        ref = m.group(1) if m else ref
    return {"ref": ref, "name": data.get("channel") or data.get("uploader") or data.get("title"), "platform": "youtube"}


HANDLERS = {"analyze": do_analyze, "render": do_render, "upload": do_upload, "recaption": do_recaption, "resolve": do_resolve}


# ============================================================================ loop

def presets():
    return sorted((APP.load_settings().get("presets") or {}).keys())


def lane_loop(name, kinds):
    host = socket.gethostname()
    while not _stop.is_set():
        cl = cloud()
        if not cl or not cfg().get("enabled"):
            STATE["lanes"][name] = "mati"
            _stop.wait(5)
            continue
        busy = " · ".join(v for v in STATE["lanes"].values() if v not in ("siap", "mati", ""))
        try:
            r = cl.poll(kinds=kinds, host=host if name == "analisis" else None, version=APP.VERSION, busy=busy,
                        presets=presets(), upload_ok=UP.configured(cfg()), announce=True)
            STATE["connected"], STATE["last_poll"], STATE["last_error"] = True, time.time(), ""
            if name == "analisis":
                STATE["twitch"] = r.get("twitch") or []
        except net.NetError as ex:
            STATE["connected"] = False
            STATE["last_error"] = str(ex)[:300]
            STATE["lanes"][name] = "tidak tersambung"
            _stop.wait(20)
            continue
        job = r.get("job")
        if not job:
            STATE["lanes"][name] = "siap"
            _stop.wait(8)
            continue
        label = {"analyze": "menganalisis", "render": "merender", "upload": "mengupload", "recaption": "menulis caption",
                 "resolve": "membaca channel"}.get(job["kind"], job["kind"])
        STATE["lanes"][name] = f"{label} #{job['id']}"
        log(f"tugas #{job['id']} {job['kind']} diambil")
        ctx = JobCtx(cl, job)
        try:
            res = HANDLERS[job["kind"]](ctx)
            cl.done(job["id"], res)
            log(f"tugas #{job['id']} selesai")
        except AN.Defer as ex:
            cl.fail(job["id"], str(ex), retry=True, delay=ex.delay, defer=True)
            log(f"tugas #{job['id']} ditunda: {ex}")
        except AN.Cancelled:
            log(f"tugas #{job['id']} dibatalkan dari Telegram")
        except UP.UploadError as ex:
            cl.fail(job["id"], str(ex), retry=ex.retry, delay=300)
            log(f"tugas #{job['id']} gagal: {ex}")
        except Exception as ex:  # noqa
            msg = str(ex) or ex.__class__.__name__
            retry = isinstance(ex, net.NetError) or "timeout" in msg.lower() or "Sign in to confirm" in msg
            log(f"tugas #{job['id']} gagal: {msg}\n{traceback.format_exc()[-600:]}")
            try:
                cl.fail(job["id"], msg, retry=retry, delay=900)
            except net.NetError:
                pass
        STATE["lanes"][name] = "siap"


def twitch_loop():
    while not _stop.is_set():
        try:
            _twitch_round()
        except Exception as ex:  # noqa
            log(f"pemantau Twitch error: {ex}\n{traceback.format_exc()[-500:]}")
            _stop.wait(60)


_tw = {"last": 0.0}


def _twitch_round():
    if True:
        _stop.wait(min(30.0, float(os.environ.get("KLIPKU_TWITCH_EVERY", 600))))
        if time.time() - _tw["last"] < float(os.environ.get("KLIPKU_TWITCH_EVERY", 600)) or not cfg().get("enabled"):
            return
        cl = cloud()
        chans = STATE.get("twitch") or []
        if not cl or not chans:
            return
        _tw["last"] = time.time()
        seen = _load("twitch_seen.json", {})
        for ch in chans:
            login = ch["ref"]
            code, out = AN._run(APP.ytdlp() + ["--flat-playlist", "-J", "-I", "1:5", "--no-warnings",
                                               f"https://www.twitch.tv/{login}/videos?filter=archives&sort=time"], timeout=120)
            try:
                data = json.loads(out[out.index("{"):])
            except ValueError:
                log(f"cek Twitch {login} gagal: {out[-200:]}")
                continue
            first = login not in seen
            known = set(seen.get(login, []))
            for e in data.get("entries") or []:
                vid = str(e.get("id") or "")
                if not vid:
                    continue
                vid = vid if vid.startswith("v") else "v" + vid
                if vid in known:
                    continue
                known.add(vid)
                try:
                    cl.call("/api/video", {"channel_id": ch["id"], "video_id": f"tw:{vid}", "old": first,
                                           "url": f"https://www.twitch.tv/videos/{vid[1:]}", "title": e.get("title") or ""})
                    if not first:
                        log(f"VOD Twitch baru: {login} {vid}")
                except net.NetError as ex:
                    log(f"lapor VOD gagal: {ex}")
            seen[login] = list(known)[-50:]
        _save("twitch_seen.json", seen)


def posts_loop():
    while not _stop.is_set():
        try:
            _posts_round()
        except Exception as ex:  # noqa
            log(f"cek posting error: {ex}")
            _stop.wait(60)


def _posts_round():
    if True:
        _stop.wait(float(os.environ.get("KLIPKU_POSTS_EVERY", 600)))
        cl = cloud()
        posts = _load("posts.json", [])
        if not cl or not posts:
            return
        keep = []
        for x in posts:
            if time.time() < x["at"] + float(os.environ.get("KLIPKU_POSTS_GRACE", 180)):
                keep.append(x)
                continue
            try:
                st = UP.status(cfg(), x["post_id"])
            except Exception as ex:  # noqa
                st = None
                log(f"cek status posting gagal: {ex}")
            if st and st.get("status") == "published":
                cl.call("/api/posted", {"clip_id": x["clip_id"], "url": st.get("url")})
            elif st and st.get("status") in ("failed", "error"):
                cl.call("/api/notify", {"text": f"❌ TikTok menolak clip #{x['clip_id']}. Cek di dashboard layanan upload."})
            elif time.time() - x["at"] < 2 * 86400:
                keep.append(x)
        _save("posts.json", keep)


def otak_version():
    m = re.search(r'const VERSI = "([^"]+)"', (CL.HERE / "otak.js").read_text(encoding="utf-8"))
    return m.group(1) if m else "?"


def auto_update():
    """Kalau KlipKu diperbarui dan otak.js berubah versi, pasang ulang otak cloud otomatis (pakai token tersimpan)."""
    c = cfg()
    if not (c.get("worker_url") and c.get("cf_token")):
        return
    try:
        live = net.request("GET", c["worker_url"] + "/sehat", raw=True, timeout=20).decode("utf-8", "replace")
    except net.NetError:
        return
    want = otak_version()
    if f"v{want} " in live:
        return
    log(f"Memperbarui otak cloud ke v{want}...")
    try:
        res = CL.deploy(c, log=log)
        save_cfg(res)
        log("Otak cloud diperbarui.")
    except Exception as ex:  # noqa
        log(f"Gagal memperbarui otak cloud: {ex}")


def init(app_module):
    global APP, ES
    APP = app_module
    ES = app_module.ES


def start(app_module):
    init(app_module)
    if STATE["running"]:
        return
    _stop.clear()
    STATE["running"] = True
    for name, kinds in LANES.items():
        STATE["lanes"][name] = "mulai"
        t = threading.Thread(target=lane_loop, args=(name, kinds), daemon=True, name=f"ap-{name}")
        t.start()
        _threads.append(t)
    for fn in (twitch_loop, posts_loop, auto_update):
        t = threading.Thread(target=fn, daemon=True, name=f"ap-{fn.__name__}")
        t.start()
        _threads.append(t)
    log("Autopilot jalan")


def public_state():
    c = cfg()
    return {"running": STATE["running"], "enabled": bool(c.get("enabled")), "connected": STATE["connected"],
            "last_poll": STATE["last_poll"], "last_error": STATE["last_error"], "lanes": STATE["lanes"],
            "log": list(STATE["log"])[-60:], "ready": ready()}
