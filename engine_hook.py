"""Judul hook (template + posisi bebas), banner program, progress bar, dan teks penutup -> event ASS.

Semua ukuran dalam piksel kanvas output (misal 1080x1920). Rumus tata letak di sini SAMA PERSIS dengan
fungsi hookLayout() di web/index.html, supaya preview = hasil render.

Kalibrasi libass (dites): ukuran em = size * 1.015, garis dasar (baseline) = y_atas + asc * em,
dengan asc = usWinAscent / unitsPerEm.
"""
import re

import engine_fonts as EF

TEMPLATES = ("kutipan", "kotak", "label", "strip", "polos")
# bentuk tanda kutip blok (seperti contoh): koordinat 0..1 untuk satu tanda
QUOTE_MARK = [(0.185, 0.0), (0.667, 0.0), (0.481, 0.342), (1.0, 0.342), (1.0, 1.0), (0.0, 1.0), (0.0, 0.395)]


# ----------------------------------------------------------------------------- util

def hex_rgb(h, default=(255, 255, 255)):
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(h or "").strip())
    if not m:
        return default
    v = m.group(1)
    return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)


def ass_col(h, default="#ffffff"):
    r, g, b = hex_rgb(h, hex_rgb(default))
    return f"&H{b:02X}{g:02X}{r:02X}&"


def ass_alpha(op):
    return f"&H{max(0, min(255, int(round((1 - max(0.0, min(1.0, op))) * 255)))):02X}&"


def shade(h, f):
    """Gelapkan (f<1) warna hex."""
    r, g, b = hex_rgb(h)
    return "#%02x%02x%02x" % (int(r * f), int(g * f), int(b * f))


def light(h):
    r, g, b = hex_rgb(h)
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150


def hl_color(cfg):
    """Warna kata yang disorot: di kotak terang, aksen digelapkan supaya tetap terbaca."""
    if cfg["tpl"] in ("kutipan", "kotak") and light(cfg["bg"]) and light(cfg["acc"]):
        return shade(cfg["acc"], 0.62)
    return cfg["acc"]


def contrast(h):
    r, g, b = hex_rgb(h)
    return "#111111" if (0.299 * r + 0.587 * g + 0.114 * b) > 150 else "#ffffff"


def ass_time(t):
    cs = int(round(max(0.0, t) * 100))
    hh, cs = divmod(cs, 360000)
    mm, cs = divmod(cs, 6000)
    ss, cs = divmod(cs, 100)
    return f"{hh}:{mm:02d}:{ss:02d}.{cs:02d}"


def clean(text):
    return re.sub(r"[{}\\]", "", str(text)).replace("\n", " ").strip()


def legacy(o):
    """Pengaturan hook versi lama (hook_box) -> template baru."""
    o = dict(o)
    if not o.get("hook_tpl"):
        box = o.get("hook_box", "")
        old = {"putih": "#ffffff", "kuning": "#ffff00", "hitam": "#000000", "merah": "#ff3a3a",
               "biru": "#40c0ff", "hijau": "#66ff00"}
        if box == "hitam":
            o.update(hook_tpl="kotak", hook_bg="#000000", hook_txt="#ffffff")
        elif box == "polos":
            o.update(hook_tpl="polos", hook_txt=old.get(o.get("hook_color", "putih"), "#ffffff"))
        elif box == "putih":
            o.update(hook_tpl="kotak", hook_bg="#ffffff", hook_txt="#000000")
        else:
            o["hook_tpl"] = "kutipan"
        o.setdefault("hook_align", "tengah" if box else "kiri")
    return o


# ----------------------------------------------------------------------------- teks -> baris

def tokens(text, upper):
    """'MOMEN *BANG WINDAH* ...' -> [(kata, disorot)], '|' = ganti baris paksa (token None)."""
    text = clean(text)
    if upper:
        text = text.upper()
    out, hl = [], False
    for raw in re.split(r"(\|)|\s+", text):
        if raw is None or raw == "":
            continue
        if raw == "|":
            out.append(None)
            continue
        word = raw.strip("*")
        lead = len(raw) - len(raw.lstrip("*"))
        trail = len(raw) - len(raw.rstrip("*"))
        if not word:
            continue
        if lead:
            hl = True
        out.append((word, hl))
        if trail:
            hl = False
    return out


def wrap(tok, max_w, measure):
    lines, cur = [], []
    for t in tok:
        if t is None:
            if cur:
                lines.append(cur)
            cur = []
            continue
        trial = cur + [t]
        if cur and measure(" ".join(w for w, _ in trial)) > max_w:
            lines.append(cur)
            cur = [t]
        else:
            cur = trial
    if cur:
        lines.append(cur)
    # hindari 1 kata nyangkut sendirian di baris terakhir (contoh "GTA" / "6" -> "GTA 6")
    if len(lines) >= 2 and len(lines[-1]) == 1 and len(lines[-2]) >= 3:
        cand = [lines[-2][-1]] + lines[-1]
        if measure(" ".join(w for w, _ in cand)) <= max_w:
            lines[-1] = cand
            lines[-2] = lines[-2][:-1]
    return lines


def line_str(line):
    return " ".join(f"*{w}*" if h else w for w, h in line)


# ----------------------------------------------------------------------------- tata letak

def defaults(tpl):
    return {"kutipan": dict(bg="#ffffff", txt="#161616", acc="#57c2ae", align="kiri"),
            "kotak": dict(bg="#ffffff", txt="#000000", acc="#ff3d68", align="tengah"),
            "label": dict(bg="#000000", txt="#ffffff", acc="#ffd400", align="kiri"),
            "strip": dict(bg="#000000", txt="#ffffff", acc="#ffd400", align="kiri"),
            "polos": dict(bg="#000000", txt="#ffffff", acc="#ffd400", align="tengah")}.get(tpl, {})


def cfg_from(o, W, H, tpl=None, size=None):
    o = legacy(o)
    tpl = tpl or o.get("hook_tpl") or "kutipan"
    if tpl not in TEMPLATES:
        tpl = "kutipan"
    d = defaults(tpl)
    return {
        "tpl": tpl, "W": W, "H": H,
        "size": float(size or o.get("hook_size") or 58),
        "align": o.get("hook_align") or d["align"],
        "pos": o.get("hook_pos") or "auto",
        "x": float(o.get("hook_x") or 0), "y": float(o.get("hook_y") or 0),
        "wpct": float(o.get("hook_w") or 84),
        "bg": o.get("hook_bg") or d["bg"], "txt": o.get("hook_txt") or d["txt"], "acc": o.get("hook_acc") or d["acc"],
        "bg_op": float(o.get("hook_bg_op") if o.get("hook_bg_op") not in (None, "") else (75 if tpl == "strip" else 100)) / 100,
        "outline": float(o.get("hook_outline") if o.get("hook_outline") not in (None, "") else 10),
        "upper": bool(o.get("hook_upper", True)),
        "round": bool(o.get("hook_round", False)),
        "label": o.get("hook_label") or "",
        "safe_top": float(o.get("_safe_top") or 0),
    }


def layout(lines, widths, cfg, font, auto_cy, label_w=None):
    """lines: [[(kata, sorot)]], widths: lebar teks tiap baris (px, ukuran em).
    -> dict elemen: boxes, texts, badge, label, bounds. Sama dengan hookLayout() di index.html."""
    W, H = cfg["W"], cfg["H"]
    E = cfg["size"] * 1.015
    cap = font.get("cap", 0.7) * E
    up = cfg["upper"]
    ink_top = cap * (1.0 if up else 1.04)
    ink_bot = 0.0 if up else 0.21 * E
    ink = ink_top + ink_bot
    tpl = cfg["tpl"]
    boxed = tpl in ("kutipan", "kotak")
    padx, pady, gap = 0.6 * E, 0.22 * E, 0.13 * E
    n = max(1, len(lines))
    if boxed:
        lh = ink + 2 * pady
        pitch = lh + gap
    else:
        lh = ink
        ol = cfg["size"] * cfg["outline"] / 100 if tpl in ("polos", "label") else 0.0
        pitch = ink + 0.30 * E + 1.2 * ol
    text_h = n * lh + (n - 1) * (pitch - lh)
    head_h = 0.0
    badge = lab = None
    if tpl == "kutipan":
        badge = {"w": 2.2 * E, "h": 1.3 * E}
        head_h = badge["h"] + 0.5 * E
    elif tpl == "label" and cfg["label"]:
        le = 0.5 * E
        lab = {"em": le, "padx": 0.42 * le, "h": cap / E * le + 2 * 0.45 * le, "tw": label_w or 0}
        lab["w"] = lab["tw"] + 2 * lab["padx"]
        head_h = lab["h"] + 0.32 * E
    strip_pad = 0.45 * E if tpl == "strip" else 0.0
    block_h = head_h + text_h
    portrait = H > W
    pos = cfg["pos"]
    if pos == "atas":
        top = H * (0.085 if portrait else 0.07)
    elif pos == "tengah":
        top = H * 0.5 - block_h / 2
    elif pos == "bawah":
        top = H * (0.80 if portrait else 0.78) - block_h / 2
    elif pos == "bebas":
        top = H * cfg["y"] / 100 - block_h / 2
    else:
        top = max(H * 0.035 + strip_pad, auto_cy - block_h / 2)
    if pos in ("auto", "atas") and cfg.get("safe_top"):
        top = max(top, cfg["safe_top"] + strip_pad + 0.01 * H)
    align = cfg["align"]
    if pos == "bebas" and cfg["x"] > 0:
        ax = W * cfg["x"] / 100
    else:
        ax = W * {"kiri": 0.085, "tengah": 0.5, "kanan": 0.915}.get(align, 0.5)
        if tpl == "strip" and align != "tengah":
            ax = W * (0.07 if align == "kiri" else 0.93)

    def place(w):  # posisi kiri sebuah elemen selebar w sesuai rata kiri/tengah/kanan
        return ax if align == "kiri" else ax - w / 2 if align == "tengah" else ax - w

    el = {"boxes": [], "texts": [], "badge": None, "label": None, "marks": []}
    y = top
    if badge:
        bx = place(badge["w"])
        el["badge"] = {"x": bx, "y": y, "w": badge["w"], "h": badge["h"]}
        mw, mh, mg = 0.585 * E, 0.83 * E, 0.13 * E
        mx = bx + (badge["w"] - (2 * mw + mg)) / 2
        my = y + (badge["h"] - mh) / 2 + 0.04 * E
        for k in range(2):
            ox = mx + k * (mw + mg)
            el["marks"].append([(ox + px * mw, my + py * mh) for px, py in QUOTE_MARK])
        y += head_h
    elif lab:
        lx = place(lab["w"])
        el["label"] = {"x": lx, "y": y, "w": lab["w"], "h": lab["h"], "em": lab["em"],
                       "tx": lx + lab["padx"], "base": y + lab["h"] / 2 + cap / E * lab["em"] / 2}
        y += head_h
    for i, line in enumerate(lines):
        tw = widths[i] if i < len(widths) else 0
        ly = y + i * pitch
        if boxed:
            bw = tw + 2 * padx
            bx = place(bw)
            el["boxes"].append({"x": bx, "y": ly, "w": bw, "h": lh})
            el["texts"].append({"x": bx + padx, "base": ly + pady + ink_top, "line": line})
        else:
            el["texts"].append({"x": place(tw), "base": ly + ink_top, "line": line})
    if tpl == "strip":
        el["boxes"].append({"x": 0, "y": top - strip_pad, "w": W, "h": block_h + 2 * strip_pad, "strip": True})
        el["boxes"].append({"x": 0, "y": top - strip_pad, "w": 0.16 * E, "h": block_h + 2 * strip_pad, "accent": True})
    xs = [b["x"] for b in el["boxes"] if not b.get("strip")] + [t["x"] for t in el["texts"]]
    xe = [b["x"] + b["w"] for b in el["boxes"] if not b.get("strip")] + \
         [t["x"] + (widths[i] if i < len(widths) else 0) for i, t in enumerate(el["texts"])]
    if el["badge"]:
        xs.append(el["badge"]["x"])
        xe.append(el["badge"]["x"] + el["badge"]["w"])
    if el["label"]:
        xs.append(el["label"]["x"])
        xe.append(el["label"]["x"] + el["label"]["w"])
    el["bounds"] = {"x0": min(xs) if xs else ax, "y0": top, "x1": max(xe) if xe else ax, "y1": top + block_h}
    el["E"] = E
    return el


def prepare(text, o, W, H, font, auto_cy, given=None, tpl=None, size=None, align=None, pos=None, y_pct=None,
            label_text=None):
    """Teks hook -> (cfg, elemen tata letak). given = baris & lebar dari browser (kalau ada, dipakai persis)."""
    cfg = cfg_from(o, W, H, tpl=tpl, size=size)
    if align:
        cfg["align"] = align
    if pos:
        cfg["pos"] = pos
    if y_pct is not None:
        cfg["y"] = y_pct
        cfg["x"] = 0
    if label_text is not None:
        cfg["label"] = label_text
    E = cfg["size"] * 1.015
    measure = lambda s: EF.text_width(font["id"], s, E)  # noqa: E731
    tok = tokens(text, cfg["upper"])
    plain = [w for t in tok if t for w in [t[0]]]
    lines, widths = None, None
    if given and isinstance(given, list):
        try:
            g_lines = [tokens(str(x.get("t", "")), cfg["upper"]) for x in given]
            g_plain = [t[0] for ln in g_lines for t in ln if t]
            if g_plain == plain and all(g_lines):
                lines = [[t for t in ln if t] for ln in g_lines]
                widths = [float(x.get("w") or 0) or measure(" ".join(w for w, _ in ln)) for x, ln in zip(given, lines)]
        except Exception:
            lines = None
    if lines is None:
        pad = 1.2 * E if cfg["tpl"] in ("kutipan", "kotak") else 0
        max_w = W * cfg["wpct"] / 100 - pad
        lines = wrap(tok, max_w, measure)
        widths = [measure(" ".join(w for w, _ in ln)) for ln in lines]
    label_w = None
    if cfg["tpl"] == "label" and cfg["label"]:
        lt = clean(cfg["label"]).upper()
        cfg["label"] = lt
        label_w = EF.text_width(font["id"], lt, 0.5 * E * 1.0)
    return cfg, layout(lines, widths, cfg, font, auto_cy, label_w)


# ----------------------------------------------------------------------------- ASS

def _rect(w, h, r=0.0):
    if r <= 0.5:
        return f"m 0 0 l {w:.1f} 0 {w:.1f} {h:.1f} 0 {h:.1f}"
    r = min(r, w / 2, h / 2)
    c = r * 0.4477  # kontrol bezier lingkaran
    return (f"m {r:.1f} 0 l {w - r:.1f} 0 b {w - c:.1f} 0 {w:.1f} {c:.1f} {w:.1f} {r:.1f} "
            f"l {w:.1f} {h - r:.1f} b {w:.1f} {h - c:.1f} {w - c:.1f} {h:.1f} {w - r:.1f} {h:.1f} "
            f"l {r:.1f} {h:.1f} b {c:.1f} {h:.1f} 0 {h - c:.1f} 0 {h - r:.1f} "
            f"l 0 {r:.1f} b 0 {c:.1f} {c:.1f} 0 {r:.1f} 0")


def events(el, cfg, font, t0, t1, anim="halus", layer=2):
    """Elemen tata letak -> baris Dialogue ASS (pakai style 'Box')."""
    if t1 <= t0:
        return []
    E = el["E"]
    S = round(cfg["size"] * font["k"])
    asc = font.get("asc", 0.95) * E
    tpl = cfg["tpl"]
    out = []
    order = [0]

    def ev(x, y, body, lay, extra=""):
        k = order[0]
        order[0] += 1
        st = t0 + (min(k, 6) * 0.06 if anim == "halus" else 0)
        if st >= t1:
            st = t0
        if anim == "halus":
            mv = f"\\move({x:.1f},{y + 16:.1f},{x:.1f},{y:.1f},0,260)\\fad(200,180)"
        else:
            mv = f"\\pos({x:.1f},{y:.1f})\\fad(0,120)"
        out.append(f"Dialogue: {lay},{ass_time(st)},{ass_time(t1)},Box,,0,0,0,,{{\\an7{mv}{extra}}}{body}")

    def shape(x, y, w, h, col, op, r=0.0, lay=layer):
        ev(x, y, _rect(w, h, r), lay, f"\\p1\\bord0\\shad0\\1c{ass_col(col)}\\1a{ass_alpha(op)}")
        out[-1] = out[-1].rstrip() + "{\\p0}"

    rnd = cfg["round"]
    for b in el["boxes"]:
        if b.get("strip"):
            shape(b["x"], b["y"], b["w"], b["h"], cfg["bg"], cfg["bg_op"], 0, layer)
        elif b.get("accent"):
            shape(b["x"], b["y"], b["w"], b["h"], cfg["acc"], 1.0, 0, layer + 1)
        else:
            shape(b["x"], b["y"], b["w"], b["h"], cfg["bg"], cfg["bg_op"], b["h"] * 0.22 if rnd else 0, layer)
    if el["badge"]:
        b = el["badge"]
        shape(b["x"], b["y"], b["w"], b["h"], cfg["acc"], 0.93, b["h"] * 0.16 if rnd else 0, layer)
        for poly in el["marks"]:
            ox, oy = poly[0]
            pts = " ".join(f"{px - b['x']:.1f} {py - b['y']:.1f}" for px, py in poly[1:])
            body = f"m {ox - b['x']:.1f} {oy - b['y']:.1f} l {pts}"
            ev(b["x"], b["y"], body + "{\\p0}", layer + 1, "\\p1\\bord0\\shad0\\1c&HFFFFFF&\\1a&H00&")
    if el["label"]:
        lb = el["label"]
        shape(lb["x"], lb["y"], lb["w"], lb["h"], cfg["acc"], 1.0, lb["h"] * 0.25 if rnd else 0, layer)
        ls = round(lb["em"] / 1.015 * font["k"])
        la = font.get("asc", 0.95) * lb["em"]
        ev(lb["tx"], lb["base"] - la, clean(cfg["label"]), layer + 1,
           f"\\fn{font['full']}\\fs{ls}\\bord0\\shad0\\1c{ass_col(contrast(cfg['acc']))}")
    txt, acc = ass_col(cfg["txt"]), ass_col(cfg["acc"])
    if tpl in ("polos", "label"):
        ol = max(0.0, cfg["size"] * cfg["outline"] / 100)
        style = f"\\bord{ol:.1f}\\shad{ol * 0.45:.1f}\\3c&H000000&\\4c&H000000&\\4a&H60&"
    else:
        style = "\\bord0\\shad0"
    hl_col = ass_col(hl_color(cfg))
    for t in el["texts"]:
        parts = []
        for w, h in t["line"]:
            parts.append(f"{{\\1c{hl_col}}}{clean(w)}{{\\1c{txt}}}" if h else clean(w))
        ev(t["x"], t["base"] - asc, " ".join(parts), layer + 2, f"\\fn{font['full']}\\fs{S}{style}\\1c{txt}")
    return out


BOX_STYLE = ("Style: Box,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1")


# ----------------------------------------------------------------------------- banner program / sponsor

def banner_layout(o, W, H, font, logo_aspect=None, widths=None):
    """Band di atas (teks kiri + logo + teks kanan). Band digambar drawbox, logo overlay, teks ASS.
    Posisi logo 0 = otomatis: seluruh grup di tengah, dan mengecil sendiri kalau terlalu lebar."""
    sc = W / 1080 if H > W else H / 1080
    bh = float(o.get("banner_h") or 104) * sc
    by = H * float(o.get("banner_y") or 4.5) / 100
    s1 = float(o.get("banner_size") or 30) * sc
    s2 = float(o.get("banner_size2") or 40) * sc
    t1 = clean(o.get("banner_text1") or "")
    t2 = clean(o.get("banner_text2") or "")
    lx = float(o.get("banner_lx") or 0)
    cy = by + bh / 2
    res = {"y": by, "h": bh, "texts": [], "logo": None}
    lh = bh * 0.72
    lw = lh * logo_aspect if logo_aspect else 0.0
    widths = widths or {}
    w1 = float(widths.get("1") or 0) or (EF.text_width(font["id"], t1, s1 * 1.015) if t1 else 0.0)
    w2 = float(widths.get("2") or 0) or (EF.text_width(font["id"], t2, s2 * 1.015) if t2 else 0.0)
    g1 = 0.5 * s1 if (t1 and (lw or t2)) else 0.0
    g2 = 0.35 * s2 if (t2 and lw) else 0.0
    total = w1 + g1 + lw + g2 + w2
    f = min(1.0, (0.94 * W - lw) / max(1.0, total - lw)) if total > 0.94 * W else 1.0
    s1, s2, w1, w2, g1, g2 = s1 * f, s2 * f, w1 * f, w2 * f, g1 * f, g2 * f
    total = w1 + g1 + lw + g2 + w2
    if lw and lx > 0:
        left = W * lx / 100 - lw / 2 - g1 - w1
    else:
        left = (W - total) / 2
    x = left
    cap = font.get("cap", 0.7)
    if t1:
        res["texts"].append({"t": t1, "em": s1 * 1.015, "x": x, "base": cy + cap * s1 * 1.015 / 2, "w": w1})
    x += w1 + g1
    if lw:
        res["logo"] = {"x": x, "y": cy - lh / 2, "w": lw, "h": lh}
        x += lw + g2
    if t2:
        res["texts"].append({"t": t2, "em": s2 * 1.015, "x": x, "base": cy + cap * s2 * 1.015 / 2, "w": w2})
    res["bottom"] = by + bh
    return res


def banner_events(bl, o, font, dur):
    out = []
    col = ass_col(o.get("banner_txt") or "#ffffff")
    for t in bl["texts"]:
        S = round(t["em"] / 1.015 * font["k"])
        top = t["base"] - font.get("asc", 0.95) * t["em"]
        out.append(f"Dialogue: 1,{ass_time(0)},{ass_time(dur)},Box,,0,0,0,,"
                   f"{{\\an7\\pos({t['x']:.1f},{top:.1f})\\fn{font['full']}\\fs{S}\\bord0\\shad0\\1c{col}}}{t['t']}")
    return out


# ----------------------------------------------------------------------------- progress bar

def pbar_events(o, W, H, dur):
    if not o.get("pbar_on") or dur <= 0:
        return []
    h = max(4, float(o.get("pbar_h") or 10)) * (W / 1080 if H > W else H / 1080)
    y = 0 if o.get("pbar_pos") == "atas" else H - h
    col = ass_col(o.get("pbar_col") or "#ffd400")
    ms = int(dur * 1000)
    rect = f"m 0 0 l {W} 0 {W} {h:.1f} 0 {h:.1f}"
    return [f"Dialogue: 7,{ass_time(0)},{ass_time(dur)},Box,,0,0,0,,{{\\an7\\pos(0,{y:.1f})\\p1\\bord0\\shad0"
            f"\\1c&HFFFFFF&\\1a&HB0&}}{rect}{{\\p0}}",
            f"Dialogue: 8,{ass_time(0)},{ass_time(dur)},Box,,0,0,0,,{{\\an7\\pos(0,{y:.1f})\\p1\\bord0\\shad0"
            f"\\1c{col}\\fscx0\\t(0,{ms},\\fscx100)}}{rect}{{\\p0}}"]
