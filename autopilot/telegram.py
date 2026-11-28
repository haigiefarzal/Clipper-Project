"""Bot Telegram dari sisi laptop: cek token, deteksi ID pemilik, kirim video (kartu momen & clip jadi).
Tombol & logika percakapan ada di otak cloud; laptop hanya mengirim media lalu melapor message_id."""
import os

from . import net

API = os.environ.get("KLIPKU_TG_API", "https://api.telegram.org")


class TgError(Exception):
    pass


def call(token, method, data=None, timeout=60):
    try:
        res = net.request("POST", f"{API}/bot{token}/{method}", data or {}, timeout=timeout)
    except net.NetError as ex:
        desc = ex.body.get("description") if isinstance(ex.body, dict) else str(ex)
        if ex.status == 401:
            raise TgError("Token bot salah. Salin ulang dari @BotFather.")
        if ex.status == 409:
            raise TgError("CONFLICT: " + str(desc))
        raise TgError(f"Telegram {method} gagal: {desc}")
    if not res.get("ok"):
        raise TgError(f"Telegram {method} gagal: {res.get('description')}")
    return res.get("result")


def get_me(token):
    return call(token, "getMe")


def detect_owner(token, username=""):
    """Cari pesan /start terbaru ke bot. username (tanpa @) dipakai untuk memastikan itu akun Agie."""
    info = call(token, "getWebhookInfo")
    had_hook = bool(info.get("url"))
    if had_hook:
        call(token, "deleteWebhook", {"drop_pending_updates": False})
    ups = call(token, "getUpdates", {"timeout": 0, "allowed_updates": ["message"]})
    want = username.lstrip("@").lower()
    found = None
    for u in reversed(ups or []):
        m = u.get("message") or {}
        fr = m.get("from") or {}
        if not fr or fr.get("is_bot"):
            continue
        if want and (fr.get("username") or "").lower() != want:
            continue
        found = fr
        break
    return found, had_hook, info.get("url")


def send_message(token, chat_id, text, timeout=30):
    return call(token, "sendMessage", {"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                                       "disable_web_page_preview": True}, timeout=timeout)


def send_video(token, chat_id, path, caption="", width=None, height=None, duration=None, thumb=None):
    fields = [("chat_id", chat_id), ("caption", caption[:1024]), ("parse_mode", "HTML"), ("supports_streaming", "true")]
    if width:
        fields += [("width", int(width)), ("height", int(height))]
    if duration:
        fields.append(("duration", int(round(duration))))
    files = [("video", path, os.path.basename(path), "video/mp4")]
    if thumb and os.path.exists(thumb):
        files.append(("thumbnail", thumb, "thumb.jpg", "image/jpeg"))
    try:
        res = net.multipart(f"{API}/bot{token}/sendVideo", fields, files, timeout=900)
    except net.NetError as ex:
        desc = ex.body.get("description") if isinstance(ex.body, dict) else str(ex)
        raise TgError(f"Kirim video ke Telegram gagal: {desc}")
    if not res.get("ok"):
        raise TgError(f"Kirim video ke Telegram gagal: {res.get('description')}")
    return res["result"]


def set_webhook(token, url, secret):
    return call(token, "setWebhook", {"url": url, "secret_token": secret, "allowed_updates": ["message", "callback_query"],
                                      "drop_pending_updates": True, "max_connections": 10})


def set_commands(token):
    cmds = [("status", "kondisi sistem & laptop"), ("tambah", "pantau channel: /tambah <link>"),
            ("channel", "daftar & atur channel"), ("kuota", "maks posting per hari: /kuota 5"),
            ("jadwal", "posting terjadwal"), ("cadangan", "clip belum diposting"), ("antrian", "tugas menunggu laptop"),
            ("clip", "/clip <link> 1:23:40-1:24:30 Judul"), ("pause", "jeda pemantauan"), ("lanjut", "lanjut pemantauan"),
            ("stop", "batalkan semua tugas menunggu"), ("bantuan", "daftar perintah")]
    try:
        call(token, "setMyCommands", {"commands": [{"command": c, "description": d} for c, d in cmds]})
    except TgError:
        pass
