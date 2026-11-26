"""Daftar font: bawaan KlipKu + folder fonts/tambahan + font yang ter-install di komputer."""
import hashlib
import logging
import json
import os
import shutil
import sys
import threading
from pathlib import Path

APP = Path(__file__).resolve().parent
FONTS = APP / "fonts"
EXTRA = FONTS / "tambahan"
CACHE = APP / "work" / "font_cache.json"
EXTRA.mkdir(parents=True, exist_ok=True)

logging.getLogger("fontTools").setLevel(logging.ERROR)
_reg = {}
_lock = threading.Lock()
DEFAULT_FONT = None


def _system_dirs():
    dirs = []
    if sys.platform.startswith("win"):
        win = os.environ.get("WINDIR", r"C:\Windows")
        dirs.append(Path(win) / "Fonts")
        la = os.environ.get("LOCALAPPDATA")
        if la:
            dirs.append(Path(la) / "Microsoft" / "Windows" / "Fonts")
    elif sys.platform == "darwin":
        dirs += [Path("/System/Library/Fonts"), Path("/Library/Fonts"), Path.home() / "Library" / "Fonts"]
    else:
        dirs += [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts",
                 Path.home() / ".local" / "share" / "fonts"]
    return [d for d in dirs if d.exists()]


def _read(path):
    from fontTools.ttLib import TTFont
    f = TTFont(str(path), lazy=True, fontNumber=0)
    if "fvar" in f or "OS/2" not in f or "name" not in f:
        return None
    cmap = f.getBestCmap() or {}
    if not all(ord(c) in cmap for c in "AaZz"):
        return None  # bukan font latin (misalnya font simbol / CJK)
    os2 = f["OS/2"]
    if os2.fsSelection & 1:  # italic -> lewati supaya daftar tidak kepenuhan
        return None
    n = f["name"]
    full = n.getBestFullName() or n.getBestFamilyName()
    fam = n.getBestFamilyName() or full
    upm = f["head"].unitsPerEm or 1000
    win = (os2.usWinAscent + os2.usWinDescent) / upm
    if win <= 0.3:
        hh = f["hhea"]
        win = (hh.ascent - hh.descent) / upm
    try:  # lebar rata-rata huruf KAPITAL (untuk menghitung muat berapa huruf per baris)
        hmtx, glyf_map = f["hmtx"], f.getBestCmap()
        widths = [hmtx[glyf_map[ord(c)]][0] for c in "ABCDEFGHIJKLMNOPRSTUWY" if ord(c) in glyf_map]
        aw = sum(widths) / len(widths) / upm
    except Exception:
        aw = 0.65
    return {"full": full, "family": fam, "weight": int(os2.usWeightClass), "k": round(win * 1.015, 4),
            "aw": round(aw, 4)}


def scan(force=False):
    """Bangun registry font. Hasil di-cache berdasarkan path+mtime supaya cepat."""
    global DEFAULT_FONT
    try:
        cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() and not force else {}
    except Exception:
        cache = {}
    groups = [("Bawaan KlipKu", FONTS, False), ("Font tambahan kamu", EXTRA, True)]
    groups += [("Font di komputer", d, True) for d in _system_dirs()]
    reg, newcache, seen_full = {}, {}, set()
    count = 0
    for gname, d, recursive in groups:
        it = d.rglob("*") if recursive else d.glob("*")
        for p in it:
            if p.suffix.lower() not in (".ttf", ".otf") or not p.is_file():
                continue
            count += 1
            if count > 4000:
                break
            key = str(p)
            try:
                mt = p.stat().st_mtime
            except OSError:
                continue
            c = cache.get(key)
            if c and c.get("mt") == mt and c.get("v") == 2:
                info = c.get("info")
            else:
                try:
                    info = _read(p)
                except Exception:
                    info = None
            newcache[key] = {"mt": mt, "info": info, "v": 2}
            if not info:
                continue
            if info["full"].lower() in seen_full:
                continue
            seen_full.add(info["full"].lower())
            fid = hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
            reg[fid] = dict(info, id=fid, path=key, group=gname)
    try:
        CACHE.parent.mkdir(exist_ok=True)
        CACHE.write_text(json.dumps(newcache), encoding="utf-8")
    except Exception:
        pass
    with _lock:
        _reg.clear()
        _reg.update(reg)
    DEFAULT_FONT = next((f["id"] for f in reg.values() if f["full"] == "Poppins Bold"), next(iter(reg), None))
    return reg


def registry():
    if not _reg:
        scan()
    return _reg


def get(fid):
    reg = registry()
    return reg.get(fid) or reg.get(DEFAULT_FONT) or next(iter(reg.values()))


def public_list():
    order = {"Bawaan KlipKu": 0, "Font tambahan kamu": 1, "Font di komputer": 2}
    items = sorted(registry().values(), key=lambda f: (order.get(f["group"], 3), f["full"].lower()))
    return [{"id": f["id"], "name": f["full"], "group": f["group"]} for f in items]


def stage(fids, dest):
    """Salin file font yang dipakai ke folder sementara (untuk fontsdir ffmpeg)."""
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for fid in set(fids):
        f = get(fid)
        try:
            shutil.copy(f["path"], dest / (f["id"] + Path(f["path"]).suffix.lower()))
        except Exception:
            pass
    return dest
