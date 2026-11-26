"""
AI Kamera — reframing otomatis seperti editan TikTok.

1. Deteksi wajah (YuNet; cadangan: Haar cascade) di 8 frame/detik.
2. Lacak tiap wajah jadi "track" (orang yang sama dari waktu ke waktu).
3. Nilai aktivitas tiap orang: gerakan mulut (bicara) + gerakan kepala (ketawa/heboh),
   diperkuat saat ada suara/ucapan.
4. "Sutradara": tetap di karakter utama, pindah ke orang lain kalau dia jelas lebih aktif
   (reaksi), lalu balik lagi ke karakter utama. Kalau dua orang aktif & muat satu frame -> group shot.
5. Kamera: pegas teredam (spring) supaya halus mengikuti goyangan kepala (stabilizer),
   cepat saat pindah target (whip pan) atau potong langsung.
"""
import math
import subprocess
import threading
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parent
MODELS = APP / "models"
YUNET = MODELS / "face_detection_yunet_2023mar.onnx"
YUNET_URLS = [
    "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
    "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
]
ANALYSIS_FPS = 8.0


def _np():
    import numpy as np
    return np


def _cv():
    import cv2
    return cv2


# ----------------------------------------------------------------------------- detector

def ensure_yunet(log=print):
    if YUNET.exists() and YUNET.stat().st_size > 100_000:
        return True
    MODELS.mkdir(exist_ok=True)
    for url in YUNET_URLS:
        try:
            log("download model deteksi wajah (sekali saja, ±230 KB)...")
            req = urllib.request.Request(url, headers={"User-Agent": "KlipKu"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            if len(data) > 100_000:
                YUNET.write_bytes(data)
                return True
        except Exception as ex:  # noqa
            log(f"gagal dari {url.split('/')[2]}: {ex}")
    return False


class FaceDetector:
    def __init__(self, w, h, log=print):
        cv2 = _cv()
        self.kind = "haar"
        self.w, self.h = w, h
        if ensure_yunet(log):
            try:
                self.yn = cv2.FaceDetectorYN.create(str(YUNET), "", (w, h), 0.6, 0.3, 50)
                self.yn.setInputSize((w, h))
                self.kind = "yunet"
            except Exception as ex:  # noqa
                log(f"YuNet tidak bisa dipakai ({ex}), pakai detektor cadangan.")
        if self.kind == "haar":
            base = cv2.data.haarcascades
            self.front = cv2.CascadeClassifier(base + "haarcascade_frontalface_default.xml")
            self.prof = cv2.CascadeClassifier(base + "haarcascade_profileface.xml")

    def detect(self, img, gray):
        """-> list of (x, y, w, h, score) dalam piksel gambar analisis."""
        cv2 = _cv()
        out = []
        if self.kind == "yunet":
            try:
                _, faces = self.yn.detect(img)
            except Exception:
                faces = None
            if faces is not None:
                for f in faces:
                    x, y, w, h = [float(v) for v in f[:4]]
                    out.append((x, y, w, h, float(f[-1])))
            return out
        ms = max(20, self.w // 40)
        boxes = []
        for (x, y, w, h) in self.front.detectMultiScale(gray, 1.1, 5, minSize=(ms, ms)):
            boxes.append((x, y, w, h, 0.8))
        for flip in (False, True):
            g = cv2.flip(gray, 1) if flip else gray
            for (x, y, w, h) in self.prof.detectMultiScale(g, 1.1, 6, minSize=(ms, ms)):
                if flip:
                    x = self.w - x - w
                boxes.append((x, y, w, h, 0.6))
        # NMS sederhana
        boxes.sort(key=lambda b: -b[2] * b[3])
        for b in boxes:
            if all(_iou(b, o) < 0.3 for o in out):
                out.append(tuple(float(v) for v in b))
        return out


def _iou(a, b):
    ax0, ay0, ax1, ay1 = a[0], a[1], a[0] + a[2], a[1] + a[3]
    bx0, by0, bx1, by1 = b[0], b[1], b[0] + b[2], b[1] + b[3]
    iw, ih = max(0, min(ax1, bx1) - max(ax0, bx0)), max(0, min(ay1, by1) - max(ay0, by0))
    inter = iw * ih
    return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-6)


# ----------------------------------------------------------------------------- analysis

def analyze(src, sw, sh, log=print, on_progress=None, duration=0.0):
    """Deteksi + ukur gerak mulut & kepala. -> (frames, detector_kind)
    frames: list of (t, [ {cx,cy,w,h,m} ... ]) dengan koordinat dinormalisasi 0..1"""
    np, cv2 = _np(), _cv()
    aw = 640 if sw >= sh else 360
    ah = int(round(sh * aw / sw / 2)) * 2
    det = FaceDetector(aw, ah, log)
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(src), "-vf", f"fps={ANALYSIS_FPS},scale={aw}:{ah}",
                             "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL)
    size = aw * ah * 3
    frames, prev, i = [], None, 0
    total = max(1, int(duration * ANALYSIS_FPS))
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        img = np.frombuffer(buf, np.uint8).reshape(ah, aw, 3)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        items = []
        for (x, y, w, h, s) in det.detect(img, gray):
            if w < 8 or h < 8:
                continue
            m = 0.0
            if prev is not None:
                def region(fy0, fy1, fx0=0.2, fx1=0.8):
                    x0, x1 = int(max(0, x + fx0 * w)), int(min(aw, x + fx1 * w))
                    y0, y1 = int(max(0, y + fy0 * h)), int(min(ah, y + fy1 * h))
                    if x1 - x0 < 3 or y1 - y0 < 3:
                        return 0.0
                    a = gray[y0:y1, x0:x1].astype(np.int16)
                    b = prev[y0:y1, x0:x1].astype(np.int16)
                    return float(np.mean(np.abs(a - b)))
                mouth = region(0.62, 1.0, 0.22, 0.78)
                upper = region(0.15, 0.5)
                m = max(0.0, mouth - 0.8 * upper)  # gerak mulut dikurangi gerak kepala/kamera
            items.append({"cx": (x + w / 2) / aw, "cy": (y + h / 2) / ah, "w": w / aw, "h": h / ah, "m": m})
        frames.append((i / ANALYSIS_FPS, items))
        prev = gray
        i += 1
        if on_progress and i % 8 == 0:
            on_progress(min(1.0, i / total))
    proc.wait()
    return frames, det.kind


def build_tracks(frames, aspect):
    """Hubungkan deteksi antar-frame jadi track per orang."""
    tracks = []
    for t, items in frames:
        cands = []
        for ti, tr in enumerate(tracks):
            if t - tr["last"] > 1.0:
                continue
            p = tr["pts"][-1]
            for ii, it in enumerate(items):
                d = math.hypot(it["cx"] - p["cx"], (it["cy"] - p["cy"]) / aspect)
                ratio = it["w"] / max(p["w"], 1e-6)
                if d < max(p["w"], it["w"]) * 0.9 and 0.5 < ratio < 2.0:
                    cands.append((d, ti, ii))
        cands.sort()
        used_t, used_i = set(), set()
        for d, ti, ii in cands:
            if ti in used_t or ii in used_i:
                continue
            used_t.add(ti)
            used_i.add(ii)
            tracks[ti]["pts"].append(dict(items[ii], t=t))
            tracks[ti]["last"] = t
        for ii, it in enumerate(items):
            if ii not in used_i:
                tracks.append({"pts": [dict(it, t=t)], "last": t})
    tracks = [tr for tr in tracks if len(tr["pts"]) >= 4 and tr["pts"][-1]["t"] - tr["pts"][0]["t"] >= 0.5]
    for k, tr in enumerate(tracks):
        tr["id"] = k
    return tracks


def _smooth(vals, win):
    if win <= 1 or len(vals) < 3:
        return list(vals)
    h = win // 2
    out = []
    for i in range(len(vals)):
        seg = vals[max(0, i - h): i + h + 1]
        out.append(sum(seg) / len(seg))
    return out


def track_series(tracks, n, dt):
    """Ubah tiap track ke deret waktu rata (grid analisis), isi celah pendek, haluskan posisi."""
    series = {}
    for tr in tracks:
        cx, cy, w, m, vis = [None] * n, [None] * n, [None] * n, [0.0] * n, [False] * n
        for p in tr["pts"]:
            k = int(round(p["t"] / dt))
            if 0 <= k < n:
                cx[k], cy[k], w[k], m[k], vis[k] = p["cx"], p["cy"], p["w"], p["m"], True
        idx = [k for k in range(n) if vis[k]]
        for a, b in zip(idx, idx[1:]):  # isi celah <= 0.6 detik
            if 1 < b - a <= int(0.6 / dt) + 1:
                for k in range(a + 1, b):
                    f = (k - a) / (b - a)
                    cx[k] = cx[a] + (cx[b] - cx[a]) * f
                    cy[k] = cy[a] + (cy[b] - cy[a]) * f
                    w[k] = w[a] + (w[b] - w[a]) * f
                    vis[k] = True
        first, last = idx[0], idx[-1]
        for k in range(n):  # tahan posisi di luar rentang (hanya untuk kamera, bukan visibilitas)
            if cx[k] is None:
                src = first if k < first else last if k > last else max(j for j in idx if j <= k)
                cx[k], cy[k], w[k] = cx[src], cy[src], w[src]
        win = max(3, int(0.5 / dt) | 1)
        sx, sy = _smooth(cx, win), _smooth(cy, win)
        # gerak kepala (untuk deteksi ketawa/heboh)
        motion = [0.0] + [abs(cx[k] - cx[k - 1]) + abs(cy[k] - cy[k - 1]) if vis[k] and vis[k - 1] else 0.0
                          for k in range(1, n)]
        motion = [mv / max(w[k], 1e-3) for k, mv in enumerate(motion)]
        series[tr["id"]] = {"cx": sx, "cy": sy, "w": w, "m": m, "vis": vis, "motion": motion}
    return series


# ----------------------------------------------------------------------------- director

def direct(series, n, dt, speech, crop_w_norm, style="halus"):
    """-> list target per langkah: (cx, cy, switch_flag)"""
    if not series:
        return None
    ids = list(series)
    # karakter utama: paling besar, paling sering terlihat, paling dekat tengah
    def main_score(i):
        s = series[i]
        tot = 0.0
        for k in range(n):
            if s["vis"][k]:
                tot += s["w"][k] * (1.2 - abs(s["cx"][k] - 0.5))
        return tot
    main = max(ids, key=main_score)

    win = max(3, int(0.6 / dt) | 1)
    act = {}
    for i in ids:
        s = series[i]
        mv = [v for k, v in enumerate(s["m"]) if s["vis"][k]]
        base = sorted(mv)[int(len(mv) * 0.3)] if mv else 0.0
        talk = _smooth([(s["m"][k] / (base + 0.6)) if s["vis"][k] else 0.0 for k in range(n)], win)
        mot = _smooth([min(3.0, v * 6) for v in s["motion"]], win)
        act[i] = [(talk[k] * (0.45 + 0.55 * speech[k]) + 0.5 * mot[k]) if s["vis"][k] else -1.0 for k in range(n)]

    fast = style == "dinamis"
    min_hold = (0.8 if fast else 1.3) / dt
    max_react = (2.2 if fast else 3.2) / dt
    need = (0.25 if fast else 0.4) / dt
    margin = 1.3 if fast else 1.45

    def visible(i, k):
        return series[i]["vis"][k]

    cur = main if visible(main, 0) else max(ids, key=lambda i: act[i][0])
    held, chal, chal_t, lost = 0, None, 0, 0
    out = []
    for k in range(n):
        switched = False
        scores = {i: act[i][k] + (0.35 if i == main else 0.0) for i in ids if visible(i, k)}
        if cur not in scores:
            lost += 1
            if lost > 0.5 / dt and scores:
                cur = main if main in scores else max(scores, key=scores.get)
                switched, held, lost = True, 0, 0
        else:
            lost = 0
            best = max(scores, key=scores.get)
            if best != cur and scores[best] > scores[cur] * margin + 0.25:
                if chal == best:
                    chal_t += 1
                else:
                    chal, chal_t = best, 1
                if chal_t >= need and held >= min_hold:
                    cur, switched, held, chal, chal_t = best, True, 0, None, 0
            else:
                chal, chal_t = None, 0
            if not switched and cur != main and main in scores and held > max_react \
                    and scores[main] >= 0.5 * scores[cur]:
                cur, switched, held = main, True, 0
        held += 1
        s = series[cur]
        tx, ty = s["cx"][k], s["cy"][k]
        # group shot: dua orang aktif & muat dalam satu frame
        if cur in scores:
            others = [i for i in scores if i != cur and scores[i] >= 0.7 * scores[cur] and scores[cur] > 0.6]
            for o in others:
                so = series[o]
                left = min(s["cx"][k] - s["w"][k] / 2, so["cx"][k] - so["w"][k] / 2)
                right = max(s["cx"][k] + s["w"][k] / 2, so["cx"][k] + so["w"][k] / 2)
                if right - left <= crop_w_norm * 0.85:
                    tx, ty = (left + right) / 2, (s["cy"][k] + so["cy"][k]) / 2
                    break
        out.append((tx, ty, switched))
    return out


def camera_path(targets, dt, fps, nframes, transition="geser", style="halus"):
    """Simulasi pegas teredam -> posisi kamera (cx, cy) per frame output."""
    om_follow = 7.0 if style == "dinamis" else 4.5
    om_fast = 16.0
    px, py = targets[0][0], targets[0][1]
    vx = vy = 0.0
    fast_until = -1.0
    path = []
    h = 1.0 / fps
    n = len(targets)
    for f in range(nframes):
        t = f * h
        k = min(n - 1, int(t / dt))
        k2 = min(n - 1, k + 1)
        fr = (t / dt) - k
        tx = targets[k][0] + (targets[k2][0] - targets[k][0]) * fr if not targets[k2][2] else targets[k][0]
        ty = targets[k][1] + (targets[k2][1] - targets[k][1]) * fr if not targets[k2][2] else targets[k][1]
        if targets[k][2] and (f == 0 or int((t - h) / dt) != k):
            if transition == "potong":
                px, py, vx, vy = tx, ty, 0.0, 0.0
            else:
                fast_until = t + 0.5
        om = om_fast if t < fast_until else om_follow
        for _ in range(2):  # 2 sub-langkah supaya stabil
            sh = h / 2
            ax = om * om * (tx - px) - 2 * om * vx
            ay = om * om * (ty - py) - 2 * om * vy
            vx += ax * sh
            vy += ay * sh
            px += vx * sh
            py += vy * sh
        path.append((px, py))
    return path


# ----------------------------------------------------------------------------- render

def crop_rect(cx, cy, sw, sh, W, H, zoom):
    crop_h = sh / max(1.0, zoom)
    crop_w = crop_h * W / H
    if crop_w > sw:
        crop_w = sw
        crop_h = crop_w * H / W
    x = cx * sw - crop_w / 2
    y = cy * sh - crop_h * 0.40  # wajah di ~40% dari atas
    x = min(max(0.0, x), sw - crop_w)
    y = min(max(0.0, y), sh - crop_h)
    return x, y, crop_w, crop_h


def plan(src, sw, sh, fps_out, dur, W, H, zoom, speech_fn, style, transition, log=print, on_progress=None):
    """Analisis + sutradara + jalur kamera. -> (list (x,y,cw,ch) per frame, info dict)"""
    frames, kind = analyze(src, sw, sh, log, on_progress, dur)
    n = len(frames)
    nframes = max(1, int(round(dur * fps_out)))
    info = {"detector": kind, "faces": 0, "switches": 0}
    if n == 0:
        return [crop_rect(0.5, 0.5, sw, sh, W, H, zoom)] * nframes, info
    dt = 1.0 / ANALYSIS_FPS
    tracks = build_tracks(frames, sw / sh)
    info["faces"] = len(tracks)
    if not tracks:
        return [crop_rect(0.5, 0.5, sw, sh, W, H, zoom)] * nframes, info
    series = track_series(tracks, n, dt)
    speech = [speech_fn(k * dt) for k in range(n)]
    _, _, cw, _ = crop_rect(0.5, 0.5, sw, sh, W, H, zoom)
    targets = direct(series, n, dt, speech, cw / sw, style)
    info["switches"] = sum(1 for t in targets if t[2])
    path = camera_path(targets, dt, fps_out, nframes, transition, style)
    return [crop_rect(px, py, sw, sh, W, H, zoom) for px, py in path], info


def render_frames(src, out_cmd, rect_at, segments, sw, sh, W, H, fps_out, on_progress=None, cwd=None,
                  total_frames=None):
    """Decode sumber per segmen -> crop subpiksel (warpAffine) -> kirim ke encoder lewat pipe.
    segments: [{"kind": "play", "start", "dur", "capture"}, {"kind": "rewind", ...}]"""
    np, cv2 = _np(), _cv()
    enc = subprocess.Popen(out_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                           cwd=cwd)
    err_buf = []
    t_err = threading.Thread(target=lambda: err_buf.append(enc.stderr.read()), daemon=True)
    t_err.start()
    size = sw * sh * 3
    total = total_frames or 1
    done = 0
    captured = []

    def warp(img, t):
        x, y, cw, ch = rect_at(t)
        s = W / cw
        M = np.array([[s, 0, -x * s], [0, s, -y * s]], dtype=np.float32)
        return cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_CUBIC if s > 1 else cv2.INTER_AREA,
                              borderMode=cv2.BORDER_REPLICATE)

    def emit(frame):
        nonlocal done
        enc.stdin.write(frame.tobytes())
        done += 1
        if on_progress and done % 10 == 0:
            on_progress(min(0.99, done / max(1, total)))

    try:
        for sg in segments:
            if sg["kind"] == "rewind":
                for fr in reversed(captured):
                    emit(fr)
                captured = []
                continue
            dec = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{sg['start']:.3f}", "-t", f"{sg['dur']:.3f}",
                                    "-i", str(src), "-vf", f"fps={fps_out}", "-f", "rawvideo", "-pix_fmt", "bgr24",
                                    "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            i = 0
            try:
                while True:
                    buf = dec.stdout.read(size)
                    if len(buf) < size:
                        break
                    img = np.frombuffer(buf, np.uint8).reshape(sh, sw, 3)
                    frame = warp(img, sg["start"] + i / fps_out)
                    emit(frame)
                    if sg.get("capture") and i % 4 == 0:
                        captured.append(frame)
                    i += 1
            finally:
                dec.stdout.close()
                dec.wait()
    except (BrokenPipeError, OSError):
        pass
    finally:
        try:
            enc.stdin.close()
        except Exception:
            pass
        enc.wait()
        t_err.join(5)
    if enc.returncode != 0:
        msg = (err_buf[0] if err_buf else b"").decode("utf-8", "replace")
        raise RuntimeError("encode gagal: " + msg[-1200:])
    return done


def detect_on_image(jpg_path):
    """Untuk preview: deteksi wajah di satu gambar -> list kotak dinormalisasi."""
    cv2 = _cv()
    img = cv2.imread(str(jpg_path))
    if img is None:
        return [], "none"
    h, w = img.shape[:2]
    aw = 640 if w >= h else 360
    ah = int(round(h * aw / w / 2)) * 2
    small = cv2.resize(img, (aw, ah))
    det = FaceDetector(aw, ah, log=lambda *_: None)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    boxes = [{"x": x / aw, "y": y / ah, "w": bw / aw, "h": bh / ah} for (x, y, bw, bh, s) in det.detect(small, gray)]
    return boxes, det.kind
