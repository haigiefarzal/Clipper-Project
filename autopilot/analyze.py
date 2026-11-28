"""Pencari momen untuk Autopilot.

Langkah:
1. Sinyal murah (gratis) di seluruh video: lonjakan live chat (YouTube), suara keras/heboh (semua platform),
   kata reaksi di subtitle otomatis YouTube. -> 10-20 kandidat menit.
2. Tiap kandidat: potongan 90 detik resolusi kecil diunduh, lalu Gemini MENONTON potongan itu (gambar + suara)
   dan menentukan awal/akhir yang pas, menit intro, skor, judul hook, caption.
3. (Opsional) Claude sebagai editor: urutkan ulang & rapikan judul/caption.
4. Ambil yang terbaik sesuai kuota channel. Preview kecil tiap momen dipakai untuk kartu Telegram.
Tanpa API key Gemini tetap jalan (pakai sinyal saja), hanya kurang pintar.
"""
import base64
import json
import re
import shutil
import subprocess
import time
from pathlib import Path

REACT = re.compile(r"(?:w+k+){2,}|wkwk|w{3,}|ha(?:ha)+|he(?:he)+|anj(?:i|ay|ir|rit|ing)?\b|asw|ngakak|kocak|lol\b|lmao|"
                   r"gila|parah|clip\s*it|klip|wtf|omg|wow|gg\b|kaget|astaga|anjay|bjir|😂|🤣|💀|😭|🔥|‼|!!", re.I)
SUB_REACT = re.compile(r"\[(?:tertawa|tawa|laughter|laughs|teriak|screams?|tepuk tangan|applause)\]|wkwk|haha|anjir|astaga|"
                       r"ya allah|gila|hah\b|loh loh", re.I)


class Defer(Exception):
    """Belum bisa diproses sekarang (misal masih live) -> coba lagi nanti tanpa dihitung gagal."""

    def __init__(self, msg, delay=1200):
        super().__init__(msg)
        self.delay = delay


class Cancelled(Exception):
    pass


def _run(cmd, timeout, cwd=None):
    p = subprocess.Popen([str(c) for c in cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                         encoding="utf-8", errors="replace", cwd=cwd)
    try:
        out, _ = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        out, _ = p.communicate()
        return 124, out or ""
    return p.returncode, out or ""


# ============================================================================ sinyal

def chat_signal(app, url, wd, nbins, progress):
    """Live chat replay YouTube -> (jumlah pesan per 10 dtk, kata reaksi per 10 dtk, pesan per bin)."""
    for f in wd.glob("chat*"):
        f.unlink(missing_ok=True)
    progress("mengambil chat replay (live chat)...")
    code, out = _run(app.ytdlp() + ["--skip-download", "--write-subs", "--sub-langs", "live_chat", "--no-warnings",
                                    "--no-playlist", "-o", str(wd / "chat.%(ext)s"), url], timeout=25 * 60)
    files = list(wd.glob("chat*.json")) + list(wd.glob("chat*.json.part"))
    if not files:
        return None
    cnt, kw, msgs = [0.0] * nbins, [0.0] * nbins, [[] for _ in range(nbins)]
    n = 0
    with open(files[0], encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            act = o.get("replayChatItemAction") or {}
            off = o.get("videoOffsetTimeMsec") or act.get("videoOffsetTimeMsec")
            if off is None:
                continue
            b = int(int(off) / 10000)
            if not 0 <= b < nbins:
                continue
            for a in act.get("actions") or []:
                item = (a.get("addChatItemAction") or {}).get("item") or {}
                r = item.get("liveChatTextMessageRenderer") or item.get("liveChatPaidMessageRenderer")
                if not r:
                    continue
                txt = ""
                for run in (r.get("message") or {}).get("runs") or []:
                    if "text" in run:
                        txt += run["text"]
                    elif "emoji" in run:
                        e = run["emoji"]
                        txt += e.get("emojiId") if len(e.get("emojiId", "")) <= 2 else " ".join(e.get("shortcuts", [])[:1])
                w = 3.0 if "liveChatPaidMessageRenderer" in item else 1.0
                cnt[b] += w
                hits = len(REACT.findall(txt))
                kw[b] += min(3, hits) * w
                if len(msgs[b]) < 25 and txt.strip():
                    msgs[b].append(txt.strip()[:80])
                n += 1
    for f in wd.glob("chat*"):
        f.unlink(missing_ok=True)
    return (cnt, kw, msgs) if n >= 30 else None


def audio_signal(app, url, wd, nbins, progress):
    """Kekerasan suara per detik -> nilai per 10 dtk (puncak teriak/ketawa)."""
    for f in wd.glob("audio.*"):
        f.unlink(missing_ok=True)
    progress("mengunduh audio untuk mendeteksi momen heboh...")
    code, out = _run(app.ytdlp() + ["-f", "ba[abr<=100]/ba/worstaudio/worst", "--no-warnings", "--no-playlist",
                                    "-o", str(wd / "audio.%(ext)s"), url], timeout=40 * 60)
    files = [f for f in wd.glob("audio.*") if not f.name.endswith((".part", ".ytdl"))]
    if not files:
        raise RuntimeError("Gagal mengunduh audio: " + out[-500:])
    progress("menghitung kekerasan suara...")
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-i", str(files[0]), "-vn", "-af",
           "aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,"
           "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-", "-f", "null", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="replace")
    secs = []
    for line in p.stdout:
        m = re.search(r"RMS_level=(-?[\d.]+|-inf)", line)
        if m:
            v = m.group(1)
            secs.append(-90.0 if v == "-inf" else max(-90.0, float(v)))
    p.wait()
    for f in wd.glob("audio.*"):
        f.unlink(missing_ok=True)
    if len(secs) < 20:
        return None
    loud = [0.0] * nbins
    for b in range(nbins):
        chunk = sorted(secs[b * 10:(b + 1) * 10], reverse=True)
        loud[b] = sum(chunk[:2]) / max(1, len(chunk[:2])) if chunk else -90.0
    return loud


def sub_signal(app, url, wd, nbins, progress):
    """Subtitle otomatis YouTube (bahasa Indonesia) -> teks per 10 dtk + kata reaksi."""
    for f in wd.glob("subs*"):
        f.unlink(missing_ok=True)
    progress("mengambil subtitle otomatis YouTube...")
    _run(app.ytdlp() + ["--skip-download", "--write-auto-subs", "--write-subs", "--sub-langs", "id.*,id,en.*,en",
                        "--sub-format", "vtt", "--no-warnings", "--no-playlist", "-o", str(wd / "subs.%(ext)s"), url],
         timeout=5 * 60)
    files = sorted(wd.glob("subs*.vtt"), key=lambda f: (not f.name.split(".")[-2].startswith("id"), f.name))
    if not files:
        return None
    text = [[] for _ in range(nbins)]
    kw = [0.0] * nbins
    last = ""
    cur_t = None
    for line in files[0].read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"(\d+):(\d+):(\d+)[.,](\d+)\s+-->", line)
        if m:
            cur_t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
            continue
        if cur_t is None or not line.strip() or "-->" in line:
            continue
        clean = re.sub(r"<[^>]+>", "", line).strip()
        if not clean or clean == last:
            continue
        last = clean
        b = int(cur_t / 10)
        if 0 <= b < nbins:
            text[b].append(clean)
            kw[b] += len(SUB_REACT.findall(clean))
    for f in wd.glob("subs*"):
        f.unlink(missing_ok=True)
    return text, kw


def _z(xs):
    s = sorted(xs)
    med = s[len(s) // 2]
    mad = sorted(abs(x - med) for x in xs)[len(xs) // 2] * 1.4826 or (max(xs) - min(xs)) / 6 or 1.0
    return [max(-2.0, min(6.0, (x - med) / mad)) for x in xs]


def candidates(dur, sig, k, sep_bins=9):
    nb = len(next(iter(sig.values()))) if sig else int(dur / 10) + 1
    total = [0.0] * nb
    weights = {"chat": 1.0, "chatkw": 0.7, "loud": 0.9, "subkw": 0.6}
    for name, arr in sig.items():
        z = _z(arr)
        for i in range(nb):
            total[i] += weights.get(name, 0.5) * z[i]
    sm = [sum(total[max(0, i - 1):i + 2]) / len(total[max(0, i - 1):i + 2]) for i in range(nb)]
    order = sorted(range(nb), key=lambda i: sm[i], reverse=True)
    picked = []
    for i in order:
        t = i * 10 + 5
        if t < 45 or t > dur - 20:
            continue
        if any(abs(i - j) < sep_bins for j in picked):
            continue
        picked.append(i)
        if len(picked) >= k:
            break
    return [(i * 10 + 5, sm[i]) for i in picked]


# ============================================================================ potongan & AI

def download_low(app, url, a, b, dest, timeout=15 * 60):
    for f in dest.parent.glob(dest.stem + ".*"):
        f.unlink(missing_ok=True)
    fmt = "b[height<=480][height>=240]/bv*[height<=480]+ba/b[height<=720]/bv*[height<=720]+ba/w"
    conv = "ffmpeg_o:-c:v libx264 -preset veryfast -crf 30 -vf scale=-2:360 -r 24 -c:a aac -b:a 64k -ac 1"
    cmd = app.ytdlp() + ["-f", fmt, "--no-warnings", "--no-playlist", "--download-sections", f"*{a:.2f}-{b:.2f}",
                         "--force-keyframes-at-cuts", "--downloader-args", conv, "--merge-output-format", "mp4",
                         "-o", str(dest.parent / (dest.stem + ".%(ext)s")), url]
    code, out = _run(cmd, timeout)
    files = [f for f in dest.parent.glob(dest.stem + ".*") if f.suffix in (".mp4", ".mkv", ".webm") and f.stat().st_size > 0]
    if not files:  # cadangan: tanpa argumen encode cepat, nanti di-encode ulang di bawah
        i = cmd.index("--downloader-args")
        code, out = _run(cmd[:i] + cmd[i + 2:], timeout)
        files = [f for f in dest.parent.glob(dest.stem + ".*") if f.suffix in (".mp4", ".mkv", ".webm") and f.stat().st_size > 0]
    if not files:
        raise RuntimeError("Gagal mengunduh potongan kandidat: " + out[-400:])
    if files[0] != dest or files[0].stat().st_size > 14 * 1024 * 1024:
        tmp = dest.with_suffix(".tmp.mp4")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(files[0]), "-c:v", "libx264", "-preset", "veryfast",
                        "-crf", "30", "-vf", "scale=-2:360", "-c:a", "aac", "-b:a", "64k", "-ac", "1", str(tmp)])
        files[0].unlink(missing_ok=True)
        tmp.replace(dest)
    return dest


def cut_preview(src, a, b, dest):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{max(0, a):.2f}", "-i", str(src), "-t", f"{max(1, b - a):.2f}",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "64k",
                    "-movflags", "+faststart", str(dest)], capture_output=True)
    return dest if dest.exists() and dest.stat().st_size > 0 else None


GEMINI_PROMPT = """Kamu editor clip TikTok Indonesia untuk channel "{channel}".
Video sumber: "{title}". Potongan terlampir mulai di menit {start} video sumber, panjang {length} detik.
Petunjuk dari sinyal otomatis: {reason}
{context}
Tonton potongan ini (gambar + suara). Apakah ada momen yang layak jadi clip TikTok: lucu, kaget/jumpscare,
menakjubkan, clutch/skill, drama, wholesome, atau kutipan kuat? Momen harus bisa dipahami tanpa nonton streamnya
dan punya pemicu + puncak/reaksi yang jelas.
Kalau ada, tentukan detik MULAI (sedikit sebelum pemicu, beri konteks) dan SELESAI (setelah reaksi selesai),
dihitung dari AWAL POTONGAN INI (0 sampai {length}). Panjang ideal 15-60 detik. Detik INTRO = detik paling "wow".
Judul hook: 2 pilihan, 4-9 kata, bahasa Indonesia santai, jujur (bukan clickbait bohong), tanpa emoji.
Tandai 1 kata terpenting dengan bintang, contoh: BANG WINDAH *KAGET* HANTU MUNCUL.
Jangan mengarang. Kalau tidak ada momen bagus, jawab layak=false.
Jawab HANYA JSON:
{{"layak": true, "mulai": 12, "selesai": 48, "intro": 31, "kategori": "lucu|kaget|menakjubkan|clutch|drama|wholesome|quote",
"skor": 0-100, "apa_terjadi": "1 kalimat", "kutipan": "ucapan paling ikonik", "hooks": ["...", "..."],
"caption": "caption TikTok 1-2 kalimat, boleh 1 emoji", "hashtags": ["#...", "#..."]}}"""

_last_call = [0.0]


def gemini_json(es, key, model, parts, min_gap=6.5, tries=4):
    for i in range(tries):
        wait = min_gap - (time.time() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()
        try:
            res = es._http_json(es.GEMINI_URL.format(model=model or "gemini-flash-latest"),
                                {"contents": [{"parts": parts}],
                                 "generationConfig": {"temperature": 0.4, "responseMimeType": "application/json"}},
                                {"x-goog-api-key": key}, timeout=180)
            text = res["candidates"][0]["content"]["parts"][0]["text"]
            m = re.search(r"\{.*\}", text, flags=re.S)
            return json.loads(m.group(0)) if m else None
        except es.SubError as ex:
            msg = str(ex)
            if "HTTP 429" in msg or "RESOURCE_EXHAUSTED" in msg:
                if "per day" in msg.lower() or "PerDay" in msg:
                    raise RuntimeError("Kuota harian Gemini habis. " + msg[:200])
                time.sleep(35 * (i + 1))
                continue
            if "HTTP 5" in msg and i < tries - 1:
                time.sleep(10)
                continue
            raise RuntimeError(msg[:400])
        except (KeyError, IndexError, ValueError):
            if i < tries - 1:
                continue
            return None
    raise RuntimeError("Gemini sibuk terus (batas per menit). Coba lagi nanti.")


def claude_edit(es, key, moments, channel, title):
    """Claude sebagai editor: nilai ulang & rapikan judul/caption. Mengembalikan daftar baru (urutan sama)."""
    slim = [{"no": i, "menit": f"{m['start']:.0f}-{m['end']:.0f}", "kategori": m.get("kategori"), "skor": m.get("skor"),
             "apa_terjadi": m.get("info"), "kutipan": m.get("kutipan"), "hooks": m.get("hooks"), "caption": m.get("caption")}
            for i, m in enumerate(moments)]
    prompt = (f"Kamu produser clip TikTok untuk akun clipper Indonesia. Channel: {channel}. Video: {title}.\n"
              "Ini kandidat momen dari Gemini (yang sudah menonton potongannya):\n" + json.dumps(slim, ensure_ascii=False) +
              "\n\nUntuk tiap kandidat: beri skor akhir 0-100 (seberapa layak viral & bisa dipahami tanpa konteks), "
              "perbaiki 2 judul hook (4-9 kata, jujur, santai, tanpa emoji, 1 kata penting diberi *bintang*), "
              "dan 1 caption TikTok. Tandai ragu=true kalau deskripsinya janggal/tidak meyakinkan.\n"
              'Jawab HANYA JSON: {"hasil":[{"no":0,"skor":80,"hooks":["..",".."],"caption":"..","ragu":false}]}')
    res = es._http_json(es.CLAUDE_URL, {"model": "claude-haiku-5-5", "max_tokens": 3000,
                                        "messages": [{"role": "user", "content": prompt}]},
                        {"x-api-key": key, "anthropic-version": "2023-06-01"}, timeout=120)
    text = "".join(b.get("text", "") for b in res.get("content", []))
    m = re.search(r"\{.*\}", text, flags=re.S)
    data = json.loads(m.group(0)) if m else {}
    out = [dict(x) for x in moments]
    for h in data.get("hasil") or []:
        try:
            i = int(h.get("no"))
        except (TypeError, ValueError):
            continue
        if 0 <= i < len(out):
            if isinstance(h.get("skor"), (int, float)):
                out[i]["skor"] = round((out[i].get("skor", 50) + float(h["skor"])) / 2)
            if h.get("hooks"):
                out[i]["hooks"] = [str(x) for x in h["hooks"]][:3]
            if h.get("caption"):
                out[i]["caption"] = str(h["caption"])
            out[i]["ragu"] = bool(h.get("ragu"))
    return out


# ============================================================================ utama

def analyze(app, es, payload, cfg, keys, progress, check_cancel=lambda: False):
    url = payload["url"]
    progress("membaca info video...")
    try:
        info = app.get_info(url)
    except app.UserError as ex:
        msg = str(ex)
        if "LIVE" in msg or "masih diproses" in msg:
            raise Defer("Masih live, dicek lagi 20 menit lagi.", 1200)
        raise
    if info.get("live_status") in ("is_upcoming",):
        raise Defer("Siaran belum mulai, dicek lagi nanti.", 3600)
    dur = float(info.get("duration") or 0)
    if dur <= 0:
        raise RuntimeError("Durasi video tidak terbaca.")
    title = info.get("title") or payload.get("title") or ""
    channel = payload.get("channel") or info.get("channel") or ""
    wd = app.WORK / info["key"] / "auto"
    wd.mkdir(parents=True, exist_ok=True)
    per = max(1, int(payload.get("per_video") or cfg.get("per_video") or 5))
    gkey = keys.get("gemini")
    model = cfg.get("gemini_model") or "gemini-flash-latest"
    notes = []

    # --- kandidat
    if dur <= 150:
        cands = [(dur / 2, 1.0)]
        windows = [(0.0, dur)]
        msgs_by_bin, subs_by_bin = None, None
        notes.append("video pendek: seluruh video jadi satu kandidat")
    else:
        nb = int(dur / 10) + 1
        sig, msgs_by_bin, subs_by_bin = {}, None, None
        if info.get("platform") != "twitch" and (info.get("was_live") or info.get("live_status") in ("was_live", "post_live")):
            try:
                ch = chat_signal(app, url, wd, nb, progress)
                if ch:
                    sig["chat"], sig["chatkw"], msgs_by_bin = ch
                else:
                    notes.append("chat replay tidak tersedia")
            except Exception as ex:  # noqa
                notes.append(f"chat gagal: {ex}"[:120])
        if check_cancel():
            raise Cancelled()
        if info.get("platform") != "twitch":
            try:
                sb = sub_signal(app, url, wd, nb, progress)
                if sb:
                    subs_by_bin, sig["subkw"] = sb
            except Exception as ex:  # noqa
                notes.append(f"subtitle otomatis gagal: {ex}"[:120])
        try:
            loud = audio_signal(app, url, wd, nb, progress)
            if loud:
                sig["loud"] = loud
        except Exception as ex:  # noqa
            notes.append(f"analisis suara gagal: {ex}"[:160])
        if check_cancel():
            raise Cancelled()
        k = min(20, max(6, per * 3)) if gkey else per * 2
        if sig:
            cands = candidates(dur, sig, k)
        else:
            step = (dur - 120) / (k + 1)
            cands = [(90 + step * (i + 1), 0.0) for i in range(k)]
            notes.append("tidak ada sinyal, kandidat dibagi rata")
        windows = [(max(0.0, t - 55), min(dur, max(0.0, t - 55) + 90)) for t, _ in cands]

    # --- nilai tiap kandidat
    found = []
    for i, ((t, sc), (a, b)) in enumerate(zip(cands, windows)):
        if check_cancel():
            raise Cancelled()
        progress(f"menonton kandidat {i + 1}/{len(cands)} (menit {app.fmt_time(t)})...")
        clip = wd / f"cand_{i}.mp4"
        try:
            download_low(app, url, a, b, clip)
        except Exception as ex:  # noqa
            notes.append(f"kandidat {i + 1} gagal diunduh")
            app.log(f"autopilot: kandidat gagal {ex}")
            continue
        length = b - a
        reason = []
        bi = int(t / 10)
        if sc:
            reason.append(f"skor sinyal {sc:.1f}")
        if msgs_by_bin:
            chat = [m for j in range(max(0, bi - 3), min(len(msgs_by_bin), bi + 4)) for m in msgs_by_bin[j]][:30]
            if chat:
                reason.append("chat penonton ramai")
        else:
            chat = []
        context = ""
        if chat:
            context += "Contoh chat penonton saat itu: " + " | ".join(chat) + "\n"
        if subs_by_bin:
            st = " ".join(x for j in range(int(a / 10), min(len(subs_by_bin), int(b / 10) + 1)) for x in subs_by_bin[j])
            if st:
                context += "Subtitle otomatis (bisa salah dengar): " + st[:1500] + "\n"
        m = None
        if gkey:
            data = base64.b64encode(clip.read_bytes()).decode()
            try:
                r = gemini_json(es, gkey, model, [{"inline_data": {"mime_type": "video/mp4", "data": data}},
                                                  {"text": GEMINI_PROMPT.format(channel=channel, title=title, start=app.fmt_time(a),
                                                                                length=int(length), reason=", ".join(reason) or "-",
                                                                                context=context)}])
            except RuntimeError as ex:
                if "Kuota harian" in str(ex):
                    notes.append(str(ex)[:150])
                    gkey = None
                    r = None
                else:
                    notes.append(f"Gemini error: {ex}"[:150])
                    r = None
            if r and r.get("layak"):
                try:
                    s0, s1 = float(r.get("mulai", 0)), float(r.get("selesai", length))
                except (TypeError, ValueError):
                    s0, s1 = 0.0, length
                s0, s1 = max(0.0, min(s0, length - 3)), max(0.0, min(s1, length))
                if s1 - s0 < 8:
                    s0, s1 = max(0.0, (s0 + s1) / 2 - 12), min(length, (s0 + s1) / 2 + 12)
                try:
                    it = float(r.get("intro"))
                    it = it if s0 <= it <= s1 else None
                except (TypeError, ValueError):
                    it = None
                tags = [("#" + str(x).lstrip("#")).replace(" ", "") for x in (r.get("hashtags") or [])][:6]
                cap = str(r.get("caption") or "").strip()
                m = {"start": a + s0, "end": a + s1, "intro": a + it if it is not None else None,
                     "skor": int(max(0, min(100, float(r.get("skor") or 50)))), "kategori": str(r.get("kategori") or "")[:20],
                     "info": str(r.get("apa_terjadi") or "")[:300], "kutipan": str(r.get("kutipan") or "")[:150],
                     "hooks": [str(h) for h in (r.get("hooks") or []) if str(h).strip()][:3],
                     "caption": (cap + ("\n\n" + " ".join(tags) if tags else "")).strip(), "src": clip, "rel0": s0, "rel1": s1}
        if m is None and not gkey:
            mid = t - a
            s0, s1 = max(0.0, mid - 25), min(length, mid + 15)
            m = {"start": a + s0, "end": a + s1, "intro": None, "skor": int(max(1, min(99, 50 + sc * 8))), "kategori": "",
                 "info": ("; ".join(reason) or "dipilih dari sinyal otomatis"), "kutipan": "", "hooks": [], "caption": "",
                 "src": clip, "rel0": s0, "rel1": s1}
        if m:
            found.append(m)
        else:
            clip.unlink(missing_ok=True)

    if found and keys.get("claude") and cfg.get("ai_editor") == "claude":
        progress("Claude memeriksa & merapikan kandidat...")
        try:
            found = claude_edit(es, keys["claude"], found, channel, title)
        except Exception as ex:  # noqa
            notes.append(f"Claude editor gagal: {ex}"[:150])

    # --- pilih terbaik, buang yang tumpang tindih
    min_skor = int(cfg.get("min_skor") or 55) if keys.get("gemini") else 0
    found.sort(key=lambda m: m["skor"], reverse=True)
    chosen = []
    for m in found:
        if m["skor"] < min_skor:
            continue
        if any(min(m["end"], c["end"]) - max(m["start"], c["start"]) > 0.3 * (m["end"] - m["start"]) for c in chosen):
            continue
        chosen.append(m)
        if len(chosen) >= per:
            break
    progress(f"menyiapkan {len(chosen)} preview momen...")
    for i, m in enumerate(chosen):
        m["preview"] = cut_preview(m["src"], m["rel0"] - 0.3, m["rel1"] + 0.3, wd / f"card_{i}.mp4")
    for f in wd.glob("cand_*.mp4"):
        if not any(f == m["src"] for m in chosen):
            f.unlink(missing_ok=True)
    return {"title": title, "channel": channel, "moments": chosen, "notes": notes, "dur": dur, "workdir": wd}


def cleanup(wd):
    shutil.rmtree(wd, ignore_errors=True)
