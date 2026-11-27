"""Audio: pustaka sound effect & musik, deteksi momen keras (zoom kejut), deteksi jeda (potong jeda),
dan penyusun filter campuran audio (SFX + musik + ducking + standar volume TikTok)."""
import hashlib
import json
import re
import subprocess
import threading
from pathlib import Path

APP = Path(__file__).resolve().parent
SFX_DIR = APP / "sfx"
MUSIC_DIR = APP / "musik"
CACHE = APP / "work" / "audio_cache.json"
EXTS = (".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus")
for _d in (SFX_DIR, MUSIC_DIR):
    _d.mkdir(exist_ok=True)
_lock = threading.Lock()
_cap = {}


def _analyze(path):
    """-> {dur, gain}: gain (dB) supaya rata-rata kerasnya mirip semua (sekitar -16 dB), tanpa clipping."""
    dur = 0.0
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                              str(path)], capture_output=True, text=True, timeout=30).stdout.strip()
        dur = float(out or 0)
    except Exception:
        pass
    gain = 0.0
    try:
        err = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "volumedetect", "-f", "null",
                              "-"], capture_output=True, text=True, timeout=60, errors="replace").stderr
        mean = float(re.search(r"mean_volume:\s*(-?[\d.]+)", err).group(1))
        peak = float(re.search(r"max_volume:\s*(-?[\d.]+)", err).group(1))
        gain = max(-15.0, min(-16.0 - mean, -1.0 - peak, 12.0))
    except Exception:
        pass
    return {"dur": round(dur, 3), "gain": round(gain, 2)}


def library(kind="sfx"):
    """Daftar file audio di folder sfx/ atau musik/ (+ durasi & penyesuaian volume, di-cache)."""
    d = SFX_DIR if kind == "sfx" else MUSIC_DIR
    with _lock:
        try:
            cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
        except Exception:
            cache = {}
        items, changed = [], False
        for p in sorted(d.iterdir(), key=lambda x: x.name.lower()):
            if not p.is_file() or p.suffix.lower() not in EXTS:
                continue
            st = p.stat()
            key = f"{p}|{st.st_mtime}|{st.st_size}"
            info = cache.get(key)
            if not info:
                info = _analyze(p)
                cache[key] = info
                changed = True
            if info["dur"] <= 0:
                continue
            items.append({"id": p.name, "name": p.stem, "dur": info["dur"], "gain": info["gain"]})
        if changed:
            try:
                CACHE.parent.mkdir(exist_ok=True)
                CACHE.write_text(json.dumps(cache), encoding="utf-8")
            except Exception:
                pass
    return items


def find(kind, fid):
    d = SFX_DIR if kind == "sfx" else MUSIC_DIR
    for it in library(kind):
        if it["id"] == fid:
            return dict(it, path=d / it["id"])
    return None


def save_upload(kind, name, raw):
    d = SFX_DIR if kind == "sfx" else MUSIC_DIR
    stem = re.sub(r"[^\w\s.-]", "", Path(name).stem, flags=re.UNICODE).strip()[:60] or "audio"
    ext = Path(name).suffix.lower()
    if ext not in EXTS:
        ext = ".mp3"
    dest = d / f"{stem}{ext}"
    n = 2
    while dest.exists():
        dest = d / f"{stem} {n}{ext}"
        n += 1
    tmp = dest.with_suffix(".tmp" + ext)
    tmp.write_bytes(raw)
    info = _analyze(tmp)
    if info["dur"] <= 0:
        tmp.unlink(missing_ok=True)
        return None
    tmp.replace(dest)
    return dest.name


def ffmpeg_has(filter_name, option):
    k = (filter_name, option)
    if k not in _cap:
        try:
            out = subprocess.run(["ffmpeg", "-hide_banner", "-h", f"filter={filter_name}"], capture_output=True,
                                 text=True, timeout=15).stdout
            _cap[k] = re.search(rf"^\s+{option}\s", out, flags=re.M) is not None
        except Exception:
            _cap[k] = False
    return _cap[k]


# ----------------------------------------------------------------------------- analisis audio clip

def lufs(src):
    """Kekerasan rata-rata (LUFS terintegrasi) audio clip, None kalau gagal/senyap."""
    try:
        err = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(src), "-vn", "-af",
                              "ebur128=framelog=quiet", "-f", "null", "-"], capture_output=True, text=True,
                             timeout=300, errors="replace").stderr
        vals = re.findall(r"I:\s+(-?[\d.]+) LUFS", err)
        v = float(vals[-1]) if vals else None
        return v if v is not None and v > -70 else None
    except Exception:
        return None


def _env(src, hop_s=0.05):
    import numpy as np
    from engine_subs import load_audio
    a = load_audio(src)
    hop = int(16000 * hop_s)
    n = max(1, len(a) // hop)
    rms = np.sqrt(np.mean(a[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-10)
    return 20 * np.log10(rms + 1e-9), hop_s


def loud_moments(src, max_n=4, min_gap=4.0, thr_db=9.0, length=1.2):
    """Momen paling keras/heboh (teriak, ketawa) -> daftar waktu mulai (detik dalam clip)."""
    import numpy as np
    try:
        db, hop = _env(src)
    except Exception:
        return []
    if len(db) < 10:
        return []
    k = max(1, int(0.25 / hop))
    sm = np.convolve(db, np.ones(k) / k, mode="same")
    voiced = sm[sm > np.percentile(sm, 20)]
    base = float(np.median(voiced)) if len(voiced) else float(np.median(sm))
    cand = []
    for i in range(1, len(sm) - 1):
        if sm[i] >= base + thr_db and sm[i] >= sm[i - 1] and sm[i] >= sm[i + 1]:
            cand.append((float(sm[i]), i))
    cand.sort(reverse=True)
    picked = []
    for v, i in cand:
        t_peak = i * hop
        if any(abs(t_peak - p) < min_gap for p in picked):
            continue
        picked.append(t_peak)
        if len(picked) >= max_n:
            break
    out = []
    for t_peak in sorted(picked):
        i = int(t_peak / hop)
        j = i
        while j > 0 and sm[j - 1] >= base + thr_db * 0.5 and (i - j) * hop < 1.0:
            j -= 1
        out.append(max(0.0, j * hop - 0.05))
    return out


def speech_spans(words=None, src=None, pad=0.15):
    """Bagian yang ada suaranya: dari kata Whisper (paling tepat) atau dari energi audio."""
    if words:
        return [(max(0.0, w["s"] - pad), w["e"] + pad) for w in words]
    try:
        import numpy as np
        db, hop = _env(src)
    except Exception:
        return []
    thr = float(np.percentile(db, 35)) + 6
    spans, on = [], None
    for i, v in enumerate(db):
        if v >= thr and on is None:
            on = i
        elif v < thr and on is not None:
            spans.append((max(0.0, on * hop - pad), i * hop + pad))
            on = None
    if on is not None:
        spans.append((max(0.0, on * hop - pad), len(db) * hop))
    return spans


def keep_parts(spans, dur, min_gap=0.8, min_part=0.4):
    """Potong jeda: buang bagian sepi > min_gap detik. -> [(mulai, selesai)] dalam clip."""
    if not spans:
        return [(0.0, dur)]
    spans = sorted((max(0.0, a), min(dur, b)) for a, b in spans if b > a)
    merged = [list(spans[0])]
    for a, b in spans[1:]:
        if a - merged[-1][1] <= min_gap:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    if merged[0][0] <= min_gap:
        merged[0][0] = 0.0
    if dur - merged[-1][1] <= min_gap:
        merged[-1][1] = dur
    parts = [(a, b) for a, b in merged if b - a >= min_part]
    return parts or [(0.0, dur)]


# ----------------------------------------------------------------------------- campuran audio

def duck_expr(spans, depth):
    """Ekspresi volume: suara asli dikecilkan (depth 0..1) saat SFX bunyi, dengan transisi halus."""
    terms = [f"clip((t-{a:.3f})/0.06,0,1)*clip(({b:.3f}-t)/0.15,0,1)" for a, b in spans[:40]]
    if not terms:
        return None
    m = terms[0]
    for t in terms[1:]:
        m = f"max({m},{t})"
    return f"1-{1 - depth:.3f}*{m}"


def mix_graph(base, out_dur, sfx_events, music, o, next_index, base_gain=0.0):
    """Susun filter audio.
    base: label audio utama (mis. '0:a' / 'ain') atau None kalau video tanpa suara.
    sfx_events: [{path, t, vol, len, gain, dur}] waktu dalam timeline OUTPUT.
    music: {path, vol, duck, gain} atau None.
    -> (graph, label_hasil, argumen_input_tambahan)"""
    fmt = "aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
    g, inputs = [], []
    idx = next_index
    if base:
        g.append(f"[{base}]{fmt}" + (f",volume={base_gain:.2f}dB" if abs(base_gain) > 0.05 else "") + "[mx_b]")
    else:
        g.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{out_dur:.3f}[mx_b]")
    cur = "mx_b"
    spans = [(e["t"], e["t"] + (e["len"] or e["dur"])) for e in sfx_events]
    depth = max(0.0, min(1.0, float(o.get("sfx_duck", 45)) / 100))
    if spans and base and depth < 0.99:
        ex = duck_expr(spans, depth)
        if ex:
            g.append(f"[{cur}]volume='{ex}':eval=frame[mx_d]")
            cur = "mx_d"
    mix = []
    if music:
        inputs += ["-stream_loop", "-1", "-i", str(music["path"])]
        mi = idx
        idx += 1
        vol = max(0.0, float(music.get("vol", 12))) / 100
        fade = min(1.5, out_dur / 4)
        g.append(f"[{mi}:a]{fmt},atrim=0:{out_dur:.3f},asetpts=PTS-STARTPTS,volume={music.get('gain', 0):.2f}dB,"
                 f"volume={vol:.3f},afade=t=in:d=0.5,afade=t=out:st={max(0.0, out_dur - fade):.3f}:d={fade:.3f}[mx_m0]")
        if music.get("duck", True) and base:
            g.append(f"[{cur}]asplit=2[mx_main][mx_sc]")
            g.append("[mx_m0][mx_sc]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=400:makeup=1[mx_m]")
            cur = "mx_main"
        else:
            g.append("[mx_m0]anull[mx_m]")
        mix.append("mx_m")
    for k, e in enumerate(sfx_events):
        inputs += ["-i", str(e["path"])]
        si = idx
        idx += 1
        chain = f"[{si}:a]{fmt}"
        if e.get("len") and e["len"] < e["dur"] - 0.05:
            L = e["len"]
            chain += f",atrim=0:{L:.3f},afade=t=out:st={max(0.0, L - 0.25):.3f}:d=0.25"
        ms = int(round(max(0.0, e["t"]) * 1000))
        chain += f",volume={e.get('gain', 0):.2f}dB,volume={max(0.0, e['vol']):.3f},adelay={ms}|{ms}[mx_s{k}]"
        g.append(chain)
        mix.append(f"mx_s{k}")
    if mix:
        n = len(mix) + 1
        if ffmpeg_has("amix", "normalize"):
            g.append(f"[{cur}]" + "".join(f"[{m}]" for m in mix)
                     + f"amix=inputs={n}:duration=first:dropout_transition=0:normalize=0[mx_x]")
        else:  # FFmpeg lama: semua input dipanjangkan sama, lalu skala dikembalikan
            padded = []
            for m in mix:
                g.append(f"[{m}]apad=whole_dur={out_dur:.3f}[{m}p]")
                padded.append(f"{m}p")
            g.append(f"[{cur}]" + "".join(f"[{m}]" for m in padded)
                     + f"amix=inputs={n}:duration=first:dropout_transition=0,volume={n}[mx_x]")
        cur = "mx_x"
    lim = "alimiter=limit=0.89:attack=5:release=60" + (":level=0" if ffmpeg_has("alimiter", "level") else "")
    g.append(f"[{cur}]{lim},{fmt}[aout]")
    return ";".join(g), "aout", inputs


def file_id(path):
    return hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:10]
