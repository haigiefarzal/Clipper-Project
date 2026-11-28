"""Endpoint halaman Autopilot di KlipKu (http://127.0.0.1:8765/autopilot)."""
import threading
import time

from . import cloud as CL
from . import net, runner as R, telegram as TG, uploader as UP

INSTALL = {"running": False, "log": [], "error": "", "done": False}
SAFE = ("ai_editor", "min_skor", "per_video", "caption_credit", "gemini_model", "tiktok_privacy", "upload_provider",
        "owner_username", "zernio_account", "uploadpost_user")


def _mask(v):
    v = str(v or "")
    return (v[:4] + "…" + v[-4:]) if len(v) > 12 else ("✓" if v else "")


def status(app):
    c = R.cfg() if R.APP else dict((app.load_settings().get("autopilot") or {}))
    k = dict(app.load_settings().get("keys") or {})
    return {"ok": True,
            "cfg": {"tg": bool(c.get("tg_token")), "bot": c.get("bot_username"), "owner_id": c.get("owner_id"),
                    "owner_name": c.get("owner_name"), "owner_username": c.get("owner_username") or "",
                    "worker_url": c.get("worker_url"), "cf_account": c.get("cf_account"), "cf_token": _mask(c.get("cf_token")),
                    "enabled": bool(c.get("enabled")), "upload_provider": c.get("upload_provider") or "zernio",
                    "zernio_key": _mask(c.get("zernio_key")), "zernio_account": c.get("zernio_account"),
                    "zernio_account_name": c.get("zernio_account_name"),
                    "uploadpost_key": _mask(c.get("uploadpost_key")), "uploadpost_user": c.get("uploadpost_user"),
                    "tiktok_privacy": c.get("tiktok_privacy") or "PUBLIC_TO_EVERYONE",
                    "ai_editor": c.get("ai_editor") or "gemini", "min_skor": int(c.get("min_skor") or 55),
                    "per_video": int(c.get("per_video") or 5), "caption_credit": c.get("caption_credit", True),
                    "gemini_model": c.get("gemini_model") or "gemini-flash-latest"},
            "keys": {"gemini": bool(k.get("gemini")), "claude": bool(k.get("claude")), "groq": bool(k.get("groq"))},
            "upload_ready": UP.configured(c),
            "install": INSTALL, "state": R.public_state() if R.APP else {"running": False}}


def api(app, path, data):
    UE = app.UserError
    if path == "/api/ap/status":
        return status(app)
    if path == "/api/ap/telegram":
        tok = (data.get("token") or "").strip()
        if not tok or ":" not in tok:
            raise UE("Token bot tidak valid. Bentuknya seperti 123456789:AAH... (dari @BotFather).")
        try:
            me = TG.get_me(tok)
        except TG.TgError as ex:
            raise UE(str(ex))
        R.save_cfg({"tg_token": tok, "bot_username": me.get("username")})
        return {"ok": True, "bot": me.get("username")}
    if path == "/api/ap/detect":
        c = R.cfg()
        if not c.get("tg_token"):
            raise UE("Isi token bot dulu.")
        want = (data.get("username") or c.get("owner_username") or "").lstrip("@").strip()
        try:
            who, had_hook, hook_url = TG.detect_owner(c["tg_token"], want)
        except TG.TgError as ex:
            raise UE(str(ex))
        if had_hook and c.get("worker_url") and c.get("tg_secret"):
            try:
                TG.set_webhook(c["tg_token"], c["worker_url"] + "/tg", c["tg_secret"])
            except TG.TgError:
                pass
        if not who:
            raise UE(f"Belum ada pesan dari @{want or 'kamu'}. Buka bot @{c.get('bot_username')} di Telegram, tekan START "
                     f"(atau kirim /start), lalu klik Deteksi lagi.")
        name = " ".join(x for x in (who.get("first_name"), who.get("last_name")) if x)
        R.save_cfg({"owner_id": who["id"], "owner_name": name, "owner_username": who.get("username") or want})
        try:
            TG.send_message(c["tg_token"], who["id"], f"✅ Halo {name}! Bot ini sudah tersambung ke KlipKu di laptop kamu.")
        except TG.TgError:
            pass
        return {"ok": True, "id": who["id"], "name": name, "username": who.get("username")}
    if path == "/api/ap/install":
        if INSTALL["running"]:
            raise UE("Pemasangan sedang berjalan.")
        upd = {}
        if data.get("cf_token"):
            upd["cf_token"] = data["cf_token"].strip()
        if data.get("cf_account") is not None:
            upd["cf_account"] = data["cf_account"].strip()
        if upd:
            R.save_cfg(upd)
        c = R.cfg()

        def go():
            INSTALL.update(running=True, log=[], error="", done=False)
            try:
                res = CL.deploy(c, log=lambda m: INSTALL["log"].append(time.strftime("%H:%M:%S ") + m))
                R.save_cfg(dict(res, enabled=True))
                R.start(app)
                INSTALL["done"] = True
            except (CL.CfError, TG.TgError, net.NetError) as ex:
                INSTALL["error"] = str(ex)
            except Exception as ex:  # noqa
                INSTALL["error"] = f"Error tak terduga: {ex}"
                app.log(__import__("traceback").format_exc())
            INSTALL["running"] = False
        threading.Thread(target=go, daemon=True).start()
        return {"ok": True}
    if path == "/api/ap/keys":
        st = app.load_settings()
        ks = st.setdefault("keys", {})
        for k in ("gemini", "claude", "groq"):
            v = (data.get(k) or "").strip()
            if v:
                ks[k] = v
            if data.get(k + "_remove"):
                ks.pop(k, None)
        app.save_settings(st)
        return {"ok": True}
    if path == "/api/ap/upload":
        upd = {"upload_provider": data.get("provider") or "zernio"}
        for k in ("zernio_key", "uploadpost_key"):
            if (data.get(k) or "").strip():
                upd[k] = data[k].strip()
        R.save_cfg(upd)
        c = R.cfg()
        try:
            accs = UP.accounts(c)
        except UP.UploadError as ex:
            raise UE(str(ex))
        return {"ok": True, "accounts": accs}
    if path == "/api/ap/save":
        upd = {k: data[k] for k in SAFE if k in data}
        if "zernio_account_name" in data:
            upd["zernio_account_name"] = data["zernio_account_name"]
        R.save_cfg(upd)
        return {"ok": True}
    if path == "/api/ap/enable":
        on = bool(data.get("on"))
        R.save_cfg({"enabled": on})
        if on:
            if not R.ready():
                raise UE("Selesaikan langkah 1-2 dulu (Telegram & otak cloud).")
            R.start(app)
        return {"ok": True}
    if path == "/api/ap/test":
        cl = R.cloud()
        if not cl:
            raise UE("Otak cloud belum terpasang.")
        try:
            cl.call("/api/notify", {"text": "🧪 Tes dari laptop: KlipKu ↔ otak cloud ↔ Telegram tersambung!"})
            st = cl.call("/api/state", {})
        except net.NetError as ex:
            raise UE(f"Otak cloud tidak bisa dihubungi: {ex}")
        return {"ok": True, "status": st.get("status")}
    raise UE("Perintah tidak dikenal.")
