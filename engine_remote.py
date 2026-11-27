"""Sambungkan HP: link aman (Cloudflare quick tunnel) supaya KlipKu Web di HP bisa minta PC ini
mengunduh potongan dari link YouTube / Twitch.

Keamanan:
- Akses lewat tunnel HANYA boleh ke /api/remote/fetch, /job, /file, /ping, dan wajib kunci rahasia.
- Kunci hanya ada di QR (bagian # dari link, tidak terkirim ke server mana pun).
- Pengaturan, kunci API, dan folder hasil tidak bisa dibuka dari luar.
Alamat tunnel berubah tiap kali dinyalakan, jadi alamatnya disimpan di "buku alamat" kecil
(projectgieclips.pages.dev/api/pc/<id>) supaya HP selalu bisa menemukan PC ini.
"""
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

WEB = "https://projectgieclips.pages.dev/"
RELAY = "https://projectgieclips.pages.dev/api/pc/"
ORIGINS = {"https://haigiefarzal.github.io", "https://projectgieclips.pages.dev", "https://projectgieclips.netlify.app"}
LOCAL = re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$")
TUNNEL = re.compile(r"https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com")

_state = {"proc": None, "url": None, "status": "mati", "error": "", "registered": False}
_lock = threading.Lock()


def find_exe():
    p = shutil.which("cloudflared")
    if p:
        return p
    for c in (r"C:\Program Files (x86)\cloudflared\cloudflared.exe", r"C:\Program Files\cloudflared\cloudflared.exe",
              str(Path.home() / "AppData/Local/Microsoft/WinGet/Links/cloudflared.exe"),
              "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"):
        if Path(c).exists():
            return c
    return None


def creds(io):
    """id pasangan, token buku alamat, dan kunci akses HP. Dibuat sekali, disimpan di settings."""
    load, save = io
    st = load()
    r = dict(st.get("remote") or {})
    changed = False
    for k, n in (("id", 18), ("token", 24), ("key", 24)):
        if not r.get(k):
            r[k] = secrets.token_urlsafe(n)
            changed = True
    if changed:
        st["remote"] = r
        save(st)
    return r


def set_auto(io, on):
    load, save = io
    st = load()
    r = dict(st.get("remote") or {})
    r["auto"] = bool(on)
    st["remote"] = r
    save(st)


def is_remote(headers):
    """Permintaan yang datang lewat tunnel Cloudflare membawa header Cf-*."""
    return any(headers.get(h) for h in ("Cf-Ray", "Cf-Connecting-Ip", "Cf-Visitor"))


def authorized(headers, io):
    given = headers.get("X-KlipKu-Key") or ""
    return bool(given) and hmac.compare_digest(given, creds(io)["key"])


def cors_origin(origin):
    origin = origin or ""
    return origin if origin in ORIGINS or LOCAL.match(origin) else None


def status(io):
    r = creds(io)
    alive = bool(_state["proc"] and _state["proc"].poll() is None)
    return {"status": _state["status"] if alive or _state["status"] == "menyambung" else "mati",
            "url": _state["url"] if alive else None, "error": _state["error"], "registered": _state["registered"],
            "installed": bool(find_exe()), "auto": bool(r.get("auto")),
            "link": f"{WEB}#pc={r['id']}&k={r['key']}"}


def _register(url, io, log):
    r = creds(io)
    body = json.dumps({"url": url or "", "token": r["token"]}).encode("utf-8")
    req = urllib.request.Request(RELAY + r["id"], data=body, method="PUT" if url else "DELETE",
                                 headers={"Content-Type": "application/json", "User-Agent": "KlipKu-PC"})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            res.read()
        _state["registered"] = bool(url)
        return True
    except Exception as ex:  # noqa
        log(f"Buku alamat HP gagal diperbarui: {ex}")
        if url:
            _state["error"] = "Link aktif, tapi buku alamat gagal diperbarui. HP mungkin perlu scan QR lagi."
        return False


def _register_loop(proc, io, log):
    """Daftarkan alamat sekarang, lalu ulangi tiap 10 menit selama tunnel hidup."""
    while proc.poll() is None and _state["proc"] is proc and _state["url"]:
        _register(_state["url"], io, log)
        for _ in range(600):
            if proc.poll() is not None or _state["proc"] is not proc:
                return
            time.sleep(1)


def _reader(proc, io, log):
    for line in proc.stdout:
        m = TUNNEL.search(line)
        if m and not _state["url"] and _state["proc"] is proc:
            _state.update(url=m.group(0), status="aktif", error="")
            log("Sambungan HP aktif. HP yang sudah dipasangkan bisa langsung pakai link.")
            threading.Thread(target=_register_loop, args=(proc, io, log), daemon=True).start()
    if _state["proc"] is proc:
        _state.update(status="mati", url=None, registered=False)


def start(port, io, log, wait=30):
    with _lock:
        p = _state["proc"]
        if p and p.poll() is None:
            return status(io)
        exe = find_exe()
        if not exe:
            _state["error"] = "cloudflared belum terpasang."
            raise RuntimeError("Program cloudflared belum terpasang. Jalankan 1-INSTALL sekali lagi, lalu buka KlipKu lagi.")
        _state.update(url=None, status="menyambung", error="", registered=False)
        flags = 0x08000000 if os.name == "nt" else 0  # tanpa jendela hitam tambahan di Windows
        proc = subprocess.Popen([exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                errors="replace", creationflags=flags)
        _state["proc"] = proc
    threading.Thread(target=_reader, args=(proc, io, log), daemon=True).start()
    end = time.time() + wait
    while time.time() < end and not _state["url"] and proc.poll() is None:
        time.sleep(0.4)
    if not _state["url"]:
        stop(io, log, forget=False)
        _state["error"] = "Gagal membuat link. Cek koneksi internet lalu coba lagi."
        raise RuntimeError(_state["error"])
    # tunggu sebentar sampai alamat terdaftar, supaya HP langsung bisa menemukan
    end = time.time() + 8
    while time.time() < end and not _state["registered"]:
        time.sleep(0.3)
    return status(io)


def stop(io, log, forget=True):
    with _lock:
        p = _state["proc"]
        _state.update(proc=None, url=None, status="mati", registered=False)
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(timeout=5)
        except Exception:  # noqa
            p.kill()
    if forget:
        threading.Thread(target=_register, args=("", io, log), daemon=True).start()
