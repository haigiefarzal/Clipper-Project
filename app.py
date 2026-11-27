#!/usr/bin/env python3
"""
KlipKu 2 — alat clip YouTube & Twitch pribadi.
Masukkan link + menit mulai/selesai -> keluar video vertikal 9:16 (facecam besar di atas, gameplay di bawah)
lengkap dengan subtitle otomatis (Whisper), judul hook, dan watermark.

Jalankan:  python app.py   lalu browser akan terbuka di http://127.0.0.1:8765
"""
import base64
import json
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

APP = Path(__file__).resolve().parent
WEB = APP / "web"
FONTS = APP / "fonts"
WORK = APP / "work"
OUT = APP / "hasil"
SETTINGS = WORK / "settings.json"
W, H = 1080, 1920
VERSION = "2.4"

WORK.mkdir(exist_ok=True)
OUT.mkdir(exist_ok=True)

import engine_audio as EA  # noqa: E402
import engine_fonts as EF  # noqa: E402
import engine_hook as EH  # noqa: E402
import engine_remote as ER  # noqa: E402
import engine_subs as ES  # noqa: E402

SFX, MUSIC = EA.SFX_DIR, EA.MUSIC_DIR


def log(msg):
    print(f"[KlipKu] {msg}", flush=True)


class UserError(Exception):
    pass


# ============================================================================ helpers

def parse_time(text):
    text = str(text).strip()
    if re.fullmatch(r"\d+(\.\d{2}){1,2}", text):  # 1.23.45 atau 12.30 -> pakai titik sebagai pemisah
        text = text.replace(".", ":")
    if not text:
        raise UserError("waktu kosong")
    try:
        sec = 0.0
        for part in text.split(":"):
            sec = sec * 60 + float(part)
        return sec
    except ValueError:
        raise UserError(f"format waktu tidak dikenal: '{text}'. Contoh yang benar: 1:23:45 atau 12:30")


def fmt_time(sec):
    sec = int(round(max(0, sec)))
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


TW_VOD = re.compile(r"(?:(?:www|go|m)\.)?twitch\.tv/(?:[^/?#]+/v(?:ideo)?|videos)/(\d+)|player\.twitch\.tv/\?.*?\bvideo=v?(\d+)"
                    r"|twitch\.tv/[^/?#]+/schedule\?vodID=(\d+)", re.I)
TW_CLIP = re.compile(r"clips\.twitch\.tv/(?:embed\?.*?\bclip=|(?:[^/?#]+/)*)([A-Za-z0-9_-]+)"
                     r"|(?:(?:www|go|m)\.)?twitch\.tv/(?:[^/?#]+/)?clip/([A-Za-z0-9_-]+)", re.I)
TW_ANY = re.compile(r"(?:^|//|\.)twitch\.tv(?:/|$)", re.I)


def norm_url(url):
    url = (url or "").strip()
    if url and not re.match(r"[a-z]+://", url, re.I):
        url = "https://" + url
    return url


def platform(url):
    return "twitch" if TW_ANY.search(url or "") else "youtube"


def video_id(url):
    """Kunci unik video (dipakai untuk folder cache). YouTube: 11 karakter. Twitch: tw-v123 / twc-slug."""
    url = (url or "").strip()
    if TW_ANY.search(url):
        m = TW_VOD.search(url)
        if m:
            return "tw-v" + next(g for g in m.groups() if g)
        m = TW_CLIP.search(url)
        if m:
            return "twc-" + next(g for g in m.groups() if g)[:80]
        if re.search(r"twitch\.tv/[A-Za-z0-9_]{2,}/?(?:[?#].*)?$", url, re.I):
            raise UserError("Itu link channel / siaran LIVE Twitch. KlipKu butuh link VOD: buka channel-nya → tab "
                            "Videos → pilih siaran yang sudah selesai → salin link (bentuknya twitch.tv/videos/123...).")
        raise UserError("Link Twitch tidak dikenali. Pakai link VOD (twitch.tv/videos/123...) atau clip "
                        "(clips.twitch.tv/... atau twitch.tv/nama/clip/...).")
    m = re.search(r"(?:v=|youtu\.be/|/live/|/shorts/|/embed/)([A-Za-z0-9_-]{11})", url)
    if not m:
        raise UserError("Link tidak dikenali. Bisa link YouTube (youtube.com/watch?v=...) atau Twitch "
                        "(twitch.tv/videos/... atau clip Twitch).")
    return m.group(1)


def source_link(info, s):
    """Link sumber yang langsung lompat ke menit clip (untuk caption)."""
    key = info.get("key") or info.get("id")
    if info.get("platform") == "twitch":
        if key.startswith("tw-v"):
            h, r = divmod(int(s), 3600)
            m, sec = divmod(r, 60)
            return f"https://www.twitch.tv/videos/{key[4:]}?t={h}h{m}m{sec}s"
        return info.get("url")
    return f"https://youtu.be/{key}?t={int(s)}"


def slug(text, n=40):
    text = re.sub(r"[^\w\s-]", "", text or "", flags=re.UNICODE).strip().lower()
    return re.sub(r"[\s_-]+", "-", text)[:n].strip("-") or "clip"


def even(x):
    return max(2, int(x) // 2 * 2)


def ytdlp():
    return [sys.executable, "-m", "yt_dlp"]


def run_lines(cmd, on_line=None, cwd=None):
    """Jalankan perintah, kirim tiap baris output ke on_line. Error -> UserError dengan ekor log."""
    log("$ " + " ".join(str(c) for c in cmd)[:300])
    proc = subprocess.Popen([str(c) for c in cmd], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", bufsize=1)
    tail = []
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        tail = (tail + [line])[-25:]
        if on_line:
            try:
                on_line(line)
            except Exception:
                pass
    proc.wait()
    if proc.returncode != 0:
        joined = "\n".join(tail)
        hint = ""
        low = joined.lower()
        if "twitch" in low and ("subscriber-only" in low or "login required" in low or "logged-in" in low
                                or "--cookies" in low):
            hint = "VOD Twitch ini khusus subscriber / butuh login, jadi tidak bisa diambil."
        elif "twitch" in low and ("does not exist" in low or "404" in low or "not found" in low):
            hint = ("VOD / clip Twitch tidak ditemukan. Mungkin sudah dihapus streamernya atau kedaluwarsa "
                    "(VOD Twitch hanya disimpan sementara).")
        elif "twitch" in low and "not currently live" in low:
            hint = "Itu link channel Twitch yang sedang offline. Pakai link VOD (twitch.tv/videos/...)."
        elif "Sign in to confirm" in joined or "not a bot" in low:
            hint = "YouTube minta verifikasi 'bukan bot'. Tunggu beberapa saat lalu coba lagi."
        elif "JavaScript runtime" in joined or "n challenge" in joined or "403" in joined:
            hint = "Kemungkinan yt-dlp perlu update atau Deno belum terpasang. Tutup KlipKu lalu buka lagi (otomatis update)."
        elif "members-only" in joined.lower() or "join this channel" in joined.lower():
            hint = "Video ini khusus member, tidak bisa diambil."
        raise UserError((hint + "\n\n" if hint else "") + "Detail error:\n" + joined[-1500:])
    return tail


def load_settings():
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8"))
    except Exception:
        return {"cams": {}, "last": {}}


def save_settings(data):
    SETTINGS.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def tool_status():
    st = {"ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
          "deno": bool(shutil.which("deno")),
          "node": bool(shutil.which("node"))}
    try:
        import yt_dlp.version as v
        st["yt_dlp"] = v.__version__
    except Exception:
        st["yt_dlp"] = None
    for mod, key in (("faster_whisper", "whisper"), ("cv2", "opencv"), ("fontTools", "fonttools")):
        try:
            __import__(mod)
            st[key] = True
        except Exception:
            st[key] = False
    return st


# ============================================================================ youtube & twitch

_info_cache = {}


def get_info(url):
    url = norm_url(url)
    vid = video_id(url)
    if vid in _info_cache:
        return _info_cache[vid]
    vdir = WORK / vid
    vdir.mkdir(exist_ok=True)
    cache = vdir / "info.json"
    if cache.exists() and time.time() - cache.stat().st_mtime < 6 * 3600:
        info = json.loads(cache.read_text(encoding="utf-8"))
    else:
        out = subprocess.run(ytdlp() + ["-J", "--no-warnings", "--no-playlist", url],
                             capture_output=True, text=True, encoding="utf-8", errors="replace")
        if out.returncode != 0:
            raise UserError("Gagal membaca info video.\n" + out.stderr[-1200:])
        full = json.loads(out.stdout)
        heights = []
        for f in full.get("formats", []):
            if f.get("vcodec") in ("none",):
                continue
            h = f.get("height") or 0
            if not h:  # Twitch HLS: tinggi kadang hanya ada di nama format (1080p60, 720p30)
                m = re.search(r"(\d{3,4})p", str(f.get("format_id") or "") + " " + str(f.get("format_note") or ""))
                h = int(m.group(1)) if m else 0
            heights.append(h)
        info = {k: full.get(k) for k in ("id", "title", "channel", "channel_id", "uploader", "uploader_id",
                                         "duration", "is_live", "was_live", "live_status")}
        info["max_height"] = max(heights) if heights else 0
        info["url"] = url
        if platform(url) == "twitch":
            info["platform"] = "twitch"
            if vid.startswith("tw-v"):  # VOD: uploader = streamer
                info["channel"] = info.get("channel") or info.get("uploader")
                login = info.get("uploader_id") or info.get("uploader") or ""
            else:  # clip: uploader = orang yang bikin clip, channel = streamer
                info["clipper"] = info.get("uploader")
                info["uploader"] = info.get("channel") or info.get("uploader")
                login = info.get("channel") or ""
            info["channel_id"] = "twitch:" + login.lower()
            info["title"] = info.get("title") or "Siaran Twitch"
        else:
            info["platform"] = "youtube"
        cache.write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
    info["key"] = vid
    info.setdefault("platform", platform(url))
    if info.get("is_live") or info.get("live_status") == "is_live":
        if info.get("platform") == "twitch":
            raise UserError("Siaran Twitch ini masih LIVE / masih diproses. Tunggu sampai streamnya selesai, lalu coba lagi.")
        raise UserError("Stream ini masih LIVE. Tunggu sampai selesai (jadi VOD), lalu coba lagi.")
    _info_cache[vid] = info
    return info


def download_section(url, start, end, dest_noext, video_only=False, max_h=None, on_progress=None):
    """Download hanya potongan yang dipilih. Jalur cepat: potong presisi + encode sementara superfast
    (kualitas hampir tanpa rugi). Kalau jalur cepat gagal, otomatis ulang dengan cara standar."""
    if video_only:
        fmt = ["-f", f"bv*[height<={max_h or 720}]/bv*/b"]
        fast_o = "ffmpeg_o:-c:v libx264 -preset ultrafast -crf 20"
    else:
        fmt = ["-f", "bv*+ba/b", "-S", "res,fps", "--merge-output-format", "mp4"]
        fast_o = "ffmpeg_o:-c:v libx264 -preset superfast -crf 14 -c:a aac -b:a 192k"
    seg = max(0.1, end - start)

    def on_line(line):
        if not on_progress:
            return
        m = re.search(r"\[download\]\s+([\d.]+)%", line)
        if m:
            on_progress(float(m.group(1)) / 100, line.split("]", 1)[-1].strip()[:60])
        m = re.search(r"time=(\d+):(\d+):([\d.]+)", line)
        if m:
            t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
            sp = re.search(r"speed=\s*([\d.]+)x", line)
            on_progress(min(0.99, t / seg), f"{t:.0f} / {seg:.0f} detik" + (f" · {sp.group(1)}×" if sp else ""))

    last = None
    for extra in (["--downloader-args", fast_o], []):
        for old in dest_noext.parent.glob(dest_noext.name + ".*"):
            try:
                old.unlink()
            except OSError:
                pass
        try:
            run_lines(ytdlp() + fmt + extra + ["--no-warnings", "--no-playlist", "--newline",
                                               "--download-sections", f"*{start:.2f}-{end:.2f}",
                                               "--force-keyframes-at-cuts", "-o", str(dest_noext) + ".%(ext)s", url],
                      on_line)
            files = [p for p in dest_noext.parent.glob(dest_noext.name + ".*")
                     if p.suffix not in (".part", ".ytdl") and p.stat().st_size > 0]
            if files:
                if on_progress:
                    on_progress(1.0, "selesai")
                return files[0]
            last = UserError("Download potongan video gagal (file tidak ditemukan).")
        except UserError as ex:
            last = ex
            if extra:
                log("jalur download cepat gagal, mencoba cara standar...")
    raise last


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate:format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True).stdout
    d = json.loads(out)
    st = d["streams"][0]
    num, den = (st.get("r_frame_rate") or "30/1").split("/")
    return int(st["width"]), int(st["height"]), float(num) / float(den or 1), float(d["format"].get("duration", 0))


def make_preview(url, t):
    url = norm_url(url)
    info = get_info(url)
    dur = float(info.get("duration") or 0)
    t = max(0.0, min(t, max(0.0, dur - 4)))
    vdir = WORK / info["key"]
    src = download_section(url, t, t + 3, vdir / f"prev_{int(t)}", video_only=True, max_h=720)
    jpg = vdir / f"preview_{int(t)}.jpg"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "1", "-i", str(src), "-frames:v", "1",
                    "-q:v", "3", str(jpg)], check=False)
    if not jpg.exists():
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-frames:v", "1", "-q:v", "3",
                        str(jpg)], check=False)
    try:
        src.unlink()
    except OSError:
        pass
    if not jpg.exists():
        raise UserError("Gagal mengambil gambar dari video.")
    return f"/work/{info['key']}/{jpg.name}"



# ============================================================================ layout

ASPECTS = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}


def canvas(o):
    return ASPECTS.get(o.get("aspect", "9:16"), (1080, 1920))


def auto_geom(o, W, H, fg_top=None, fg_bot=None):
    portrait = H > W
    layout = o.get("layout", "static")
    if layout == "facecam":
        top_h = even(H * float(o.get("cam_pct", 42)) / 100)
        sub_y, hook_y, credit_y = top_h, 175, H - 400
    elif layout == "ai" or fg_top is None or (fg_top <= 2 and fg_bot >= H - 2):
        sub_y = H * (0.70 if portrait else 0.84 if W > H else 0.80)
        hook_y = H * (0.09 if portrait else 0.11)
        credit_y = H * (0.80 if portrait else 0.955)
    else:
        sub_y = fg_bot + H * 0.08 if fg_bot + H * 0.08 < H * 0.86 else H * 0.80
        hook_y = fg_top - H * 0.075 if fg_top > H * 0.13 else H * 0.09
        credit_y = H * 0.80 if portrait else H * 0.955
        if portrait and abs(credit_y - sub_y) < 90:
            credit_y = min(H - 60, sub_y + 120)
    pct = float(o.get("sub_y_pct") or 0)
    if pct > 0:
        sub_y = H * pct / 100
    return {"sub_y": sub_y, "hook_y": hook_y, "credit_y": credit_y}


def static_graph(o, sw, sh, W, H, wm_behind_ass=None):
    z = max(0.3, float(o.get("zoom", 1.0)))
    s = W * z / sw
    SW, SH = even(sw * s), even(sh * s)
    CW, CH = min(W, SW), min(H, SH)
    X = int((SW - CW) * float(o.get("pan_x", 0.5)))
    Y = int((SH - CH) * float(o.get("pan_y", 0.5)))
    fg = f"scale={SW}:{SH}:flags=lanczos,crop={CW}:{CH}:{X}:{Y}"
    top = (H - CH) // 2
    if CW >= W and CH >= H:
        return f"[0:v]{fg},setsar=1[base]", top, top + CH
    if o.get("bg", "blur") == "hitam":
        bg = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill"
    else:
        bg = (f"scale={W // 4}:{H // 4}:force_original_aspect_ratio=increase,crop={W // 4}:{H // 4},boxblur=7:2,"
              f"eq=brightness=-0.10,scale={W}:{H}:flags=bilinear")
    if wm_behind_ass:
        bg += f",ass={wm_behind_ass}"
    graph = f"[0:v]split=2[a][b];[a]{bg}[bg];[b]{fg}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]"
    return graph, top, top + CH


def facecam_graph(o, sw, sh, W, H):
    cam = o.get("cam")
    if not cam:
        raise UserError("Kotak facecam belum dipilih. Klik 'Ambil gambar' lalu tarik kotak di wajah streamer.")
    top_h = even(H * float(o.get("cam_pct", 42)) / 100)
    bot_h = H - top_h
    cx, cy, cw, ch = (float(cam[k]) for k in ("x", "y", "w", "h"))
    cxp, cyp, cwp, chp = cx * sw, cy * sh, cw * sw, ch * sh
    dst = W / top_h
    if cwp / chp > dst:
        nw = chp * dst
        cxp += (cwp - nw) / 2
        cwp = nw
    else:
        nh = cwp / dst
        cyp += (chp - nh) / 2
        chp = nh
    cam_f = f"crop={even(cwp)}:{even(chp)}:{int(cxp)}:{int(cyp)},scale={W}:{top_h}:flags=lanczos,setsar=1"
    if o.get("game_mode", "isi") == "utuh":
        gfg_h = even(W * sh / sw)
        game = (f"[g]split=2[g1][g2];[g1]scale={W // 4}:{bot_h // 4}:force_original_aspect_ratio=increase,"
                f"crop={W // 4}:{bot_h // 4},boxblur=6:2,eq=brightness=-0.12,scale={W}:{bot_h}:flags=bilinear[gbg];[g2]scale={W}:{gfg_h}:flags=lanczos[gfg];"
                f"[gbg][gfg]overlay=0:(H-h)/2,setsar=1[game]")
    else:
        zoom = max(1.0, float(o.get("game_zoom", 1.0)))
        gw = sh * (W / bot_h) / zoom
        if gw > sw:
            gw = sw
        gh = gw * bot_h / W
        gxp = (sw - gw) * float(o.get("game_x", 0.5))
        gyp = (sh - gh) * float(o.get("game_y", 0.5))
        game = f"[g]crop={even(gw)}:{even(gh)}:{int(gxp)}:{int(gyp)},scale={W}:{bot_h}:flags=lanczos,setsar=1[game]"
    line = f",drawbox=x=0:y={top_h - 4}:w={W}:h=8:color=white@0.95:t=fill" if o.get("divider", True) else ""
    return f"[0:v]split=2[c][g];[c]{cam_f}[cam];{game};[cam][game]vstack{line}[base]"


LOGO = WORK / "logo.png"


# ============================================================================ subtitle pipeline

def speech_from_words(words):
    spans = [(w["s"] - 0.15, w["e"] + 0.15) for w in words]

    def f(t):
        return 1.0 if any(a <= t <= b for a, b in spans) else 0.0
    return f


def speech_from_audio(src):
    try:
        import numpy as np
        a = ES.load_audio(src)
    except Exception:
        return lambda t: 0.6
    hop = 2000  # 0.125 detik
    n = max(1, len(a) // hop)
    rms = np.sqrt(np.mean(a[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-9)
    med = float(np.median(rms)) + 1e-6
    vals = np.clip((rms / med - 0.8) / 1.2, 0, 1)

    def f(t):
        return float(vals[min(n - 1, max(0, int(t * 8)))])
    return f


def build_subtitles(job, src, o, info, tag, s_start):
    """Whisper -> kamus -> kata khusus -> koreksi AI. -> (chunks, words)"""
    terms = ES.parse_terms(o.get("prompt", ""))
    rules = ES.parse_rules(o.get("rules", ""))
    model = o.get("model", "large-v3-turbo")
    words, dev = None, "cpu"
    if o.get("engine") == "groq":
        key = (load_settings().get("keys") or {}).get("groq")
        if not key:
            job.warnings.append("Mesin Groq dipilih tapi API key belum diisi — pakai mesin lokal.")
        else:
            job.set(f"{tag}: bikin subtitle (Groq online)...")
            job.step("model", 1.0, "online — tidak perlu download model")
            try:
                words = ES.groq_transcribe(src, key, model, o.get("lang", "id"), terms,
                                           lambda p, info="": job.step("subs", p, info), log)
                dev = "groq"
            except ES.SubError as ex:
                job.warnings.append(str(ex) + " — otomatis pindah ke mesin lokal.")
                words = None
    if words is None:
        job.set(f"{tag}: bikin subtitle (Whisper {model})...")
        job.step("model", 0.0, f"cek model {model}...")
        audio = ES.load_audio(src)
        words, dev = ES.transcribe(audio, model, o.get("lang", "id"), terms, log,
                                   on_model=lambda p, info="": job.step("model", p, info),
                                   on_progress=lambda p, info="": job.step("subs", p, info))
    job.step("fix", 0.2, "kamus & kata khusus...")
    if dev == "groq":
        job.notes.append("Subtitle diproses online di Groq ⚡")
    elif dev == "cuda":
        job.notes.append("Subtitle diproses di GPU NVIDIA ⚡")
    else:
        why = ES.GPU_NOTE.get("reason")
        job.notes.append("Subtitle diproses di CPU" + (f" (GPU tidak bisa dipakai: {why})" if why else "") + ".")
    words, n1 = ES.apply_rules(words, rules)
    words, n2 = ES.apply_terms(words, terms)
    if n1 or n2:
        job.notes.append(f"Koreksi otomatis: {n1} dari kamus, {n2} dari kata khusus.")
    size = int(o.get("sub_size", 80))
    W, H = canvas(o)
    aw = EF.get(o.get("font")).get("aw", 0.65) * (1.0 if o.get("uppercase", True) else 0.82)
    max_chars = max(6, int(W * 0.86 / (size * aw * 1.06)))  # muat dalam 1 baris (termasuk efek zoom kata aktif)
    chunks = ES.make_chunks(words, int(o.get("per_line", 3)), max_chars)
    provider = o.get("ai_fix", "off")
    if provider in ("gemini", "claude") and chunks:
        key = (load_settings().get("keys") or {}).get(provider)
        if not key:
            job.warnings.append(f"Koreksi AI {provider} dilewati: API key belum diisi.")
        else:
            job.set(f"{tag}: koreksi AI ({provider})...")
            job.step("fix", 0.4, f"koreksi AI {provider}" + (" (mendengarkan audio)" if provider == "gemini" else ""))
            try:
                mp3 = None
                if provider == "gemini":
                    mp3 = ES.make_mp3(src, src.with_suffix(".ai.mp3"))
                fixed = ES.ai_correct([c["text"] for c in chunks], provider, key, o.get("ai_model", ""),
                                      {"title": info.get("title"), "channel": info.get("channel"), "terms": terms},
                                      mp3)
                changed = sum(1 for a, b in zip(chunks, fixed) if a["text"] != b)
                chunks = ES.apply_edits(chunks, [{"start": c["start"], "end": c["end"], "text": t}
                                                 for c, t in zip(chunks, fixed)])
                job.notes.append(f"Koreksi AI mengubah {changed} baris.")
                if mp3:
                    try:
                        mp3.unlink()
                    except OSError:
                        pass
            except ES.SubError as ex:
                job.warnings.append(str(ex))
    job.step("fix", 1.0, f"{len(chunks)} baris subtitle")
    return chunks, words


# ============================================================================ encoder (mesin render)

ENCODERS = {"checked": False, "list": [], "errors": {}}
HW_CANDIDATES = [("h264_nvenc", "GPU NVIDIA (NVENC)"), ("h264_qsv", "GPU Intel (Quick Sync)"),
                 ("h264_amf", "GPU AMD (AMF)"), ("h264_videotoolbox", "Apple (VideoToolbox)")]


def _encoder_hint(enc, err):
    e = err.lower()
    if enc == "h264_nvenc":
        if "api version" in e or "driver" in e:
            return "Driver NVIDIA terlalu lama — update lewat NVIDIA App / GeForce Experience, lalu buka ulang KlipKu."
        if any(k in e for k in ("no capable devices", "openencodesessionex", "cuda", "no device", "nvcuda")):
            return ("GPU NVIDIA tidak bisa diakses (laptop mungkin mode hemat daya). Colok charger, lalu di "
                    "NVIDIA Control Panel pilih 'High-performance NVIDIA processor', buka ulang KlipKu.")
        if "unknown encoder" in e or "encoder not found" in e:
            return "FFmpeg yang terpasang tidak punya NVENC. Jalankan 1-INSTALL lagi untuk memasang FFmpeg lengkap."
    return ""


def detect_encoders():
    """Tes cepat encoder GPU yang benar-benar bisa dipakai di komputer ini (dan simpan alasan kalau gagal)."""
    found, errors = [], {}
    for enc, label in HW_CANDIDATES:
        if enc == "h264_videotoolbox" and sys.platform != "darwin":
            continue
        if enc != "h264_videotoolbox" and sys.platform == "darwin":
            continue
        try:
            r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                                "color=black:s=1080x1920:r=30:d=0.4", "-vf", "format=yuv420p"]
                               + video_codec_args(enc, 18) + ["-f", "null", "-"], capture_output=True, timeout=25,
                               text=True, encoding="utf-8", errors="replace")
            if r.returncode == 0:
                found.append((enc, label))
            else:
                lines = [ln.strip() for ln in (r.stderr or "").splitlines() if ln.strip()]
                own = [ln for ln in lines if f"[{enc} @" in ln and "Error while opening encoder" not in ln]
                pick = (own[:2] or lines[:2]) if lines else []
                msg = " | ".join(re.sub(r"^\[[^\]]*\]\s*", "", ln) for ln in pick)[:300] or f"kode {r.returncode}"
                errors[enc] = {"label": label, "error": msg, "hint": _encoder_hint(enc, msg)}
        except Exception as ex:  # noqa
            errors[enc] = {"label": label, "error": str(ex)[:300], "hint": ""}
    ENCODERS.update(checked=True, list=found, errors=errors)
    log("Mesin render: " + (", ".join(lbl for _, lbl in found) + " terdeteksi" if found else "CPU (x264)"))
    for enc, e in errors.items():
        log(f"  {e['label']} tidak bisa dipakai: {e['error']}")


def video_codec_args(enc, crf):
    crf = int(crf)
    if enc == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", str(crf + 1), "-b:v", "0",
                "-spatial_aq", "1", "-profile:v", "high"]
    if enc == "h264_qsv":
        return ["-c:v", "h264_qsv", "-preset", "faster", "-global_quality", str(crf + 3), "-profile:v", "high"]
    if enc == "h264_amf":
        return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", str(crf + 1), "-qp_p", str(crf + 3),
                "-qp_b", str(crf + 5)]
    if enc == "h264_videotoolbox":
        return ["-c:v", "h264_videotoolbox", "-b:v", "14M", "-maxrate", "22M", "-profile:v", "high"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-profile:v", "high", "-threads", "0"]


def encoder_chain(o):
    """Urutan encoder yang dicoba: pilihan user / GPU tercepat dulu, lalu CPU sebagai cadangan pasti."""
    choice = o.get("encoder", "auto")
    if choice == "cpu":
        return ["libx264"]
    if choice not in ("auto", "", None):
        return [choice, "libx264"]
    if not ENCODERS["list"]:
        return ["libx264"]
    return [ENCODERS["list"][0][0], "libx264"]


ENC_LABEL = dict(HW_CANDIDATES, libx264="CPU (x264)")


# ============================================================================ timeline (intro + potong jeda)

def make_timeline(o, dur, parts=None):
    """-> list segmen output.
    input "T" = potongan intro (dibuka terpisah dengan -ss, supaya RAM tidak penuh),
    input "M" = clip utama (boleh terpotong-potong oleh fitur potong jeda)."""
    parts = parts or [(0.0, dur)]
    segs = []
    if o.get("intro_on"):
        n = float(o.get("intro_len", 3) or 3)
        try:
            t0 = parse_time(str(o.get("intro_from") or "0"))
        except UserError:
            t0 = 0.0
        t0 = min(max(0.0, t0), max(0.0, dur - 0.6))
        n = max(0.5, min(n, dur - t0))
        segs.append({"kind": "play", "src": t0, "dur": n, "teaser": True, "input": "T"})
        if o.get("intro_fx") == "rewind":
            segs.append({"kind": "rewind", "src": t0, "dur": n, "input": "T"})
    for a, b in parts:
        segs.append({"kind": "play", "src": a, "dur": b - a, "main": True, "input": "M"})
    t = 0.0
    for s in segs:
        s["out"] = t
        s["out_dur"] = s["dur"] / 4 if s["kind"] == "rewind" else s["dur"]
        t += s["out_dur"]
    return segs


def out_mapper(segs):
    """Waktu di dalam clip -> waktu di video hasil (bagian utama). Bagian yang terpotong -> lompat ke berikutnya."""
    main = [s for s in segs if s.get("main")]

    def f(t):
        for s in main:
            if s["src"] <= t < s["src"] + s["dur"]:
                return s["out"] + t - s["src"]
        for s in main:
            if t < s["src"]:
                return s["out"]
        return None
    return f


def teaser_times(segs, t):
    sg = next((s for s in segs if s.get("teaser")), None)
    if sg and sg["src"] <= t < sg["src"] + sg["dur"]:
        return [sg["out"] + t - sg["src"]]
    return []


def shift_chunks(chunks, segs):
    """Susun ulang subtitle mengikuti timeline output (teaser + ulang + potong jeda)."""
    out = []
    for sg in segs:
        if sg["kind"] != "play":
            continue
        a, b, off = sg["src"], sg["src"] + sg["dur"], sg["out"] - sg["src"]
        for c in chunks:
            ws = [dict(w, s=w["s"] + off, e=min(w["e"], b) + off) for w in c["words"] if a - 0.05 <= w["s"] < b]
            if ws:
                out.append({"start": ws[0]["s"], "end": ws[-1]["e"], "text": " ".join(w["t"] for w in ws),
                            "words": ws})
    out.sort(key=lambda c: c["start"])
    return out


AFMT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"


def timeline_graph(segs, F, has_audio, m_idx, t_idx, video=True):
    """Filter penyusun timeline. Bagian utama dari input m_idx (urut waktu -> aman RAM),
    intro/rewind dari input t_idx. -> (graph, vlabel, alabel)"""
    g = []
    main = [i for i, s in enumerate(segs) if s["input"] == "M"]
    tz = [i for i, s in enumerate(segs) if s["input"] == "T"]
    many = len(main) > 1
    if video:
        if many:
            g.append(f"[{m_idx}:v]split={len(main)}" + "".join(f"[tv{i}]" for i in main))
        if tz:
            g.append(f"[{t_idx}:v]setpts=PTS-STARTPTS,fps={F},format=yuv420p,setsar=1"
                     + (f",split={len(tz)}" if len(tz) > 1 else "") + "".join(f"[tz{i}]" for i in tz))
    if has_audio:
        if many:
            g.append(f"[{m_idx}:a]asplit={len(main)}" + "".join(f"[ta{i}]" for i in main))
        if tz:
            g.append(f"[{t_idx}:a]asetpts=PTS-STARTPTS,{AFMT}" + (f",asplit={len(tz)}" if len(tz) > 1 else "")
                     + "".join(f"[tza{i}]" for i in tz))
    cat = ""
    for i, sg in enumerate(segs):
        if sg["input"] == "T":
            if video:
                if sg["kind"] == "rewind":
                    g.append(f"[tz{i}]setpts=PTS/4,fps={F},reverse[sv{i}]")
                else:
                    g.append(f"[tz{i}]null[sv{i}]")
            if has_audio:
                if sg["kind"] == "rewind":
                    g.append(f"[tza{i}]areverse,atempo=2.0,atempo=2.0,volume=0.6[sa{i}]")
                else:
                    g.append(f"[tza{i}]anull[sa{i}]")
        else:
            vsrc = f"[tv{i}]" if many else f"[{m_idx}:v]"
            asrc = f"[ta{i}]" if many else f"[{m_idx}:a]"
            if video:
                g.append(f"{vsrc}trim=start={sg['src']:.3f}:duration={sg['dur']:.3f},setpts=PTS-STARTPTS,fps={F},"
                         f"format=yuv420p,setsar=1[sv{i}]")
            if has_audio:
                fade = ""
                if many and sg["dur"] > 0.1:
                    fade = f",afade=t=in:d=0.015,afade=t=out:st={sg['dur'] - 0.015:.3f}:d=0.015"
                g.append(f"{asrc}atrim=start={sg['src']:.3f}:duration={sg['dur']:.3f},asetpts=PTS-STARTPTS,"
                         f"{AFMT}{fade}[sa{i}]")
        cat += (f"[sv{i}]" if video else "") + (f"[sa{i}]" if has_audio else "")
    n = len(segs)
    outs = ("[vin]" if video else "") + ("[ain]" if has_audio else "")
    g.append(f"{cat}concat=n={n}:v={1 if video else 0}:a={1 if has_audio else 0}{outs}")
    return ";".join(g), ("vin" if video else None), ("ain" if has_audio else None)


def has_audio_stream(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout
    return bool(out.strip())


def clip_rel(raw, s, e, what="Waktu"):
    """'1:23:40' (menit video) atau '0:12' (detik di dalam clip) -> detik relatif dalam clip."""
    raw = str(raw or "").strip()
    if not raw:
        return None
    t = parse_time(raw)
    if s <= t < e:
        return t - s
    if t < e - s and t < s:
        return t
    raise UserError(f"{what} {raw} harus di antara mulai ({fmt_time(s)}) dan selesai ({fmt_time(e)}) clip itu.")


# ============================================================================ efek tambahan

def image_size(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "stream=width,height", "-of", "csv=p=0:s=x", str(path)], capture_output=True,
                             text=True).stdout.strip()
        w, h = out.split("x")[:2]
        return int(w), int(h)
    except Exception:
        return None


def jump_parts(job, o, words, src, dur):
    if not o.get("jc_on"):
        return [(0.0, dur)]
    gap = max(0.3, float(o.get("jc_gap") or 0.8))
    spans = EA.speech_spans(words=words or None, src=src)
    parts = EA.keep_parts(spans, dur, min_gap=gap)
    cut = dur - sum(b - a for a, b in parts)
    if cut > 0.2:
        job.notes.append(f"Potong jeda: {len(parts) - 1 if len(parts) > 1 else 1} bagian sepi dibuang "
                         f"(hemat {cut:.1f} detik).")
    return parts


def punch_windows(job, o, src, clip_s, clip_e, dur):
    """Zoom kejut -> list waktu mulai (detik dalam clip)."""
    if not o.get("punch_on"):
        return []
    length = max(0.3, float(o.get("punch_len") or 1.2))
    ts = []
    if o.get("punch_auto", True):
        ts += EA.loud_moments(src, max_n=int(o.get("punch_max") or 4), min_gap=length + 2.5)
    for raw in re.split(r"[,;\s]+", str(o.get("punch_times") or "")):
        if not raw:
            continue
        try:
            r = clip_rel(raw, clip_s, clip_e, "Waktu zoom")
            if r is not None:
                ts.append(r)
        except UserError as ex:
            job.warnings.append(str(ex))
    ts = sorted(t for t in set(round(x, 2) for x in ts) if t < dur - 0.2)
    clean = []
    for t in ts:
        if not clean or t - clean[-1] >= length:
            clean.append(t)
    if o.get("punch_auto", True) and not clean:
        job.notes.append("Zoom kejut otomatis: tidak ada momen yang cukup heboh di clip ini.")
    return clean


def sfx_events(job, o, clip_no, s, e, segs, out_dur, words, punch_out):
    """Daftar sound effect yang dipasang di clip ini (waktu dalam timeline output)."""
    to_out = out_mapper(segs)
    evs = []
    intro = any(x.get("teaser") for x in segs)
    main_start = next((x["out"] for x in segs if x.get("main")), 0.0)
    for row in (o.get("sfx") or [])[:30]:
        try:
            if int(row.get("clip") or 0) not in (0, clip_no):
                continue
        except (TypeError, ValueError):
            continue
        it = EA.find("sfx", row.get("file") or "")
        if not it:
            job.warnings.append(f"Sound effect '{row.get('file')}' tidak ditemukan di folder sfx — dilewati.")
            continue
        L = float(row.get("len") or 0)
        eff = min(L, it["dur"]) if L > 0 else it["dur"]
        at = row.get("at", "awal")
        times = []
        if at == "awal":
            times = [0.0]
        elif at == "akhir":
            times = [max(0.0, out_dur - eff)]
        elif at == "ulang":
            if intro:
                times = [main_start]
            else:
                job.warnings.append(f"SFX '{it['name']}' (saat video diulang) dilewati: intro tidak aktif.")
        elif at == "menit":
            try:
                r = clip_rel(row.get("time"), s, e, f"Waktu SFX '{it['name']}'")
            except UserError as ex:
                job.warnings.append(str(ex))
                r = None
            if r is not None:
                t = to_out(r)
                if t is not None:
                    times = [t]
        elif at == "kata":
            target = [ES._bare(x) for x in str(row.get("time") or "").split() if ES._bare(x)]
            if not target:
                continue
            if not words:
                job.warnings.append(f"SFX '{it['name']}' (saat kata diucapkan) butuh subtitle aktif — dilewati.")
                continue
            bare = [ES._bare(w["t"]) for w in words]
            last = -99.0
            for i in range(len(words) - len(target) + 1):
                if bare[i:i + len(target)] == target:
                    t = to_out(words[i]["s"])
                    if t is not None and t - last >= eff and len(times) < 6:
                        times.append(t)
                        last = t
            if not times:
                job.notes.append(f"SFX '{it['name']}': kata '{row.get('time')}' tidak terdengar di clip {clip_no}.")
        elif at == "zoom":
            times = list(punch_out)
            if not times:
                job.notes.append(f"SFX '{it['name']}' (tiap zoom kejut) tidak dipasang: tidak ada zoom kejut.")
        for t in times:
            if t < out_dur - 0.05:
                evs.append({"path": SFX / it["id"], "t": t, "vol": max(0.0, float(row.get("vol") or 100)) / 100,
                            "len": min(eff, out_dur - t), "gain": it["gain"], "dur": it["dur"],
                            "name": it["name"]})
    if evs:
        job.notes.append("Sound effect: " + ", ".join(f"{x['name']} @{x['t']:.1f}s" for x in evs[:8])
                         + (" ..." if len(evs) > 8 else ""))
    return evs


class Inputs:
    """Pengumpul argumen input ffmpeg + nomor indeksnya."""

    def __init__(self, start=0):
        self.args, self.n = [], start

    def add(self, args):
        self.args += [str(a) for a in args]
        self.n += 1
        return self.n - 1


# ============================================================================ render

IMAGES = {"logo": WORK / "logo.png", "banner_logo": WORK / "banner_logo.png", "banner": WORK / "banner.png"}


def overlay_chain(o, W, H, vlabel, inputs, F, banner):
    """drawbox band banner + overlay gambar (banner, logo banner, logo) -> (graph_tambahan, label)."""
    g, cur, k = [], vlabel, 0

    def ov(path, scale, x, y, op=1.0):
        nonlocal cur, k
        idx = inputs.add(["-loop", "1", "-framerate", str(F), "-i", path])
        alpha = f",colorchannelmixer=aa={op:.2f}" if op < 0.999 else ""
        g.append(f"[{idx}:v]{scale},format=rgba{alpha}[ovi{k}];[{cur}][ovi{k}]overlay={x}:{y}:shortest=1[ovo{k}]")
        cur = f"ovo{k}"
        k += 1

    if banner:
        if banner["mode"] == "teks":
            col = (o.get("banner_bg") or "#000000").lstrip("#")
            op = max(0.0, min(1.0, float(o.get("banner_op") or 60) / 100))
            y, h = int(banner["y"]), even(banner["h"])
            box = f"drawbox=x=0:y={y}:w={W}:h={h}:color=0x{col}@{op:.2f}:t=fill"
            if o.get("banner_line", True):
                box += f",drawbox=x=0:y={y + h - 3}:w={W}:h=3:color=white@0.75:t=fill"
            g.append(f"[{cur}]{box}[bnb]")
            cur = "bnb"
            if banner.get("logo"):
                lg = banner["logo"]
                ov(IMAGES["banner_logo"], f"scale=-2:{even(lg['h'])}", f"{lg['x']:.0f}", f"{lg['y']:.0f}")
        elif banner["mode"] == "gambar":
            bw = even(W * float(o.get("banner_w") or 100) / 100)
            ov(IMAGES["banner"], f"scale={bw}:-2", "(main_w-overlay_w)/2", f"{H * float(o.get('banner_y') or 4.5) / 100:.0f}")
    if o.get("logo_on") and IMAGES["logo"].exists():
        lw = even(W * float(o.get("logo_size", 18)) / 100)
        op = max(0.05, min(1.0, float(o.get("logo_opacity", 90)) / 100))
        m, bot = round(W * 0.04), round(H * (0.12 if H > W else 0.07))
        top = round(max(H * 0.06, float(o.get("_safe_top") or 0) + H * 0.012))
        pos = {"kiri-atas": (f"{m}", f"{top}"), "kanan-atas": (f"main_w-overlay_w-{m}", f"{top}"),
               "kiri-bawah": (f"{m}", f"main_h-overlay_h-{bot}"),
               "kanan-bawah": (f"main_w-overlay_w-{m}", f"main_h-overlay_h-{bot}"),
               "atas-tengah": ("(main_w-overlay_w)/2", f"{top}"),
               "bawah-tengah": ("(main_w-overlay_w)/2", f"main_h-overlay_h-{bot}"),
               "tengah": ("(main_w-overlay_w)/2", "(main_h-overlay_h)/2")}.get(o.get("logo_pos", "kanan-atas"))
        ov(IMAGES["logo"], f"scale={lw}:-2", pos[0], pos[1], op)
    return (";".join(g), cur)


def punch_filter(vlabel, wins, z, W, H):
    if not wins:
        return "", vlabel
    cw, ch = even(W / z), even(H / z)
    en = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in wins[:60])
    g = (f"[{vlabel}]split=2[pk0][pk1];[pk1]crop={cw}:{ch}:{(W - cw) // 2}:{(H - ch) // 2},"
         f"scale={W}:{H}:flags=bicubic[pkz];[pk0][pkz]overlay=0:0:enable='{en}'[pko]")
    return g, "pko"


def render(job, src, out_path, chunks, words, o, hook, credit, tag, clip_no=1, clip_s=0.0, clip_e=0.0,
           hook_lines=None, channel=""):
    sw, sh, fps, dur = probe(src)
    audio = has_audio_stream(src)
    W, H = canvas(o)
    layout = o.get("layout", "static")
    if layout == "facecam" and (W, H) != (1080, 1920):
        raise UserError("Layout Facecam + Gameplay hanya untuk rasio 9:16.")
    fps_opt = str(o.get("fps", "30"))
    src_fps = max(1, round(fps))
    F = min(60, src_fps) if fps_opt == "src" else min(int(fps_opt), src_fps)
    parts = jump_parts(job, o, words, src, dur)
    segs = make_timeline(o, dur, parts)
    intro = any(s.get("teaser") for s in segs)
    complex_tl = intro or len(parts) > 1 or parts[0][0] > 0.01 or parts[0][1] < dur - 0.01
    out_dur = sum(s["out_dur"] for s in segs)
    main_seg = next(s for s in segs if s.get("main"))
    to_out = out_mapper(segs)
    # zoom kejut
    p_len = max(0.3, float(o.get("punch_len") or 1.2))
    p_src = punch_windows(job, o, src, clip_s, clip_e, dur)
    p_out = []
    for t in p_src:
        for x in ([to_out(t)] if to_out(t) is not None else []) + teaser_times(segs, t):
            p_out.append(x)
    p_out = sorted(set(round(x, 3) for x in p_out))
    if p_out:
        job.notes.append(f"Zoom kejut: {len(p_out)}× (" + ", ".join(f"{x:.1f}s" for x in p_out[:6]) + ")")
    tmp = WORK / f"r_{uuid.uuid4().hex[:8]}"
    tmp.mkdir()
    rel = tmp.relative_to(APP).as_posix()
    fonts = {"sub": EF.get(o.get("font")), "wm": EF.get(o.get("wm_font") or o.get("font")),
             "hook": EF.get(o.get("hook_font") or o.get("font"))}
    EF.stage([f["id"] for f in fonts.values()], tmp / "fonts")
    fontsdir = f"fontsdir={rel}/fonts"
    behind = o.get("wm_mode") == "belakang" and o.get("wm_text") and layout == "static"
    try:
        if layout == "facecam":
            graph = facecam_graph(o, sw, sh, W, H)
            geom = auto_geom(o, W, H)
        elif layout == "static":
            wm_rel = None
            if behind:
                (tmp / "wm.ass").write_text(ES.build_wm_only(o, out_dur, W, H, fonts["wm"]), encoding="utf-8")
                wm_rel = f"{rel}/wm.ass:{fontsdir}"
            graph, top, bot = static_graph(o, sw, sh, W, H, wm_rel)
            if behind and "split" not in graph:
                behind = False
                job.warnings.append("Watermark 'di belakang video' tidak terlihat karena video memenuhi layar; "
                                    "dipasang transparan di atas video.")
            geom = auto_geom(o, W, H, top, bot)
        else:
            graph = None
            geom = auto_geom(o, W, H)
        # ---- teks: hook, banner, penutup, progress bar
        hf = fonts["hook"]
        extra = []
        banner = None
        if o.get("banner_on"):
            mode = o.get("banner_mode", "teks")
            if mode == "gambar" and IMAGES["banner"].exists():
                banner = {"mode": "gambar"}
                sz = image_size(IMAGES["banner"])
                if sz and sz[0]:
                    bw = even(W * float(o.get("banner_w") or 100) / 100)
                    o = dict(o, _safe_top=H * float(o.get("banner_y") or 4.5) / 100 + bw * sz[1] / sz[0])
            elif mode == "teks":
                asp = None
                if IMAGES["banner_logo"].exists():
                    sz = image_size(IMAGES["banner_logo"])
                    asp = sz[0] / sz[1] if sz and sz[1] else None
                bl = EH.banner_layout(o, W, H, hf, asp)
                banner = dict(bl, mode="teks")
                extra += EH.banner_events(bl, o, hf, out_dur)
                o = dict(o, _safe_top=bl["bottom"])
            else:
                job.warnings.append("Banner gambar belum di-upload — banner dilewati.")
        if hook:
            h0, h1 = (0.0, segs[0]["out_dur"]) if intro else (0.0, out_dur)
            hs = float(o.get("hook_secs") or 0)
            if not intro and hs > 0:
                h1 = min(out_dur, hs)
            cfg, el = EH.prepare(hook, o, W, H, hf, geom["hook_y"], given=hook_lines,
                                 label_text=(o.get("hook_label") or channel))
            extra += EH.events(el, cfg, hf, h0, h1, anim=o.get("hook_anim", "halus"))
        cta = (o.get("cta_text") or "").strip()
        if cta:
            secs = max(1.0, float(o.get("cta_secs") or 3))
            ctpl = {"kutipan": "kotak", "kotak": "kotak", "strip": "strip"}.get(o.get("hook_tpl") or "", "polos")
            ccfg, cel = EH.prepare(cta, o, W, H, hf, H * 0.45, tpl=ctpl,
                                   size=float(o.get("hook_size") or 58) * 0.82, align="tengah", pos="bebas",
                                   y_pct=float(o.get("cta_y") or 45))
            extra += EH.events(cel, ccfg, hf, max(0.0, out_dur - secs), out_dur, anim="halus", layer=4)
        extra += EH.pbar_events(o, W, H, out_dur)
        sub_chunks = shift_chunks(chunks, segs) if complex_tl else chunks
        flash_at = main_seg["out"] if intro and o.get("intro_fx") == "flash" else None
        (tmp / "main.ass").write_text(ES.build_ass(sub_chunks, out_dur, W, H, geom, o, fonts, credit,
                                                   include_wm=not behind, flash_at=flash_at, extra=extra),
                                      encoding="utf-8")
        ass_f = f"ass={rel}/main.ass:{fontsdir}"
        audio_args = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
        tail = ["-movflags", "+faststart", "-pix_fmt", "yuv420p"]
        # ---- sound effect & musik
        sfx = sfx_events(job, o, clip_no, clip_s, clip_e, segs, out_dur, words, p_out)
        music = None
        if o.get("music"):
            it = EA.find("musik", o["music"])
            if it:
                music = {"path": MUSIC / it["id"], "vol": float(o.get("music_vol") or 12),
                         "duck": bool(o.get("music_duck", True)), "gain": it["gain"]}
                job.notes.append(f"Musik latar: {it['name']} ({int(music['vol'])}%"
                                 + (", otomatis mengecil saat ada suara)" if music["duck"] else ")"))
            else:
                job.warnings.append(f"Musik '{o['music']}' tidak ditemukan di folder musik — dilewati.")
        base_gain = 0.0
        if audio and o.get("loud_on", True):
            lv = EA.lufs(src)
            if lv is not None:
                base_gain = max(-20.0, min(20.0, -14.0 - lv))
                job.notes.append(f"Volume disamakan: {lv:.1f} → −14 LUFS ({base_gain:+.1f} dB).")
        t_start = time.time()

        def show(p, extra_txt=""):
            el_ = time.time() - t_start
            eta = el_ / p - el_ if p > 0.03 else None
            bits = [x for x in (extra_txt, f"sisa ±{eta:.0f} dtk" if eta is not None else "") if x]
            job.step("render", p, " · ".join(bits))

        if layout == "ai":
            import engine_camera as EC
            zoom = float(o.get("ai_zoom", 1.0 if H > W else 1.4))
            if W >= H:
                zoom = max(1.15, zoom)
            speech = speech_from_words(words) if words else speech_from_audio(src)
            job.set(f"{tag}: AI kamera menganalisis wajah & siapa yang bicara...")
            job.step("ai", 0.0, "mendeteksi wajah...")
            rects, info = EC.plan(src, sw, sh, F, dur, W, H, zoom, speech, o.get("ai_style", "halus"),
                                  o.get("ai_transition", "geser"), log,
                                  lambda p: job.step("ai", p, f"{p * dur:.0f} / {dur:.0f} detik video"))
            job.step("ai", 1.0, f"{info['faces']} wajah · {info['switches']} perpindahan kamera")
            det = "YuNet" if info["detector"] == "yunet" else "cadangan (Haar, kurang akurat)"
            job.notes.append(f"AI kamera: {info['faces']} wajah terlacak, {info['switches']} perpindahan kamera, "
                             f"detektor {det}.")
            if info["faces"] == 0:
                job.warnings.append("AI kamera tidak menemukan wajah — kamera diam di tengah.")
            inp = Inputs(start=0)
            inp.add(["-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(F), "-i", "-"])
            m_idx = inp.add(["-i", src.resolve()])
            t_idx = None
            if intro and audio:
                tsg = segs[0]
                t_idx = inp.add(["-ss", f"{tsg['src']:.3f}", "-t", f"{tsg['dur']:.3f}", "-i", src.resolve()])
            g = []
            og, vcur = overlay_chain(o, W, H, "0:v", inp, F, banner)
            if og:
                g.append(og)
            g.append(f"[{vcur}]{ass_f},format=yuv420p[v]")
            base = None
            if audio:
                if complex_tl:
                    ag, _, base = timeline_graph(segs, F, True, m_idx, t_idx, video=False)
                    g.append(ag)
                else:
                    base = f"{m_idx}:a"
            mg, alab, margs = EA.mix_graph(base, out_dur, sfx, music, o, inp.n, base_gain)
            inp.args += margs
            g.append(mg)
            post = ";".join(g)
            vsegs = []
            for sg in segs:
                if sg["kind"] == "rewind":
                    vsegs.append({"kind": "rewind", "start": sg["src"], "dur": sg["dur"]})
                else:
                    vsegs.append({"kind": "play", "start": sg["src"], "dur": sg["dur"],
                                  "capture": any(x["kind"] == "rewind" for x in segs) and sg.get("teaser")})
            nfr = len(rects)
            pz = max(1.02, float(o.get("punch_z") or 1.18))

            def rect_at(t):
                x, y, cw, ch = rects[min(nfr - 1, max(0, int(round(t * F))))]
                if any(a <= t < a + p_len for a in p_src):
                    nw, nh = cw / pz, ch / pz
                    return (x + (cw - nw) / 2, y + (ch - nh) * 0.4, nw, nh)
                return (x, y, cw, ch)
            last = None
            for enc in encoder_chain(o):
                cmd = ["ffmpeg", "-y", "-v", "error"] + inp.args + ["-filter_complex", post, "-map", "[v]",
                                                                     "-map", f"[{alab}]"] \
                    + video_codec_args(enc, o.get("crf", 18)) + audio_args + ["-t", f"{out_dur:.3f}"] + tail \
                    + [str(out_path.resolve())]
                job.set(f"{tag}: render video {W}×{H} (kamera AI, {ENC_LABEL.get(enc, enc)})...")
                t_start = time.time()
                try:
                    EC.render_frames(src.resolve(), cmd, rect_at, vsegs, sw, sh, W, H, F,
                                     lambda p: show(p, ENC_LABEL.get(enc, enc)), cwd=str(APP),
                                     total_frames=int(out_dur * F))
                    last = None
                    break
                except Exception as ex:  # noqa
                    last = ex
                    if enc != "libx264":
                        job.warnings.append(f"Encoder {ENC_LABEL.get(enc)} gagal, otomatis pindah ke CPU.")
                        log(f"encoder {enc} gagal: {ex}")
            if last:
                raise UserError(f"Render gagal: {last}")
        else:
            inp = Inputs(start=0)
            m_idx = inp.add(["-i", src.resolve()])
            t_idx = None
            if intro:
                tsg = segs[0]
                t_idx = inp.add(["-ss", f"{tsg['src']:.3f}", "-t", f"{tsg['dur']:.3f}", "-i", src.resolve()])
            g = []
            base = f"{m_idx}:a" if audio else None
            if complex_tl:
                tg, vin, ain = timeline_graph(segs, F, audio, m_idx, t_idx)
                g.append(tg)
                graph = graph.replace("[0:v]", f"[{vin}]", 1)
                base = ain
            g.append(graph)
            pw = [(t, t + p_len) for t in p_out]
            pg, vcur = punch_filter("base", pw, max(1.02, float(o.get("punch_z") or 1.18)), W, H)
            if pg:
                g.append(pg)
            og, vcur = overlay_chain(o, W, H, vcur, inp, F, banner)
            if og:
                g.append(og)
            g.append(f"[{vcur}]{ass_f},fps={F},format=yuv420p[v]")
            mg, alab, margs = EA.mix_graph(base, out_dur, sfx, music, o, inp.n, base_gain)
            inp.args += margs
            g.append(mg)
            full = ";".join(g)
            last = None
            for enc in encoder_chain(o):
                speed = {"v": ""}

                def on_line(line, enc=enc):
                    sp = re.match(r"speed=\s*([\d.]+)x", line)
                    if sp:
                        speed["v"] = f"{sp.group(1)}× realtime"
                    m = re.match(r"out_time_us=(\d+)", line) or re.match(r"out_time_ms=(\d+)", line)
                    if m and out_dur > 0:
                        show(min(0.99, int(m.group(1)) / 1e6 / out_dur),
                             ENC_LABEL.get(enc, enc) + (" · " + speed["v"] if speed["v"] else ""))
                job.set(f"{tag}: render video {W}×{H} ({ENC_LABEL.get(enc, enc)})...")
                t_start = time.time()
                try:
                    run_lines(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"]
                              + inp.args + ["-filter_complex", full, "-map", "[v]", "-map", f"[{alab}]"]
                              + video_codec_args(enc, o.get("crf", 18)) + audio_args + ["-t", f"{out_dur:.3f}"]
                              + tail + [str(out_path.resolve())], on_line, cwd=APP)
                    last = None
                    break
                except UserError as ex:
                    last = ex
                    if enc != "libx264":
                        job.warnings.append(f"Encoder {ENC_LABEL.get(enc)} gagal, otomatis pindah ke CPU.")
                        log(f"encoder {enc} gagal: {ex}")
            if last:
                raise last
        job.step("render", 1.0, f"selesai dalam {time.time() - t_start:.0f} dtk")
        if o.get("cover_on", True):
            cover = out_path.with_name(out_path.stem + "_cover.jpg")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{min(0.8, out_dur / 2):.2f}", "-i",
                            str(out_path), "-frames:v", "1", "-q:v", "2", str(cover)], capture_output=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return sh


# ============================================================================ jobs

JOBS = {}
JOBQ = queue.Queue()


STEP_LABELS = {"download": "Download potongan video", "model": "Siapkan model subtitle",
               "subs": "Bikin subtitle (Whisper)", "fix": "Koreksi subtitle", "hookai": "AI bikin judul hook & caption",
               "review": "Cek subtitle & judul (menunggu kamu)",
               "ai": "AI kamera: analisis wajah & pembicara", "render": "Render video"}
STEP_W = {"download": 20, "model": 6, "subs": 24, "fix": 4, "hookai": 4, "review": 0, "ai": 12, "render": 34}


class Job:
    def __init__(self, opts):
        self.id = uuid.uuid4().hex[:10]
        self.opts = opts
        self.status = "antre"
        self.stage = "Menunggu giliran..."
        self.progress = 0.0
        self.clip_no = 0
        self.total = len(opts["clips"])
        self.outputs, self.warnings, self.notes = [], [], []
        self.error = None
        self.review = None
        self.steps = []
        self.t0 = time.time()
        self._review_event = threading.Event()
        self._review_result = None

    def begin_clip(self, keys):
        self.steps = [{"key": k, "label": STEP_LABELS[k], "pct": 0.0, "state": "tunggu", "info": "", "t0": None,
                       "secs": 0} for k in keys]
        self.progress = 0.0

    def step(self, key, pct=None, info=None, state=None):
        st = next((x for x in self.steps if x["key"] == key), None)
        if not st:
            return
        for x in self.steps:  # tahap sebelumnya otomatis dianggap selesai
            if x is st:
                break
            if x["state"] in ("tunggu", "jalan"):
                x["state"], x["pct"] = "selesai", 1.0
        if st["t0"] is None:
            st["t0"] = time.time()
        if pct is not None:
            st["pct"] = max(0.0, min(1.0, float(pct)))
        if info is not None:
            st["info"] = info
        st["state"] = state or ("selesai" if st["pct"] >= 1.0 else "jalan")
        st["secs"] = round(time.time() - st["t0"])
        tw = sum(STEP_W[x["key"]] for x in self.steps) or 1
        self.progress = sum(STEP_W[x["key"]] * x["pct"] for x in self.steps) / tw

    def set(self, stage=None, progress=None):
        if stage is not None:
            self.stage = stage
            log(f"[{self.id}] {stage}")

    def public(self):
        steps = [{k: v for k, v in x.items() if k != "t0"} for x in self.steps]
        for x, raw in zip(steps, self.steps):
            if raw["state"] == "jalan" and raw["t0"]:
                x["secs"] = round(time.time() - raw["t0"])
        return {"id": self.id, "status": self.status, "stage": self.stage, "progress": round(self.progress, 3),
                "clip_no": self.clip_no, "total": self.total, "outputs": self.outputs, "steps": steps,
                "elapsed": round(time.time() - self.t0),
                "warnings": list(dict.fromkeys(self.warnings)), "notes": list(dict.fromkeys(self.notes))[-6:],
                "error": self.error, "review": self.review}


def intro_rel(clip, s, e):
    """Waktu intro per clip -> detik relatif di dalam clip. Boleh menit video (1:23:40) atau detik clip (0:12)."""
    return clip_rel(clip.get("intro"), s, e, "Intro")


def hook_ai(job, o, src, chunks, info, tag):
    prov = o.get("hook_ai", "off")
    if prov not in ("gemini", "claude") or not chunks:
        return None
    key = (load_settings().get("keys") or {}).get(prov)
    if not key:
        job.warnings.append(f"Judul AI ({prov}) dilewati: API key belum diisi.")
        return None
    job.set(f"{tag}: AI ({prov}) bikin judul hook & caption...")
    job.step("hookai", 0.3, f"{prov} membaca transkrip" + (" & mendengarkan audio" if prov == "gemini" else ""))
    mp3 = None
    try:
        if prov == "gemini":
            mp3 = ES.make_mp3(src, src.with_suffix(".hook.mp3"))
        res = ES.ai_hook(prov, key, o.get("ai_model", "") if o.get("ai_fix") == prov else "", chunks,
                         {"title": info.get("title"), "channel": info.get("channel")}, mp3)
        job.step("hookai", 1.0, f"{len(res['hooks'])} pilihan judul")
        return res
    except ES.SubError as ex:
        job.warnings.append(str(ex))
        job.step("hookai", 1.0, "gagal — lanjut tanpa judul AI")
        return None
    finally:
        if mp3:
            try:
                mp3.unlink()
            except OSError:
                pass


def process(job):
    o = job.opts
    url = norm_url(o["url"])
    info = get_info(url)
    vid = info["key"]
    plat = "Twitch" if info.get("platform") == "twitch" else "YouTube"
    dur_total = float(info.get("duration") or 0)
    if info.get("max_height") and info["max_height"] < 1080:
        job.warnings.append(f"Resolusi tertinggi video ini cuma {info['max_height']}p.")
    channel = info.get("channel") or info.get("uploader") or plat
    src_name = channel
    if info.get("platform") == "twitch" and str(info.get("channel_id") or "").startswith("twitch:") \
            and re.fullmatch(r"[a-z0-9_]{2,}", info["channel_id"][7:]):
        src_name = "twitch.tv/" + info["channel_id"][7:]
    credit = f"Sumber: {src_name}" if o.get("credit", True) else ""
    for i, clip in enumerate(o["clips"]):
        job.clip_no = i + 1
        tag = f"Clip {i + 1}/{job.total}"
        s, e = parse_time(clip["start"]), parse_time(clip["end"])
        if e <= s:
            raise UserError(f"{tag}: waktu selesai harus setelah waktu mulai.")
        if dur_total and s >= dur_total:
            raise UserError(f"{tag}: waktu mulai {fmt_time(s)} melebihi durasi video ({fmt_time(dur_total)}).")
        e = min(e, dur_total) if dur_total else e
        use_ai = o.get("subs", True) and o.get("hook_ai", "off") in ("gemini", "claude")
        keys = ["download"]
        if o.get("subs", True):
            keys += ["model", "subs", "fix"] + (["hookai"] if use_ai else []) + (["review"] if o.get("review", True) else [])
        if o.get("layout") == "ai":
            keys.append("ai")
        keys.append("render")
        job.begin_clip(keys)
        job.set(f"{tag}: download potongan video {fmt_time(s)}–{fmt_time(e)}")
        job.step("download", 0.0, f"menghubungi {plat}...")
        src = download_section(url, s, e, WORK / vid / f"src_{job.id}_{i}",
                               on_progress=lambda p, info="": job.step("download", p, info))
        chunks, words = [], []
        title = clip.get("title", "")
        hook_lines = clip.get("hook_lines")
        caption_ai, peak = None, None
        if o.get("subs", True):
            chunks, words = build_subtitles(job, src, o, info, tag, s)
            sug = hook_ai(job, o, src, chunks, info, tag) if use_ai else None
            if sug:
                tags_txt = " ".join(sug["hashtags"])
                caption_ai = (sug["caption"] + ("\n\n" + tags_txt if tags_txt else "")).strip()
                peak = sug["puncak"]
                if not title:
                    title = sug["hooks"][0]
                job.notes.append("Saran judul AI: " + " / ".join(sug["hooks"]))
            if o.get("review", True) and chunks:
                job.step("review", 0.0, "klik Lanjut Render kalau sudah", state="jalan")
                job.review = {"clip": i + 1, "title": title, "hooks": (sug or {}).get("hooks", []),
                              "caption": caption_ai or "",
                              "chunks": [{"start": c["start"], "end": c["end"], "text": c["text"]} for c in chunks]}
                job.status = "cek_subtitle"
                job.set(f"{tag}: cek subtitle & judul, lalu klik Lanjut Render")
                job._review_event.clear()
                job._review_event.wait()
                edited = job._review_result or {}
                job.review = None
                job.status = "jalan"
                if edited.get("chunks") is not None:
                    chunks = ES.apply_edits(chunks, edited["chunks"])
                if edited.get("hook") is not None:
                    title = str(edited["hook"]).strip()
                if edited.get("caption") is not None and str(edited["caption"]).strip():
                    caption_ai = str(edited["caption"]).strip()
                job.step("review", 1.0, "oke")
        name = (f"{slug(channel, 20)}_{slug(title or info.get('title'), 40)}"
                f"_{int(s)}_{o.get('aspect', '9:16').replace(':', 'x')}")
        out_mp4 = OUT / f"{name}.mp4"
        n = 2
        while out_mp4.exists():
            out_mp4 = OUT / f"{name}_{n}.mp4"
            n += 1
        oc = o
        if o.get("intro_on"):
            rel = intro_rel(clip, s, e)
            if rel is None and peak is not None:
                rel = max(0.0, min(peak - 0.6, e - s - 1.0))
                job.notes.append(f"Intro diambil dari momen puncak pilihan AI (detik {rel:.1f} di clip).")
            oc = dict(o, intro_from=str(rel if rel is not None else 0))
        src_h = render(job, src, out_mp4, chunks, words, oc, title, credit, tag, clip_no=i + 1, clip_s=s, clip_e=e,
                       hook_lines=hook_lines if title == clip.get("title", "") else None, channel=channel)
        plain_title = re.sub(r"[*|]", "", title or info.get("title") or "").strip()
        src_line = f"Sumber: {channel} ({plat}) — {source_link(info, s)}"
        if caption_ai:
            caption = f"{caption_ai}\n\n{src_line}"
        else:
            caption = (f"{plain_title}\n\n{src_line}\n"
                       f"#{slug(channel, 30).replace('-', '')} #clip #fyp")
        out_mp4.with_suffix(".txt").write_text(caption, encoding="utf-8")
        try:
            src.unlink()
        except OSError:
            pass
        cover = out_mp4.with_name(out_mp4.stem + "_cover.jpg")
        job.outputs.append({"name": out_mp4.name, "url": "/hasil/" + out_mp4.name, "caption": caption,
                            "cover": ("/hasil/" + cover.name) if cover.exists() else None, "title": plain_title,
                            "source_height": src_h, "seconds": round(e - s, 1), "aspect": o.get("aspect", "9:16")})
    job.set(f"Selesai! {len(job.outputs)} clip siap di folder 'hasil'.")
    job.progress = 1.0


def worker():
    while True:
        job = JOBQ.get()
        job.status = "jalan"
        try:
            process(job)
            job.status = "selesai"
        except (UserError, ES.SubError) as ex:
            job.status, job.error = "gagal", str(ex)
            log(f"[{job.id}] gagal: {ex}")
        except Exception as ex:  # noqa
            job.status, job.error = "gagal", f"Error tak terduga: {ex}\n\n{traceback.format_exc()[-1800:]}"
            log(traceback.format_exc())


# ============================================================================ http

def channel_settings(cid):
    st = load_settings()
    ch = (st.get("channels") or {}).get(cid or "", {})
    if not ch.get("cam") and cid in (st.get("cams") or {}):  # data versi lama
        ch["cam"] = st["cams"][cid]
    return ch


# ============================================================================ HP: ambil video dari link

REMOTE = {}
SIO = (lambda: load_settings(), lambda d: save_settings(d))


def remote_fetch(data):
    """HP minta potongan dari link YouTube/Twitch. PC ini yang mengunduh, lalu HP mengambil file-nya."""
    url = norm_url(data.get("url", ""))
    if not url:
        raise UserError("Tempel link YouTube atau Twitch dulu.")
    s = parse_time(str(data.get("start") or "0"))
    info = get_info(url)
    dur = float(info.get("duration") or 0)
    e_raw = str(data.get("end") or "").strip()
    e = parse_time(e_raw) if e_raw else s + 180
    if dur:
        if s >= dur:
            raise UserError(f"Menit mulai melebihi durasi video ({fmt_time(dur)}).")
        e = min(e, dur)
    if e <= s:
        raise UserError("Waktu selesai harus setelah waktu mulai.")
    if e - s > 600:
        raise UserError("Maksimal 10 menit sekali ambil. Ambil beberapa kali kalau perlu.")
    cutoff = time.time() - 3 * 3600
    for k, j in list(REMOTE.items()):
        if j["t"] < cutoff:
            if j.get("file"):
                try:
                    Path(j["file"]).unlink()
                except OSError:
                    pass
            REMOTE.pop(k, None)
    plat = "Twitch" if info.get("platform") == "twitch" else "YouTube"
    channel = info.get("channel") or info.get("uploader") or plat
    if info.get("platform") == "twitch" and str(info.get("channel_id") or "").startswith("twitch:"):
        channel = "twitch.tv/" + info["channel_id"][7:]
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "jalan", "stage": f"Menghubungi {plat}", "progress": 0.02, "file": None, "error": "",
           "t": time.time(), "size": 0,
           "info": {"title": info.get("title") or "", "channel": channel, "platform": plat, "start": s, "end": e,
                    "source": source_link(info, s)}}
    REMOTE[jid] = job
    threading.Thread(target=_remote_run, args=(job, url, s, e), daemon=True).start()
    return job


def _remote_run(job, url, s, e):
    d = WORK / "remote"
    d.mkdir(exist_ok=True)
    src = None
    try:
        src = download_section(url, s, e, d / f"src_{job['id']}",
                               on_progress=lambda p, t="": job.update(progress=0.05 + 0.6 * p,
                                                                      stage="Mengunduh potongan" + (f" ({t})" if t else "")))
        out = d / f"hp_{job['id']}.mp4"
        seg = max(0.1, e - s)
        job.update(stage="Mengecilkan ukuran supaya cepat dikirim ke HP", progress=0.66)
        last = None
        for enc in encoder_chain({}):
            def on_line(line):
                m = re.match(r"out_time_us=(\d+)", line) or re.match(r"out_time_ms=(\d+)", line)
                if m:
                    job["progress"] = 0.66 + 0.33 * min(1.0, int(m.group(1)) / 1e6 / seg)
            try:
                run_lines(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
                           "-i", str(src), "-vf", "scale=w='min(1920,iw)':h=-2"] + phone_codec_args(enc)
                          + ["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart",
                             str(out)], on_line)
                last = None
                break
            except UserError as ex:
                last = ex
        if last:
            raise last
        job.update(status="selesai", progress=1.0, stage="Siap dikirim ke HP", file=str(out), size=out.stat().st_size)
        log(f"HP: potongan siap ({out.stat().st_size / 1e6:.0f} MB).")
    except Exception as ex:  # noqa
        job.update(status="gagal", error=str(ex)[-700:])
    finally:
        if src:
            try:
                Path(src).unlink()
            except OSError:
                pass


def phone_codec_args(enc):
    """Video untuk dikirim ke HP: target sekitar 6 Mbps (1080p), supaya cepat sampai tanpa terlihat pecah."""
    rate = ["-b:v", "6M", "-maxrate", "9M", "-bufsize", "12M"]
    if enc == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr"] + rate + ["-profile:v", "high"]
    if enc == "h264_qsv":
        return ["-c:v", "h264_qsv", "-preset", "faster"] + rate + ["-profile:v", "high"]
    if enc == "h264_amf":
        return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "vbr_peak"] + rate
    if enc == "h264_videotoolbox":
        return ["-c:v", "h264_videotoolbox", "-b:v", "6M", "-maxrate", "9M", "-profile:v", "high"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "6M", "-bufsize", "12M",
            "-profile:v", "high", "-threads", "0"]


def remote_public(job):
    return {k: job[k] for k in ("id", "status", "stage", "progress", "error", "size", "info")}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        o = getattr(self, "_cors", None)
        if o:
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Disposition")
        super().end_headers()

    def _gate(self):
        """Lewat tunnel (dari HP) hanya boleh ke /api/remote/fetch|job|file|ping."""
        self._cors = ER.cors_origin(self.headers.get("Origin"))
        if ER.is_remote(self.headers):
            path = urlparse(self.path).path
            if not path.startswith("/api/remote/") or path in ("/api/remote/start", "/api/remote/stop",
                                                               "/api/remote/status"):
                self.send_error(403)
                return False
        return True

    def _key_ok(self):
        if ER.authorized(self.headers, SIO):
            return True
        self.send_json({"error": "Kunci salah. Pasangkan ulang HP dari KlipKu PC (tombol Sambungkan HP)."}, 403)
        return False

    def do_OPTIONS(self):
        self._cors = ER.cors_origin(self.headers.get("Origin"))
        self.send_response(204)
        if self._cors:
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-KlipKu-Key")
            self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n).decode("utf-8") or "{}")

    def send_file(self, path, ctype=None):
        if not path or not Path(path).is_file():
            self.send_error(404)
            return
        path = Path(path)
        size = path.stat().st_size
        ctype = ctype or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix.lower() in (".ttf", ".otf"):
            ctype = "font/" + path.suffix.lower()[1:]
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)", rng or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            else:
                start = max(0, size - int(m.group(2)))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        # font boleh di-cache; halaman, gambar & video jangan (supaya update langsung terlihat)
        self.send_header("Cache-Control", "max-age=3600" if path.suffix.lower() in (".ttf", ".otf") else "no-store")
        if "download=1" in self.path:
            self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                pass

    def safe(self, base, rel):
        p = (base / unquote(rel)).resolve()
        if base.resolve() not in p.parents and p != base.resolve():
            return None
        return p

    def do_GET(self):
        if not self._gate():
            return
        path = urlparse(self.path).path
        if path == "/api/remote/status":
            return self.send_json(ER.status(SIO))
        if path == "/api/remote/ping":
            if self._key_ok():
                self.send_json({"ok": True, "version": VERSION})
            return
        if path.startswith("/api/remote/job/"):
            if not self._key_ok():
                return
            job = REMOTE.get(path.split("/")[4])
            return self.send_json(remote_public(job)) if job else self.send_json({"error": "tidak ada"}, 404)
        if path.startswith("/api/remote/file/"):
            if not self._key_ok():
                return
            job = REMOTE.get(path.split("/")[4])
            if not job or not job.get("file"):
                return self.send_json({"error": "file belum siap"}, 404)
            return self.send_file(job["file"], "video/mp4")
        if path in ("/", "/index.html"):
            return self.send_file(WEB / "index.html")
        if path.startswith("/fontfile/"):
            fid = path.split("/")[2].split(".")[0]
            f = EF.registry().get(fid)
            return self.send_file(f["path"]) if f else self.send_error(404)
        if path == "/logo.png":
            return self.send_file(LOGO)
        if path.startswith("/img/"):
            kind = path.split("/")[2].split(".")[0]
            return self.send_file(IMAGES.get(kind)) if kind in IMAGES else self.send_error(404)
        if path == "/api/sfx":
            return self.send_json({"sfx": EA.library("sfx"), "music": EA.library("musik")})
        for prefix, base in (("/web/", WEB), ("/work/", WORK), ("/hasil/", OUT), ("/sfx/", SFX), ("/musik/", MUSIC)):
            if path.startswith(prefix):
                p = self.safe(base, path[len(prefix):])
                return self.send_file(p) if p else self.send_error(403)
        if path == "/api/status":
            st = load_settings()
            keys = st.get("keys") or {}
            return self.send_json({"tools": tool_status(), "last": st.get("last", {}), "version": VERSION,
                                   "keys": {k: bool(v) for k, v in keys.items()}, "rules": st.get("rules", ""),
                                   "logo": LOGO.exists(), "default_font": EF.DEFAULT_FONT,
                                   "images": {k: v.exists() for k, v in IMAGES.items()},
                                   "presets": st.get("presets", {}),
                                   "encoders": [lbl for _, lbl in ENCODERS["list"]],
                                   "encoder_ids": [[e, lbl] for e, lbl in ENCODERS["list"]],
                                   "encoder_errors": ENCODERS.get("errors", {}),
                                   "encoders_checked": ENCODERS["checked"]})
        if path == "/api/fonts":
            if "refresh=1" in self.path:
                EF.scan(force=True)
            return self.send_json({"fonts": EF.public_list(), "default": EF.DEFAULT_FONT})
        if path == "/api/active":
            live = [j for j in JOBS.values() if j.status in ("antre", "jalan", "cek_subtitle")]
            return self.send_json({"job": live[-1].id if live else None})
        if path.startswith("/api/job/"):
            job = JOBS.get(path.split("/")[3])
            return self.send_json(job.public()) if job else self.send_json({"error": "job tidak ada"}, 404)
        self.send_error(404)

    def do_POST(self):
        if not self._gate():
            return
        path = urlparse(self.path).path
        try:
            data = self.read_json()
            if path == "/api/remote/start":
                try:
                    res = ER.start(self.server.server_address[1], SIO, log)
                    ER.set_auto(SIO, True)
                    return self.send_json(res)
                except RuntimeError as ex:
                    return self.send_json(dict(ER.status(SIO), error=str(ex)))
            if path == "/api/remote/stop":
                ER.stop(SIO, log)
                ER.set_auto(SIO, False)
                return self.send_json(ER.status(SIO))
            if path == "/api/remote/fetch":
                if not self._key_ok():
                    return
                return self.send_json(remote_public(remote_fetch(data)))
            if path == "/api/info":
                info = get_info(data.get("url", ""))
                ch = channel_settings(info.get("channel_id"))
                return self.send_json({"ok": True, "info": info, "duration_text": fmt_time(info.get("duration") or 0),
                                       "saved_cam": ch.get("cam"), "saved_terms": ch.get("terms", "")})
            if path == "/api/preview":
                img = make_preview(data["url"], parse_time(data.get("time") or "0"))
                faces, kind = [], None
                try:
                    import engine_camera as EC
                    faces, kind = EC.detect_on_image(APP / img.lstrip("/"))
                except Exception as ex:  # noqa
                    log(f"deteksi wajah preview gagal: {ex}")
                return self.send_json({"ok": True, "image": img + f"?v={int(time.time())}", "faces": faces,
                                       "detector": kind})
            if path in ("/api/logo", "/api/image"):
                kind = data.get("kind", "logo")
                target = IMAGES.get(kind)
                if not target:
                    raise UserError("Jenis gambar tidak dikenal.")
                if data.get("remove"):
                    if target.exists():
                        target.unlink()
                    return self.send_json({"ok": True})
                raw = data.get("data", "")
                m = re.match(r"data:image/[\w.+-]+;base64,(.*)$", raw, flags=re.S)
                if not m:
                    raise UserError("File harus gambar (PNG/JPG/WEBP).")
                tmp = WORK / f"{kind}_upload"
                tmp.write_bytes(base64.b64decode(m.group(1)))
                r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(tmp), "-frames:v", "1",
                                    "-pix_fmt", "rgba", str(target)], capture_output=True, text=True)
                tmp.unlink(missing_ok=True)
                if r.returncode != 0 or not target.exists():
                    raise UserError("Gambar tidak bisa dibaca.")
                return self.send_json({"ok": True})
            if path == "/api/audio-upload":
                kind = "musik" if data.get("kind") == "musik" else "sfx"
                m = re.match(r"data:[\w/.+-]*;base64,(.*)$", data.get("data", ""), flags=re.S)
                if not m:
                    raise UserError("File audio tidak terbaca.")
                raw = base64.b64decode(m.group(1))
                if len(raw) > 40 * 1024 * 1024:
                    raise UserError("File audio terlalu besar (maksimal 40 MB).")
                name = EA.save_upload(kind, data.get("name") or "audio.mp3", raw)
                if not name:
                    raise UserError("File itu bukan audio yang bisa diputar (coba MP3/WAV).")
                return self.send_json({"ok": True, "id": name, "list": EA.library(kind)})
            if path == "/api/preset":
                name = re.sub(r"\s+", " ", str(data.get("name") or "")).strip()[:40]
                if not name:
                    raise UserError("Nama gaya kosong.")
                st = load_settings()
                pr = st.setdefault("presets", {})
                if data.get("delete"):
                    pr.pop(name, None)
                else:
                    pr[name] = {k: v for k, v in (data.get("opts") or {}).items()
                                if k not in ("url", "clips", "cam", "prompt", "ai_key", "groq_key", "hook_ai_key")}
                save_settings(st)
                return self.send_json({"ok": True, "presets": pr})
            if path == "/api/key":
                prov = data.get("provider")
                if prov not in ("gemini", "claude", "groq"):
                    raise UserError("Penyedia AI tidak dikenal.")
                st = load_settings()
                key = (data.get("key") or "").strip()
                if key:
                    st.setdefault("keys", {})[prov] = key
                else:
                    (st.get("keys") or {}).pop(prov, None)
                save_settings(st)
                return self.send_json({"ok": True, "keys": {k: bool(v) for k, v in (st.get("keys") or {}).items()}})
            if path == "/api/render":
                opts = data
                if not opts.get("clips"):
                    raise UserError("Belum ada clip. Isi menit mulai dan selesai dulu.")
                for c in opts["clips"]:
                    s, e = parse_time(c["start"]), parse_time(c["end"])
                    if e <= s:
                        raise UserError(f"Waktu selesai ({c['end']}) harus setelah waktu mulai ({c['start']}).")
                    if e - s > 180:
                        raise UserError(f"Clip {c['start']}–{c['end']} lebih dari 3 menit. Pendekkan dulu.")
                    if opts.get("intro_on"):
                        intro_rel(c, s, e)
                if opts.get("layout") == "facecam" and opts.get("aspect", "9:16") != "9:16":
                    raise UserError("Layout Facecam + Gameplay hanya tersedia untuk rasio 9:16.")
                info = get_info(opts["url"])
                st = load_settings()
                cid = info.get("channel_id") or ""
                ch = st.setdefault("channels", {}).setdefault(cid, {})
                if opts.get("cam"):
                    ch["cam"] = opts["cam"]
                ch["terms"] = opts.get("prompt", "")
                st["rules"] = opts.get("rules", "")
                key = (opts.pop("ai_key", "") or "").strip()
                if key and opts.get("ai_fix") in ("gemini", "claude"):
                    st.setdefault("keys", {})[opts["ai_fix"]] = key
                gkey = (opts.pop("groq_key", "") or "").strip()
                if gkey:
                    st.setdefault("keys", {})["groq"] = gkey
                hkey = (opts.pop("hook_ai_key", "") or "").strip()
                if hkey and opts.get("hook_ai") in ("gemini", "claude"):
                    st.setdefault("keys", {})[opts["hook_ai"]] = hkey
                st["last"] = {k: v for k, v in opts.items() if k not in ("url", "clips", "cam", "prompt")}
                for raw in re.split(r"[,;\s]+", str(opts.get("punch_times") or "")):
                    if raw and not re.fullmatch(r"[\d:.]+", raw):
                        raise UserError(f"Waktu zoom kejut '{raw}' tidak dikenal. Contoh: 1:23:45, 0:12")
                save_settings(st)
                job = Job(opts)
                JOBS[job.id] = job
                JOBQ.put(job)
                return self.send_json({"ok": True, "job": job.id})
            if path.startswith("/api/job/") and path.endswith("/subtitle"):
                job = JOBS.get(path.split("/")[3])
                if not job or job.status != "cek_subtitle":
                    raise UserError("Tidak ada subtitle yang sedang menunggu dicek.")
                job._review_result = data
                job._review_event.set()
                return self.send_json({"ok": True})
            if path == "/api/open-folder":
                target = str(OUT)
                if sys.platform.startswith("win"):
                    os.startfile(target)  # noqa
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", target])
                else:
                    subprocess.Popen(["xdg-open", target])
                return self.send_json({"ok": True})
            self.send_error(404)
        except (UserError, ES.SubError) as ex:
            self.send_json({"ok": False, "error": str(ex)}, 400)
        except Exception as ex:  # noqa
            log(traceback.format_exc())
            self.send_json({"ok": False, "error": f"Error tak terduga: {ex}"}, 500)


def is_klipku(port):
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=2) as r:
            d = json.loads(r.read().decode("utf-8"))
            return "version" in d or "fonts" in d
    except Exception:
        return False


def pids_on_port(port):
    pids = set()
    try:
        if sys.platform.startswith("win"):
            out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True,
                                 errors="replace").stdout
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[1].endswith(f":{port}") \
                        and parts[2] in ("0.0.0.0:0", "[::]:0") and parts[-1].isdigit():
                    pids.add(int(parts[-1]))
        else:
            out = subprocess.run(["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"], capture_output=True,
                                 text=True).stdout
            pids = {int(x) for x in out.split() if x.isdigit()}
    except Exception:
        pass
    pids.discard(os.getpid())
    return pids


def close_old_instances():
    """Tutup KlipKu lama yang masih jalan, supaya versi baru yang dipakai."""
    for port in range(8765, 8785):
        if not is_klipku(port):
            continue
        for pid in pids_on_port(port):
            log(f"Menutup KlipKu lama yang masih jalan (port {port}, PID {pid})...")
            try:
                if sys.platform.startswith("win"):
                    subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
                else:
                    os.kill(pid, 9)
            except Exception:
                pass
        for _ in range(10):
            if not is_klipku(port):
                break
            time.sleep(0.5)
        if is_klipku(port):
            log(f"PERINGATAN: KlipKu lama di port {port} tidak bisa ditutup otomatis. "
                f"Tutup lewat Task Manager (Python > End task), lalu buka lagi.")


def main():
    close_old_instances()
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=EF.scan, daemon=True).start()
    threading.Thread(target=detect_encoders, daemon=True).start()
    port = 8765
    for p in range(8765, 8785):
        try:
            # Windows: tanpa ini, dua KlipKu bisa "berbagi" port yang sama dan versi lama yang menjawab
            ThreadingHTTPServer.allow_reuse_address = not sys.platform.startswith("win")
            server = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            port = p
            break
        except OSError:
            continue
    else:
        log("Tidak ada port kosong (8765-8784).")
        sys.exit(1)
    url = f"http://127.0.0.1:{port}"
    st = tool_status()
    log("=" * 52)
    log(f"KlipKu versi {VERSION} jalan di {url}")
    log("Biarkan jendela ini terbuka selama memakai KlipKu. Tutup jendela ini untuk berhenti.")
    for k, v in st.items():
        if k != "node" and not v:
            log(f"PERINGATAN: {k} belum terpasang/terdeteksi — jalankan installer lagi.")
    log("=" * 52)
    if (load_settings().get("remote") or {}).get("auto"):
        def _auto_remote():
            try:
                ER.start(port, SIO, log)
            except Exception as ex:  # noqa
                log(f"Sambungan HP belum bisa dinyalakan: {ex}")
        threading.Thread(target=_auto_remote, daemon=True).start()
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("berhenti.")


if __name__ == "__main__":
    main()
