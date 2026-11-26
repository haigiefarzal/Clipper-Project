#!/usr/bin/env python3
"""
KlipKu 2 — alat clip YouTube pribadi.
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
VERSION = "2.1"

WORK.mkdir(exist_ok=True)
OUT.mkdir(exist_ok=True)

import engine_fonts as EF  # noqa: E402
import engine_subs as ES  # noqa: E402


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


def video_id(url):
    m = re.search(r"(?:v=|youtu\.be/|/live/|/shorts/|/embed/)([A-Za-z0-9_-]{11})", url or "")
    if not m:
        raise UserError("link YouTube tidak dikenali. Contoh: https://www.youtube.com/watch?v=xxxxxxxxxxx")
    return m.group(1)


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
        if "Sign in to confirm" in joined or "bot" in joined.lower():
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


# ============================================================================ youtube

_info_cache = {}


def get_info(url):
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
        heights = [f.get("height") or 0 for f in full.get("formats", []) if f.get("vcodec") not in (None, "none")]
        info = {k: full.get(k) for k in ("id", "title", "channel", "channel_id", "uploader", "duration",
                                         "is_live", "was_live", "live_status")}
        info["max_height"] = max(heights) if heights else 0
        info["url"] = url
        cache.write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
    if info.get("is_live") or info.get("live_status") == "is_live":
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
    info = get_info(url)
    dur = float(info.get("duration") or 0)
    t = max(0.0, min(t, max(0.0, dur - 4)))
    vdir = WORK / info["id"]
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
    return f"/work/{info['id']}/{jpg.name}"



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


def logo_chain(o, W, H, in_label, logo_idx, out_label):
    """Tambahkan overlay logo PNG kalau aktif. -> (graph_tambahan, label_hasil)"""
    if not (o.get("logo_on") and LOGO.exists()):
        return "", in_label
    lw = even(W * float(o.get("logo_size", 18)) / 100)
    op = max(0.05, min(1.0, float(o.get("logo_opacity", 90)) / 100))
    m = round(W * 0.04)
    top = round(H * 0.06)
    bot = round(H * (0.12 if H > W else 0.07))
    pos = {"kiri-atas": (f"{m}", f"{top}"), "kanan-atas": (f"main_w-overlay_w-{m}", f"{top}"),
           "kiri-bawah": (f"{m}", f"main_h-overlay_h-{bot}"),
           "kanan-bawah": (f"main_w-overlay_w-{m}", f"main_h-overlay_h-{bot}"),
           "atas-tengah": ("(main_w-overlay_w)/2", f"{top}"),
           "bawah-tengah": ("(main_w-overlay_w)/2", f"main_h-overlay_h-{bot}"),
           "tengah": ("(main_w-overlay_w)/2", "(main_h-overlay_h)/2")}.get(o.get("logo_pos", "kanan-atas"))
    g = (f";[{logo_idx}:v]scale={lw}:-1,format=rgba,colorchannelmixer=aa={op:.2f}[lg];"
         f"[{in_label}][lg]overlay={pos[0]}:{pos[1]}:shortest=1[{out_label}]")
    return g, out_label


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


# ============================================================================ intro hook (teaser + ulang)

def make_timeline(o, dur):
    """-> list segmen output. Tanpa intro: satu segmen 'play' penuh."""
    main = {"kind": "play", "src": 0.0, "dur": dur}
    if not o.get("intro_on"):
        segs = [main]
    else:
        n = float(o.get("intro_len", 3) or 3)
        try:
            t0 = parse_time(str(o.get("intro_from") or "0"))
        except UserError:
            t0 = 0.0
        t0 = min(max(0.0, t0), max(0.0, dur - 0.6))
        n = max(0.5, min(n, dur - t0))
        segs = [{"kind": "play", "src": t0, "dur": n, "teaser": True}]
        if o.get("intro_fx") == "rewind":
            segs.append({"kind": "rewind", "src": t0, "dur": n})
        segs.append(dict(main, main=True))
    t = 0.0
    for s in segs:
        s["out"] = t
        s["out_dur"] = s["dur"] / 4 if s["kind"] == "rewind" else s["dur"]
        t += s["out_dur"]
    return segs


def shift_chunks(chunks, segs):
    """Susun ulang subtitle mengikuti timeline output (teaser + ulang)."""
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


def timeline_graph(segs, F, has_audio):
    """Filter untuk menyusun teaser + (rewind) + video utama dari input 0. -> (graph, vlabel, alabel)"""
    n = len(segs)
    g = [f"[0:v]split={n}" + "".join(f"[tv{i}]" for i in range(n))]
    if has_audio:
        g.append(f"[0:a]asplit={n}" + "".join(f"[ta{i}]" for i in range(n)))
    cat = ""
    for i, sg in enumerate(segs):
        trim = f"trim=start={sg['src']:.3f}:duration={sg['dur']:.3f}"
        if sg["kind"] == "rewind":
            g.append(f"[tv{i}]{trim},setpts=(PTS-STARTPTS)/4,fps={F},reverse,format=yuv420p,setsar=1[sv{i}]")
            if has_audio:
                g.append(f"[ta{i}]atrim=start={sg['src']:.3f}:duration={sg['dur']:.3f},asetpts=PTS-STARTPTS,"
                         f"areverse,atempo=2.0,atempo=2.0,volume=0.6[sa{i}]")
        else:
            g.append(f"[tv{i}]{trim},setpts=PTS-STARTPTS,fps={F},format=yuv420p,setsar=1[sv{i}]")
            if has_audio:
                g.append(f"[ta{i}]atrim=start={sg['src']:.3f}:duration={sg['dur']:.3f},asetpts=PTS-STARTPTS[sa{i}]")
        cat += f"[sv{i}]" + (f"[sa{i}]" if has_audio else "")
    g.append(f"{cat}concat=n={n}:v=1:a={1 if has_audio else 0}[vin]" + ("[ain]" if has_audio else ""))
    return ";".join(g), "vin", ("ain" if has_audio else None)


def has_audio_stream(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout
    return bool(out.strip())


# ============================================================================ render

def render(job, src, out_path, chunks, words, o, hook, credit, tag):
    sw, sh, fps, dur = probe(src)
    audio = has_audio_stream(src)
    W, H = canvas(o)
    layout = o.get("layout", "static")
    if layout == "facecam" and (W, H) != (1080, 1920):
        raise UserError("Layout Facecam + Gameplay hanya untuk rasio 9:16.")
    fps_opt = str(o.get("fps", "30"))
    src_fps = max(1, round(fps))
    F = min(60, src_fps) if fps_opt == "src" else min(int(fps_opt), src_fps)
    segs = make_timeline(o, dur)
    intro = len(segs) > 1
    out_dur = sum(s["out_dur"] for s in segs)
    main_seg = next(s for s in segs if s.get("main") or len(segs) == 1)
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
        sub_chunks = shift_chunks(chunks, segs) if intro else chunks
        hook_span = (0.0, segs[0]["out_dur"]) if intro else None
        flash_at = main_seg["out"] if intro and o.get("intro_fx") == "flash" else None
        (tmp / "main.ass").write_text(ES.build_ass(sub_chunks, out_dur, W, H, geom, o, fonts, hook, credit,
                                                   include_wm=not behind, hook_span=hook_span, flash_at=flash_at),
                                      encoding="utf-8")
        ass_f = f"ass={rel}/main.ass:{fontsdir}"
        audio_args = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
        tail = ["-movflags", "+faststart", "-pix_fmt", "yuv420p"]
        logo_in = ["-loop", "1", "-framerate", str(F), "-i", str(LOGO)] if (o.get("logo_on") and LOGO.exists()) else []
        t_start = time.time()

        def show(p, extra=""):
            el = time.time() - t_start
            eta = el / p - el if p > 0.03 else None
            parts = [x for x in (extra, f"sisa ±{eta:.0f} dtk" if eta is not None else "") if x]
            job.step("render", p, " · ".join(parts))

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
            lg, lab = logo_chain(o, W, H, "0:v", 2, "lgo")
            post = (lg.lstrip(";") + ";" if lg else "") + f"[{lab}]{ass_f},format=yuv420p[v]"
            amap = []
            if audio:
                if intro:
                    tg, _, al = timeline_graph(segs, F, True)
                    # pakai hanya bagian audio dari graph timeline (input 1 = video sumber)
                    aparts = [p for p in tg.split(";") if "[0:a]" in p or "[ta" in p and "atrim" in p]
                    acat = "".join(f"[sa{i}]" for i in range(len(segs)))
                    agraph = ";".join(aparts).replace("[0:a]", "[1:a]") + f";{acat}concat=n={len(segs)}:v=0:a=1[aout]"
                    post += ";" + agraph
                    amap = ["-map", "[aout]"]
                else:
                    amap = ["-map", "1:a"]
            vsegs = []
            for sg in segs:
                if sg["kind"] == "rewind":
                    vsegs.append({"kind": "rewind", "start": sg["src"], "dur": sg["dur"]})
                else:
                    vsegs.append({"kind": "play", "start": sg["src"], "dur": sg["dur"],
                                  "capture": any(x["kind"] == "rewind" for x in segs) and sg.get("teaser")})
            nfr = len(rects)

            def rect_at(t):
                return rects[min(nfr - 1, max(0, int(round(t * F))))]
            last = None
            for enc in encoder_chain(o):
                cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
                       "-r", str(F), "-i", "-", "-i", str(src.resolve())] + logo_in + [
                    "-filter_complex", post, "-map", "[v]"] + amap + video_codec_args(enc, o.get("crf", 18)) \
                    + (audio_args if audio else []) + ["-shortest"] + tail + [str(out_path.resolve())]
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
            pre = ""
            vin, ain = "0:v", ("0:a" if audio else None)
            if intro:
                pre, vin, ain = timeline_graph(segs, F, audio)
                graph = graph.replace("[0:v]", f"[{vin}]", 1)
            lg, lab = logo_chain(o, W, H, "base", 1, "lgo")
            full = (pre + ";" if pre else "") + graph + lg + f";[{lab}]{ass_f},fps={F},format=yuv420p[v]"
            amap = (["-map", f"[{ain}]"] if intro else ["-map", "0:a"]) if ain else []
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
                    run_lines(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
                               "-i", str(src.resolve())] + logo_in + ["-filter_complex", full, "-map", "[v]"] + amap
                              + video_codec_args(enc, o.get("crf", 18)) + (audio_args if ain else []) + tail
                              + [str(out_path.resolve())], on_line, cwd=APP)
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
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return sh


# ============================================================================ jobs

JOBS = {}
JOBQ = queue.Queue()


STEP_LABELS = {"download": "Download potongan video", "model": "Siapkan model subtitle",
               "subs": "Bikin subtitle (Whisper)", "fix": "Koreksi subtitle", "review": "Cek subtitle (menunggu kamu)",
               "ai": "AI kamera: analisis wajah & pembicara", "render": "Render video"}
STEP_W = {"download": 20, "model": 6, "subs": 24, "fix": 4, "review": 0, "ai": 12, "render": 34}


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
    raw = str(clip.get("intro") or "").strip()
    if not raw:
        return None
    t = parse_time(raw)
    if s <= t < e:
        return t - s
    if t < e - s and t < s:  # ditulis relatif terhadap clip
        return t
    raise UserError(f"Intro {raw} harus di antara mulai ({fmt_time(s)}) dan selesai ({fmt_time(e)}) clip itu.")


def process(job):
    o = job.opts
    url = o["url"]
    info = get_info(url)
    vid = info["id"]
    dur_total = float(info.get("duration") or 0)
    if info.get("max_height") and info["max_height"] < 1080:
        job.warnings.append(f"Resolusi tertinggi video ini cuma {info['max_height']}p.")
    credit = f"Sumber: {info.get('channel') or info.get('uploader') or 'YouTube'}" if o.get("credit", True) else ""
    for i, clip in enumerate(o["clips"]):
        job.clip_no = i + 1
        tag = f"Clip {i + 1}/{job.total}"
        s, e = parse_time(clip["start"]), parse_time(clip["end"])
        if e <= s:
            raise UserError(f"{tag}: waktu selesai harus setelah waktu mulai.")
        if dur_total and s >= dur_total:
            raise UserError(f"{tag}: waktu mulai {fmt_time(s)} melebihi durasi video ({fmt_time(dur_total)}).")
        e = min(e, dur_total) if dur_total else e
        keys = ["download"]
        if o.get("subs", True):
            keys += ["model", "subs", "fix"] + (["review"] if o.get("review", True) else [])
        if o.get("layout") == "ai":
            keys.append("ai")
        keys.append("render")
        job.begin_clip(keys)
        job.set(f"{tag}: download potongan video {fmt_time(s)}–{fmt_time(e)}")
        job.step("download", 0.0, "menghubungi YouTube...")
        src = download_section(url, s, e, WORK / vid / f"src_{job.id}_{i}",
                               on_progress=lambda p, info="": job.step("download", p, info))
        chunks, words = [], []
        if o.get("subs", True):
            chunks, words = build_subtitles(job, src, o, info, tag, s)
            if o.get("review", True) and chunks:
                job.step("review", 0.0, "klik Lanjut Render kalau sudah", state="jalan")
                job.review = {"clip": i + 1, "title": clip.get("title", ""),
                              "chunks": [{"start": c["start"], "end": c["end"], "text": c["text"]} for c in chunks]}
                job.status = "cek_subtitle"
                job.set(f"{tag}: cek & perbaiki subtitle, lalu klik Lanjut Render")
                job._review_event.clear()
                job._review_event.wait()
                edited = job._review_result
                job.review = None
                job.status = "jalan"
                if edited is not None:
                    chunks = ES.apply_edits(chunks, edited)
                job.step("review", 1.0, "oke")
        W, H = canvas(o)
        name = (f"{slug(info.get('channel') or 'clip', 20)}_{slug(clip.get('title') or info.get('title'), 40)}"
                f"_{int(s)}_{o.get('aspect', '9:16').replace(':', 'x')}")
        out_mp4 = OUT / f"{name}.mp4"
        n = 2
        while out_mp4.exists():
            out_mp4 = OUT / f"{name}_{n}.mp4"
            n += 1
        oc = o
        if o.get("intro_on"):
            rel = intro_rel(clip, s, e)
            oc = dict(o, intro_from=str(rel if rel is not None else 0))
        src_h = render(job, src, out_mp4, chunks, words, oc, clip.get("title", ""), credit, tag)
        caption = (f"{clip.get('title') or info.get('title')}\n\n"
                   f"Sumber: {info.get('channel')} — https://youtu.be/{vid}?t={int(s)}\n"
                   f"#{slug(info.get('channel') or 'clip', 30).replace('-', '')} #clip #fyp")
        out_mp4.with_suffix(".txt").write_text(caption, encoding="utf-8")
        try:
            src.unlink()
        except OSError:
            pass
        job.outputs.append({"name": out_mp4.name, "url": "/hasil/" + out_mp4.name, "caption": caption,
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


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

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
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self.send_file(WEB / "index.html")
        if path.startswith("/fontfile/"):
            fid = path.split("/")[2].split(".")[0]
            f = EF.registry().get(fid)
            return self.send_file(f["path"]) if f else self.send_error(404)
        if path == "/logo.png":
            return self.send_file(LOGO)
        for prefix, base in (("/web/", WEB), ("/work/", WORK), ("/hasil/", OUT)):
            if path.startswith(prefix):
                p = self.safe(base, path[len(prefix):])
                return self.send_file(p) if p else self.send_error(403)
        if path == "/api/status":
            st = load_settings()
            keys = st.get("keys") or {}
            return self.send_json({"tools": tool_status(), "last": st.get("last", {}), "version": VERSION,
                                   "keys": {k: bool(v) for k, v in keys.items()}, "rules": st.get("rules", ""),
                                   "logo": LOGO.exists(), "default_font": EF.DEFAULT_FONT,
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
        path = urlparse(self.path).path
        try:
            data = self.read_json()
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
            if path == "/api/logo":
                if data.get("remove"):
                    if LOGO.exists():
                        LOGO.unlink()
                    return self.send_json({"ok": True})
                raw = data.get("data", "")
                m = re.match(r"data:image/[\w.+-]+;base64,(.*)$", raw, flags=re.S)
                if not m:
                    raise UserError("File logo harus gambar (PNG/JPG/WEBP).")
                tmp = WORK / "logo_upload"
                tmp.write_bytes(base64.b64decode(m.group(1)))
                r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(tmp), "-frames:v", "1",
                                    "-pix_fmt", "rgba", str(LOGO)], capture_output=True, text=True)
                tmp.unlink(missing_ok=True)
                if r.returncode != 0 or not LOGO.exists():
                    raise UserError("Gambar logo tidak bisa dibaca.")
                return self.send_json({"ok": True})
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
                st["last"] = {k: v for k, v in opts.items() if k not in ("url", "clips", "cam", "prompt")}
                save_settings(st)
                job = Job(opts)
                JOBS[job.id] = job
                JOBQ.put(job)
                return self.send_json({"ok": True, "job": job.id})
            if path.startswith("/api/job/") and path.endswith("/subtitle"):
                job = JOBS.get(path.split("/")[3])
                if not job or job.status != "cek_subtitle":
                    raise UserError("Tidak ada subtitle yang sedang menunggu dicek.")
                job._review_result = data.get("chunks")
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
            return "fonts" in json.loads(r.read().decode("utf-8"))
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
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("berhenti.")


if __name__ == "__main__":
    main()
