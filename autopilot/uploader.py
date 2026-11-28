"""Adaptor layanan upload TikTok (perantara resmi yang sudah lolos audit TikTok). Bisa ganti vendor.
- Zernio  : 2 akun gratis selamanya, termasuk TikTok. File: presign -> PUT -> POST /v1/posts.
- Upload-Post: TikTok perlu paket berbayar. File langsung multipart ke /api/upload.
Semua fungsi mengembalikan dict {provider, post_id, published, url}."""
import datetime as dt
import os
import time

from . import net

ZERNIO = os.environ.get("KLIPKU_ZERNIO_API", "https://zernio.com/api/v1")
UPLOADPOST = os.environ.get("KLIPKU_UPLOADPOST_API", "https://api.upload-post.com")


class UploadError(Exception):
    def __init__(self, msg, retry=False):
        super().__init__(msg)
        self.retry = retry


def _err(provider, ex):
    body = ex.body if isinstance(ex.body, dict) else {}
    msg = body.get("error") or body.get("message") or body.get("detail") or str(ex)
    if isinstance(msg, dict):
        msg = msg.get("message") or str(msg)
    retry = ex.status is None or ex.status >= 500 or ex.status == 429
    if ex.status in (401, 403):
        msg = f"API key {provider} ditolak ({msg}). Cek di KlipKu → Autopilot → Layanan upload."
    return UploadError(f"{provider}: {msg}", retry=retry)


def iso_utc(t):
    return dt.datetime.fromtimestamp(int(t), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------- Zernio

def zernio_accounts(key):
    try:
        res = net.request("GET", f"{ZERNIO}/accounts", headers={"Authorization": f"Bearer {key}"}, timeout=30)
    except net.NetError as ex:
        raise _err("Zernio", ex)
    accs = res.get("accounts") if isinstance(res, dict) else res
    out = []
    for a in accs or []:
        out.append({"id": a.get("_id") or a.get("id"), "platform": (a.get("platform") or "").lower(),
                    "name": a.get("username") or a.get("displayName") or a.get("name") or "",
                    "active": a.get("isActive", True)})
    return out


def zernio_post(cfg, path, caption, scheduled_at):
    key, acc = cfg.get("zernio_key"), cfg.get("zernio_account")
    if not key or not acc:
        raise UploadError("Zernio belum diatur (API key + akun TikTok).")
    h = {"Authorization": f"Bearer {key}"}
    size = os.path.getsize(path)
    try:
        pre = net.request("POST", f"{ZERNIO}/media/presign", {"filename": os.path.basename(path), "contentType": "video/mp4",
                                                              "size": size}, h, timeout=60)
    except net.NetError as ex:
        raise _err("Zernio", ex)
    up, public = pre.get("uploadUrl"), pre.get("publicUrl")
    if not up or not public:
        raise UploadError(f"Zernio: jawaban presign tidak lengkap: {str(pre)[:200]}")
    try:
        net.retry(lambda: net.put_file(up, path, "video/mp4"), tries=3, wait=5)
    except net.NetError as ex:
        raise UploadError(f"Zernio: upload file gagal ({ex})", retry=True)
    body = {"content": caption, "mediaItems": [{"type": "video", "url": public}],
            "platforms": [{"platform": "tiktok", "accountId": acc}],
            "tiktokSettings": {"privacy_level": cfg.get("tiktok_privacy") or "PUBLIC_TO_EVERYONE",
                               "allow_comment": True, "allow_duet": True, "allow_stitch": True,
                               "content_preview_confirmed": True, "express_consent_given": True,
                               "media_type": "video", "video_made_with_ai": False}}
    publish_now = scheduled_at - time.time() < 120
    if publish_now:
        body["publishNow"] = True
    else:
        body["scheduledFor"] = iso_utc(scheduled_at)
        body["timezone"] = "Asia/Jakarta"
    try:
        res = net.request("POST", f"{ZERNIO}/posts", body, h, timeout=300)
    except net.NetError as ex:
        raise _err("Zernio", ex)
    post = res.get("post") or res
    st = (post.get("status") or "").lower()
    if st in ("failed",):
        raise UploadError(f"Zernio menolak posting: {str(res.get('platformResults') or res)[:300]}")
    return {"provider": "Zernio", "post_id": post.get("_id") or post.get("id") or "", "published": st == "published",
            "url": _find_url(post)}


def _find_url(obj):
    """Cari link tiktok.com di jawaban (nama field berbeda-beda antar vendor)."""
    if isinstance(obj, dict):
        for v in obj.values():
            u = _find_url(v)
            if u:
                return u
    elif isinstance(obj, list):
        for v in obj:
            u = _find_url(v)
            if u:
                return u
    elif isinstance(obj, str) and "tiktok.com/" in obj and obj.startswith("http"):
        return obj
    return None


def zernio_status(cfg, post_id):
    try:
        res = net.request("GET", f"{ZERNIO}/posts/{post_id}", headers={"Authorization": f"Bearer {cfg.get('zernio_key')}"},
                          timeout=30)
    except net.NetError as ex:
        raise _err("Zernio", ex)
    post = res.get("post") or res
    return {"status": (post.get("status") or "").lower(), "url": _find_url(post)}


# ---------------------------------------------------------------------------- Upload-Post

def uploadpost_users(key):
    try:
        res = net.request("GET", f"{UPLOADPOST}/api/uploadposts/users", headers={"Authorization": f"Apikey {key}"}, timeout=30)
    except net.NetError as ex:
        raise _err("Upload-Post", ex)
    users = res.get("profiles") or res.get("users") or []
    out = []
    for u in users:
        name = u.get("username") or u.get("name") or u.get("user")
        socials = u.get("social_accounts") or {}
        tk = socials.get("tiktok") if isinstance(socials, dict) else None
        out.append({"id": name, "platform": "tiktok" if tk else "?", "name": name + (f" (TikTok: {tk.get('display_name') or tk.get('username')})"
                                                                                     if isinstance(tk, dict) else ""), "active": True})
    return out


def uploadpost_post(cfg, path, caption, scheduled_at):
    key, user = cfg.get("uploadpost_key"), cfg.get("uploadpost_user")
    if not key or not user:
        raise UploadError("Upload-Post belum diatur (API key + nama profil).")
    fields = [("user", user), ("platform[]", "tiktok"), ("title", caption[:2200]),
              ("privacy_level", cfg.get("tiktok_privacy") or "PUBLIC_TO_EVERYONE"), ("async_upload", "true")]
    if scheduled_at - time.time() >= 120:
        fields.append(("scheduled_date", iso_utc(scheduled_at)))
    try:
        res = net.multipart(f"{UPLOADPOST}/api/upload", fields, [("video", path, os.path.basename(path), "video/mp4")],
                            headers={"Authorization": f"Apikey {key}"}, timeout=1800)
    except net.NetError as ex:
        raise _err("Upload-Post", ex)
    if res.get("success") is False:
        raise UploadError(f"Upload-Post: {res.get('message') or res}")
    return {"provider": "Upload-Post", "post_id": res.get("request_id") or res.get("job_id") or "",
            "published": False, "url": _find_url(res)}


# ---------------------------------------------------------------------------- umum

def accounts(cfg):
    if cfg.get("upload_provider") == "uploadpost":
        return uploadpost_users(cfg.get("uploadpost_key"))
    return zernio_accounts(cfg.get("zernio_key"))


def configured(cfg):
    if cfg.get("upload_provider") == "uploadpost":
        return bool(cfg.get("uploadpost_key") and cfg.get("uploadpost_user"))
    return bool(cfg.get("zernio_key") and cfg.get("zernio_account"))


def post(cfg, path, caption, scheduled_at):
    if not os.path.exists(path):
        raise UploadError("File clip tidak ditemukan di folder hasil (mungkin sudah dihapus).")
    if cfg.get("upload_provider") == "uploadpost":
        return uploadpost_post(cfg, path, caption, scheduled_at)
    return zernio_post(cfg, path, caption, scheduled_at)


def status(cfg, post_id):
    if cfg.get("upload_provider") == "uploadpost" or not post_id:
        return None
    return zernio_status(cfg, post_id)
