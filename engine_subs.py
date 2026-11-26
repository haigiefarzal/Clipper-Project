"""Subtitle: Whisper (GPU/CPU), kamus koreksi, pencocokan bunyi kata khusus, koreksi AI, dan pembuat file ASS."""
import base64
import difflib
import json
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request

_models = {}
_lock = threading.Lock()
GPU_NOTE = {"reason": ""}


def setup_cuda_dlls():
    """Windows: daftarkan DLL cuBLAS/cuDNN dari paket pip nvidia-* supaya Whisper bisa jalan di GPU NVIDIA."""
    import os
    import sys
    if not sys.platform.startswith("win"):
        return
    try:
        import site
        roots = list(site.getsitepackages()) + [site.getusersitepackages()]
    except Exception:
        roots = []
    for r in roots:
        base = os.path.join(r, "nvidia")
        if not os.path.isdir(base):
            continue
        for sub in os.listdir(base):
            b = os.path.join(base, sub, "bin")
            if os.path.isdir(b):
                try:
                    os.add_dll_directory(b)
                except Exception:
                    pass
                if b not in os.environ.get("PATH", ""):
                    os.environ["PATH"] = b + os.pathsep + os.environ.get("PATH", "")


setup_cuda_dlls()


class SubError(Exception):
    pass


# ----------------------------------------------------------------------------- audio + whisper

def load_audio(path, sr=16000):
    import numpy as np
    out = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1",
                          "-ar", str(sr), "-f", "s16le", "-"], capture_output=True)
    if out.returncode != 0 or not out.stdout:
        raise SubError("Gagal membaca suara dari potongan video (mungkin bagian ini tanpa suara).\n"
                       + out.stderr.decode("utf-8", "replace")[-600:])
    return np.frombuffer(out.stdout, np.int16).astype(np.float32) / 32768.0


MODEL_ALIASES = {"large-v3-turbo": ["large-v3-turbo", "deepdml/faster-whisper-large-v3-turbo-ct2"]}
APPROX_MB = {"small": 486, "medium": 1530, "large-v3": 3090, "large-v3-turbo": 1620}


def _repo_dir(name):
    try:
        from faster_whisper.utils import _MODELS
        repo = name if "/" in name else _MODELS.get(name, name)
    except Exception:
        repo = name
    try:
        from huggingface_hub import constants
        root = constants.HF_HUB_CACHE
    except Exception:
        import os
        root = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
    import os
    return os.path.join(root, "models--" + repo.replace("/", "--"))


def _dir_size(path):
    import os
    total = 0
    for dp, _, fns in os.walk(path):
        for fn in fns:
            try:
                total += os.path.getsize(os.path.join(dp, fn))
            except OSError:
                pass
    return total


def ensure_model(name, on_progress=None, log=print):
    """Pastikan model Whisper sudah ada di komputer. Download dengan progres (MB) kalau belum.
    -> path model lokal"""
    from faster_whisper.utils import download_model
    names = MODEL_ALIASES.get(name, [name])
    last = None
    for nm in names:
        try:
            path = download_model(nm, local_files_only=True)
            if on_progress:
                on_progress(1.0, "sudah ada di komputer")
            return path
        except ValueError as ex:  # nama model tidak dikenal versi faster-whisper ini
            last = ex
            continue
        except Exception:
            pass
        # belum ada -> download sambil memantau ukuran folder cache
        total = APPROX_MB.get(name, 1500) * 1024 * 1024
        result, err = {}, {}

        def worker():
            try:
                result["path"] = download_model(nm)
            except Exception as ex:  # noqa
                err["e"] = ex
        t = threading.Thread(target=worker, daemon=True)
        t.start()
        rd = _repo_dir(nm)
        log(f"download model subtitle '{nm}' (sekali saja, ±{total // 1048576} MB)...")
        while t.is_alive():
            t.join(0.7)
            if on_progress:
                got = _dir_size(rd)
                on_progress(min(0.99, got / total), f"download {got / 1048576:.0f} / ±{total / 1048576:.0f} MB")
        if "path" in result:
            if on_progress:
                on_progress(1.0, "selesai download")
            return result["path"]
        last = err.get("e")
        if isinstance(last, ValueError):
            continue
        break
    raise SubError(f"Model subtitle '{name}' gagal didownload: {last}. Cek koneksi internet lalu coba lagi.")


def _load(name, log, force_cpu=False, on_progress=None):
    from faster_whisper import WhisperModel
    key = (name, force_cpu)
    if key in _models:
        return _models[key]
    path = ensure_model(name, on_progress, log)
    gpu = False
    if not force_cpu:
        try:
            import ctranslate2
            gpu = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            gpu = False
    last = None
    for dev, ct in ([("cuda", "float16")] if gpu else []) + [("cpu", "int8")]:
        try:
            log(f"memuat model subtitle di {'GPU' if dev == 'cuda' else 'CPU'}...")
            import os
            extra = {} if dev == "cuda" else {"cpu_threads": max(4, os.cpu_count() or 4)}
            m = WhisperModel(path, device=dev, compute_type=ct, **extra)
            _models[key] = (m, dev)
            return _models[key]
        except Exception as ex:  # noqa
            last = ex
            log(f"gagal memuat model di {dev}: {ex}")
            if dev == "cuda":
                GPU_NOTE["reason"] = str(ex)[:200]
    raise SubError(f"Model subtitle '{name}' gagal dimuat: {last}")


def transcribe(audio, model_name, lang, terms, log=print, on_model=None, on_progress=None):
    prompt = "Obrolan santai bahasa Indonesia, banyak bahasa gaul."
    if terms:
        prompt += " Nama dan istilah: " + ", ".join(terms) + "."
    kw = dict(language=None if lang == "auto" else lang, word_timestamps=True, vad_filter=True,
              vad_parameters={"min_silence_duration_ms": 300}, beam_size=5, best_of=5,
              condition_on_previous_text=False, initial_prompt=prompt)
    if terms:
        kw["hotwords"] = ", ".join(terms)
    total = max(0.1, len(audio) / 16000)
    with _lock:
        for attempt in (0, 1):
            model, dev = _load(model_name, log, force_cpu=attempt == 1, on_progress=on_model)
            if on_model:
                on_model(1.0, "siap di " + ("GPU" if dev == "cuda" else "CPU"))
            try:
                try:
                    segs, info = model.transcribe(audio, **kw)
                except TypeError:  # versi lama tanpa hotwords
                    kw.pop("hotwords", None)
                    segs, info = model.transcribe(audio, **kw)
                total = float(getattr(info, "duration", None) or total)
                # perkiraan waktu proses (detik per detik audio) supaya angka tetap bergerak
                rate = 0.06 if dev == "cuda" else {"small": 0.25, "medium": 0.7, "large-v3-turbo": 0.55,
                                                   "large-v3": 1.4}.get(model_name, 0.7)
                real = {"p": 0.0}
                stop = threading.Event()
                t_start = time.time()

                def ticker():
                    while not stop.wait(1.0):
                        el = time.time() - t_start
                        est = min(0.9, el / max(3.0, total * rate))
                        if on_progress and est > real["p"]:
                            on_progress(est, f"mendengarkan audio... {el:.0f} dtk"
                                             f" ({'GPU' if dev == 'cuda' else 'CPU'})")
                threading.Thread(target=ticker, daemon=True).start()
                words = []
                try:
                    seg_iter = iter(segs)
                except Exception:
                    seg_iter = iter([])
                for s in seg_iter:
                    for w in s.words or []:
                        t = w.word.strip()
                        if t:
                            words.append({"s": round(float(w.start), 3), "e": round(float(w.end), 3), "t": t})
                    p = min(0.99, float(s.end) / total)
                    if p > real["p"]:
                        real["p"] = p
                        if on_progress:
                            on_progress(p, f"{float(s.end):.0f} / {total:.0f} detik audio"
                                           f" ({'GPU' if dev == 'cuda' else 'CPU'})")
                stop.set()
                if on_progress:
                    on_progress(1.0, f"{len(words)} kata · {time.time() - t_start:.0f} dtk "
                                     f"({'GPU' if dev == 'cuda' else 'CPU'})")
                return words, dev
            except SubError:
                raise
            except Exception as ex:  # noqa
                if dev == "cuda" and attempt == 0:
                    log(f"GPU bermasalah ({ex}), pindah ke CPU...")
                    GPU_NOTE["reason"] = str(ex)[:200]
                    continue
                raise
    return [], "cpu"


GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"


def groq_transcribe(src, key, model_name, lang, terms, on_progress=None, log=print):
    """Transkripsi online lewat Groq (Whisper large-v3 / turbo di server Groq). Sangat cepat, ada free tier."""
    import os
    import tempfile
    model = "whisper-large-v3" if model_name == "large-v3" else "whisper-large-v3-turbo"
    tmp = os.path.join(tempfile.gettempdir(), f"klipku_{os.getpid()}_{threading.get_ident()}.flac")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                    "-c:a", "flac", tmp], check=True)
    data = open(tmp, "rb").read()
    try:
        os.remove(tmp)
    except OSError:
        pass
    if len(data) > 24 * 1024 * 1024:
        raise SubError("Audio terlalu besar untuk Groq (maks 25 MB). Pendekkan clip.")
    prompt = "Obrolan santai bahasa Indonesia, banyak bahasa gaul."
    if terms:
        prompt += " Nama dan istilah: " + ", ".join(terms) + "."
    fields = [("model", model), ("response_format", "verbose_json"), ("timestamp_granularities[]", "word"),
              ("timestamp_granularities[]", "segment"), ("temperature", "0"), ("prompt", prompt[:800])]
    if lang != "auto":
        fields.append(("language", lang))
    boundary = "----klipku" + os.urandom(8).hex()
    body = bytearray()
    for k, v in fields:
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").encode("utf-8")
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.flac\"\r\n"
             f"Content-Type: audio/flac\r\n\r\n").encode("utf-8") + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(GROQ_URL, data=bytes(body), headers={
        "Authorization": f"Bearer {key}", "Content-Type": f"multipart/form-data; boundary={boundary}",
        "User-Agent": "KlipKu"})
    stop = threading.Event()
    t0 = time.time()

    def ticker():
        while not stop.wait(0.5):
            if on_progress:
                el = time.time() - t0
                on_progress(min(0.9, el / 8.0), f"diproses di server Groq ({model})... {el:.0f} dtk")
    threading.Thread(target=ticker, daemon=True).start()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            res = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as ex:
        detail = ex.read().decode("utf-8", "replace")[:400]
        hint = " (API key salah?)" if ex.code == 401 else " (batas gratis tercapai, coba lagi nanti)" if ex.code == 429 else ""
        raise SubError(f"Groq gagal (HTTP {ex.code}){hint}: {detail}")
    except Exception as ex:  # noqa
        raise SubError(f"Groq gagal: {ex}")
    finally:
        stop.set()
    words = []
    for w in res.get("words") or []:
        t = str(w.get("word", "")).strip()
        if t:
            words.append({"s": round(float(w["start"]), 3), "e": round(float(w["end"]), 3), "t": t})
    if not words:  # cadangan: bagi rata kata dari segmen
        for sg in res.get("segments") or []:
            toks = str(sg.get("text", "")).split()
            if not toks:
                continue
            a, b = float(sg["start"]), float(sg["end"])
            step = (b - a) / len(toks)
            words += [{"s": a + i * step, "e": a + (i + 1) * step, "t": t} for i, t in enumerate(toks)]
    if on_progress:
        on_progress(1.0, f"{len(words)} kata · {time.time() - t0:.1f} dtk (Groq {model})")
    return words


# ----------------------------------------------------------------------------- koreksi

def parse_terms(text):
    return [t.strip() for t in re.split(r"[,\n;]+", text or "") if len(t.strip()) >= 2]


def parse_rules(text):
    rules = []
    for line in (text or "").splitlines():
        m = re.match(r"\s*(.+?)\s*(?:=>|->|=)\s*(.+?)\s*$", line)
        if m and m.group(1) and m.group(2):
            rules.append((m.group(1), m.group(2)))
    return rules


def _bare(t):
    return re.sub(r"[^\w]", "", t.lower(), flags=re.UNICODE)


def _tail_punct(t):
    m = re.search(r"[^\w]+$", t, flags=re.UNICODE)
    return m.group(0) if m else ""


def phon(s):
    """Normalisasi bunyi kasar (Indonesia/Inggris) supaya 'plasmool' ~ 'prasmul'."""
    s = _bare(s)
    for a, b in (("ph", "f"), ("kh", "k"), ("sy", "s"), ("ch", "c"), ("oo", "u"), ("ou", "u"), ("ee", "i"),
                 ("ea", "i"), ("v", "f"), ("z", "s"), ("q", "k"), ("x", "ks"), ("c", "k"), ("y", "i"), ("l", "r"),
                 ("w", "u"), ("e", "a")):
        s = s.replace(a, b)
    return re.sub(r"(.)\1+", r"\1", s)


def _replace(words, i, n, new_text):
    first, last = words[i], words[i + n - 1]
    merged = {"s": first["s"], "e": last["e"], "t": new_text + _tail_punct(last["t"])}
    return words[:i] + [merged] + words[i + n:]


def apply_rules(words, rules):
    """Kamus ganti: 'salah = benar' (persis, tidak peduli huruf besar/kecil)."""
    fixes = 0
    for src, dst in rules:
        key = [_bare(x) for x in src.split()]
        n = len(key)
        if not n or not all(key):
            continue
        i = 0
        while i <= len(words) - n:
            if [_bare(w["t"]) for w in words[i:i + n]] == key:
                words = _replace(words, i, n, dst)
                fixes += 1
            i += 1
    return words, fixes


_FIRST = {"b": "p", "d": "t", "g": "k", "j": "c"}


def apply_terms(words, terms, threshold=0.8):
    """Ganti kata yang BUNYInya mirip 'kata khusus' (nama streamer, istilah)."""
    fixes = 0
    for term in terms:
        tw = term.split()
        target = phon(term)
        if len(target) < 4:
            continue
        sizes = sorted({len(tw), len(tw) + 1, max(1, len(tw) - 1)})
        i = 0
        while i < len(words):
            best = None  # (ratio, -n, n)
            for n in sizes:
                if i + n > len(words):
                    continue
                window = words[i:i + n]
                raw = " ".join(w["t"] for w in window)
                if _bare(raw.replace(" ", "")) == _bare(term.replace(" ", "")):
                    r = 1.01
                else:
                    cand = phon("".join(w["t"] for w in window))
                    if not cand or _FIRST.get(cand[0], cand[0]) != _FIRST.get(target[0], target[0]) \
                            or len(cand) < 4 or abs(len(cand) - len(target)) > 3:
                        continue
                    r = difflib.SequenceMatcher(None, cand, target).ratio()
                if r >= threshold and (best is None or (r, -n) > best[:2]):
                    best = (r, -n, n)
            if best:
                n = best[2]
                raw = " ".join(w["t"] for w in words[i:i + n])
                if raw.rstrip(".,!?") != term:
                    words = _replace(words, i, n, term)
                    fixes += best[0] <= 1.0
            i += 1
    return words, fixes


def _http_json(url, body, headers, timeout=90):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers=dict({"Content-Type": "application/json"}, **headers))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as ex:
        detail = ex.read().decode("utf-8", "replace")[:500]
        raise SubError(f"Koreksi AI gagal (HTTP {ex.code}): {detail}")
    except Exception as ex:  # noqa
        raise SubError(f"Koreksi AI gagal: {ex}")


def _parse_list(text, n):
    m = re.search(r"\[.*\]", text or "", flags=re.S)
    if not m:
        raise SubError("Koreksi AI: jawaban tidak berisi daftar.")
    arr = json.loads(m.group(0))
    if not isinstance(arr, list) or len(arr) != n:
        raise SubError(f"Koreksi AI: jumlah baris tidak cocok ({len(arr) if isinstance(arr, list) else '?'} vs {n}).")
    return [str(x) for x in arr]


def ai_correct(lines, provider, key, model, context, audio_path=None):
    n = len(lines)
    prompt = (
        "Kamu memperbaiki subtitle otomatis dari potongan livestream YouTube.\n"
        f"Judul video: {context.get('title')}\nChannel: {context.get('channel')}\n"
        f"Nama/istilah penting: {', '.join(context.get('terms') or []) or '-'}\n"
        "Bahasanya obrolan santai bahasa Indonesia (slang/gaul tetap dipertahankan).\n"
        + ("Dengarkan AUDIO terlampir. " if audio_path else "")
        + f"Di bawah ini {n} baris subtitle berurutan (JSON). Perbaiki HANYA kata yang salah dengar "
          "(nama orang, tempat, kampus, merek, istilah game, slang). Jangan terjemahkan, jangan parafrase, "
          "jangan menambah atau menghapus baris, panjang tiap baris kira-kira sama.\n"
          f"Jawab HANYA dengan JSON array berisi tepat {n} string.\n\n" + json.dumps(lines, ensure_ascii=False))
    if provider == "gemini":
        parts = []
        if audio_path:
            parts.append({"inline_data": {"mime_type": "audio/mp3",
                                          "data": base64.b64encode(open(audio_path, "rb").read()).decode()}})
        parts.append({"text": prompt})
        mdl = model or "gemini-flash-latest"
        res = _http_json(f"https://generativelanguage.googleapis.com/v1beta/models/{mdl}:generateContent",
                         {"contents": [{"parts": parts}],
                          "generationConfig": {"temperature": 0, "responseMimeType": "application/json"}},
                         {"x-goog-api-key": key})
        try:
            text = res["candidates"][0]["content"]["parts"][0]["text"]
        except Exception:
            raise SubError("Koreksi AI (Gemini): jawaban kosong. " + json.dumps(res)[:300])
    elif provider == "claude":
        res = _http_json("https://api.anthropic.com/v1/messages",
                         {"model": model or "claude-haiku-5-5", "max_tokens": 4096,
                          "messages": [{"role": "user", "content": prompt}]},
                         {"x-api-key": key, "anthropic-version": "2023-06-01"})
        try:
            text = "".join(b.get("text", "") for b in res["content"])
        except Exception:
            raise SubError("Koreksi AI (Claude): jawaban kosong. " + json.dumps(res)[:300])
    else:
        return lines
    return _parse_list(text, n)


def make_mp3(src, dest):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                    "-b:a", "48k", str(dest)], check=True)
    return dest


# ----------------------------------------------------------------------------- potongan subtitle

def make_chunks(words, per_line, max_chars):
    chunks, cur = [], []
    for w in words:
        if cur and (len(cur) >= per_line or sum(len(x["t"]) + 1 for x in cur) + len(w["t"]) > max_chars
                    or w["s"] - cur[-1]["e"] > 0.7 or cur[-1]["t"][-1:] in ".?!"):
            chunks.append(cur)
            cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    return [{"start": c[0]["s"], "end": c[-1]["e"], "text": " ".join(x["t"] for x in c), "words": c} for c in chunks]


def apply_edits(chunks, edited):
    out = []
    for i, e in enumerate(edited):
        text = re.sub(r"\s+", " ", str(e.get("text", ""))).strip()
        if not text:
            continue
        start, end = float(e["start"]), float(e["end"])
        orig = chunks[i] if i < len(chunks) else None
        toks = text.split(" ")
        if orig and [_bare(w["t"]) for w in orig["words"]] == [_bare(t) for t in toks]:
            words = [dict(w, t=t) for w, t in zip(orig["words"], toks)]
        elif orig and len(orig["words"]) == len(toks):
            words = [dict(w, t=t) for w, t in zip(orig["words"], toks)]
        else:
            step = (end - start) / len(toks)
            words = [{"s": start + k * step, "e": start + (k + 1) * step, "t": t} for k, t in enumerate(toks)]
        out.append({"start": start, "end": end, "text": text, "words": words})
    return out


# ----------------------------------------------------------------------------- ASS

def ass_time(t):
    cs = int(round(max(0.0, t) * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def clean(text):
    return re.sub(r"[{}\\]", "", str(text)).replace("\n", " ").strip()


HIGHLIGHT = {"kuning": "&H00FFFF&", "hijau": "&H00FF66&", "merah": "&H3A3AFF&", "biru": "&HFFC040&",
             "pink": "&HC86BFF&", "oranye": "&H0090FF&", "putih": "&HFFFFFF&"}
TEXTCOL = {"putih": "&HFFFFFF&", "kuning": "&H00FFFF&", "hitam": "&H000000&", "merah": "&H3A3AFF&",
           "biru": "&HFFC040&", "hijau": "&H00FF66&"}


def _alpha(op):
    return f"&H{max(0, min(255, int(round((1 - op) * 255)))):02X}&"


def _header(W, H, styles):
    return ["[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}", "WrapStyle: 0",
            "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
            "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
            "MarginL, MarginR, MarginV, Encoding"] + styles + [
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]


def wm_corner(pos, W, H):
    m = round(W * 0.04)
    top, bot = round(H * 0.06), round(H * 0.12 if H > W else H * 0.07)
    return {"kiri-atas": (7, m, top), "kanan-atas": (9, W - m, top), "kiri-bawah": (1, m, H - bot),
            "kanan-bawah": (3, W - m, H - bot), "atas-tengah": (8, W / 2, top), "bawah-tengah": (2, W / 2, H - bot),
            "tengah": (5, W / 2, H / 2)}.get(pos, (9, W - m, top))


def watermark_events(o, W, H, dur, font):
    text = clean(o.get("wm_text", ""))
    if not text:
        return []
    op = max(0.03, min(1.0, float(o.get("wm_opacity", 70)) / 100))
    size = int(o.get("wm_size", 40))
    col = TEXTCOL.get(o.get("wm_color", "putih"), "&HFFFFFF&")
    a1 = _alpha(op)
    a3 = _alpha(op * 0.7)
    bord = max(1, round(size * 0.05))
    base = f"\\1c{col}\\1a{a1}\\3c&H000000&\\3a{a3}\\4a&HFF&\\bord{bord}\\shad0"
    mode = o.get("wm_mode", "pojok")
    ang = float(o.get("wm_angle", 30))
    ev = []
    T0, T1 = ass_time(0), ass_time(dur)
    if mode == "pojok":
        an, x, y = wm_corner(o.get("wm_pos", "kanan-atas"), W, H)
        ev.append(f"Dialogue: 3,{T0},{T1},WM,,0,0,0,,{{\\an{an}\\pos({x:.0f},{y:.0f}){base}}}{text}")
    elif mode in ("diagonal", "belakang"):
        ev.append(f"Dialogue: 3,{T0},{T1},WM,,0,0,0,,{{\\an5\\pos({W / 2:.0f},{H / 2:.0f})\\frz{ang:.0f}{base}}}{text}")
    elif mode == "pola":
        tw = len(text) * size * 0.62 * font["k"] / 1.4
        sx, sy = tw + size * 2.2, size * 4.2
        rows = int(H / sy) + 3
        cols = int(W / sx) + 3
        count = 0
        for r in range(-1, rows):
            for c in range(-1, cols):
                x = c * sx + (sx / 2 if r % 2 else 0)
                y = r * sy
                ev.append(f"Dialogue: 3,{T0},{T1},WM,,0,0,0,,{{\\an5\\pos({x:.0f},{y:.0f})\\frz{ang:.0f}{base}}}{text}")
                count += 1
                if count >= 120:
                    break
    elif mode == "pindah":
        every = max(2.0, float(o.get("wm_every", 5)))
        cycle = ["kanan-atas", "kanan-bawah", "kiri-bawah", "kiri-atas"]
        t, i = 0.0, 0
        while t < dur:
            an, x, y = wm_corner(cycle[i % 4], W, H)
            ev.append(f"Dialogue: 3,{ass_time(t)},{ass_time(min(dur, t + every))},WM,,0,0,0,,"
                      f"{{\\an{an}\\pos({x:.0f},{y:.0f})\\fad(250,250){base}}}{text}")
            t += every
            i += 1
    return ev


def build_ass(chunks, dur, W, H, geom, o, fonts, hook, credit, include_wm=True, hook_span=None, flash_at=None):
    """fonts: dict peran -> info font (registry)."""
    sf, wf = fonts["sub"], fonts["wm"]
    size = int(o.get("sub_size", 80))
    k = sf["k"]
    fs = lambda px: max(8, round(px * k))  # noqa
    outline = max(2, round(size * float(o.get("sub_outline", 9)) / 100))
    hl = HIGHLIGHT.get(o.get("sub_color", "kuning"), HIGHLIGHT["kuning"])
    tc = TEXTCOL.get(o.get("sub_text", "putih"), "&HFFFFFF&")
    tc_ass = "&H00" + tc[2:-1]
    hook_size = int(o.get("hook_size", 58))
    hf = fonts.get("hook") or sf
    hfs = max(8, round(hook_size * hf["k"]))
    hm = round(W * 0.09)
    box = o.get("hook_box", "putih")
    if box == "hitam":
        hook_style = (f"Style: Hook,{hf['full']},{hfs},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,"
                      f"{round(hook_size * 0.3)},0,5,{hm},{hm},0,1")
    elif box == "polos":
        hc = "&H00" + TEXTCOL.get(o.get("hook_color", "putih"), "&HFFFFFF&")[2:-1]
        hol = max(0, round(hook_size * float(o.get("hook_outline", 10)) / 100))
        hook_style = (f"Style: Hook,{hf['full']},{hfs},{hc},&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,"
                      f"{hol},{max(0, hol // 2)},5,{hm},{hm},0,1")
    else:
        hook_style = (f"Style: Hook,{hf['full']},{hfs},&H00000000,&H000000FF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,"
                      f"{round(hook_size * 0.3)},0,5,{hm},{hm},0,1")
    styles = [
        f"Style: Sub,{sf['full']},{fs(size)},{tc_ass},&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,"
        f"{outline},{max(1, outline // 2)},5,40,40,0,1",
        hook_style,
        f"Style: Small,{sf['full']},{fs(round(34 * W / 1080 if W < H else 30))},&H00FFFFFF,&H000000FF,&H00000000,"
        f"&H80000000,0,0,0,0,100,100,0,0,1,3,0,5,40,40,0,1",
        f"Style: WM,{wf['full']},{max(8, round(int(o.get('wm_size', 40)) * wf['k']))},&H00FFFFFF,&H000000FF,"
        f"&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,5,10,10,0,1",
    ]
    L = _header(W, H, styles)
    up = (lambda s: s.upper()) if o.get("uppercase", True) else (lambda s: s)
    if credit:
        L.append(f"Dialogue: 1,{ass_time(0)},{ass_time(dur)},Small,,0,0,0,,"
                 f"{{\\pos({W / 2:.0f},{geom['credit_y']:.0f})\\alpha&H40&}}{clean(credit)}")
    if include_wm:
        L += watermark_events(o, W, H, dur, wf)
    if hook:
        if hook_span:
            h0, h1 = hook_span
        else:
            hs = float(o.get("hook_secs") or 0)
            h0, h1 = 0.0, (dur if hs <= 0 else min(dur, hs))
        L.append(f"Dialogue: 2,{ass_time(h0)},{ass_time(h1)},Hook,,0,0,0,,"
                 f"{{\\pos({W / 2:.0f},{geom['hook_y']:.0f})\\fad(120,200)}}{up(clean(hook))}")
    if flash_at is not None:  # kilat putih saat video "diulang"
        L.append(f"Dialogue: 6,{ass_time(flash_at)},{ass_time(flash_at + 0.35)},Small,,0,0,0,,"
                 f"{{\\an7\\pos(0,0)\\bord0\\shad0\\1c&HFFFFFF&\\1a&H00&\\fad(0,300)\\p1}}"
                 f"m 0 0 l {W} 0 {W} {H} 0 {H}{{\\p0}}")
    style = o.get("sub_style", "highlight")
    sub_y = geom["sub_y"]
    for ci, ch in enumerate(chunks):
        words = ch["words"]
        texts = [up(clean(w["t"])) for w in words]
        c_end = min(ch["end"] + 0.3, dur)
        if ci + 1 < len(chunks):
            c_end = min(c_end, chunks[ci + 1]["start"])
        if style == "simple":
            if c_end > ch["start"]:
                L.append(f"Dialogue: 0,{ass_time(ch['start'])},{ass_time(c_end)},Sub,,0,0,0,,"
                         f"{{\\pos({W / 2:.0f},{sub_y:.0f})\\fad(60,0)}}" + " ".join(texts))
            continue
        for j, w in enumerate(words):
            a = w["s"]
            z = words[j + 1]["s"] if j + 1 < len(words) else c_end
            if z <= a:
                continue
            shown = texts[: j + 1] if style == "muncul" else texts
            parts = []
            for kk, t in enumerate(shown):
                if kk == j:
                    if style == "kotak":
                        parts.append(f"{{\\3c{hl}\\bord{round(outline * 2.2)}\\c{tc}}}{t}{{\\3c&H000000&\\bord{outline}}}")
                    else:
                        parts.append(f"{{\\c{hl}\\fscx114\\fscy114}}{t}{{\\c{tc}\\fscx100\\fscy100}}")
                else:
                    parts.append(t)
            pop = "\\fscx92\\fscy92\\t(0,90,\\fscx100\\fscy100)" if j == 0 else ""
            L.append(f"Dialogue: 0,{ass_time(a)},{ass_time(z)},Sub,,0,0,0,,"
                     f"{{\\pos({W / 2:.0f},{sub_y:.0f}){pop}}}" + " ".join(parts))
    return "\n".join(L) + "\n"


def build_wm_only(o, dur, W, H, font):
    styles = [f"Style: WM,{font['full']},{max(8, round(int(o.get('wm_size', 40)) * font['k']))},&H00FFFFFF,"
              f"&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,5,10,10,0,1"]
    return "\n".join(_header(W, H, styles) + watermark_events(o, W, H, dur, font)) + "\n"
