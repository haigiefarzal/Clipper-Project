"""Otak cloud (Cloudflare Worker): klien API untuk laptop + pemasang otomatis lewat API Cloudflare."""
import json
import os
import re
import secrets
import string
import time
from pathlib import Path

from . import net, telegram

CF_API = os.environ.get("KLIPKU_CF_API", "https://api.cloudflare.com/client/v4")
SCRIPT = "klipku-otak"
DBNAME = "klipku-otak"
HERE = Path(__file__).resolve().parent.parent / "cloud"


# ============================================================================ klien laptop -> otak

class Cloud:
    def __init__(self, url, key):
        self.url, self.key = (url or "").rstrip("/"), key

    def call(self, path, data=None, timeout=60):
        return net.request("POST", self.url + path, data or {}, {"Authorization": f"Bearer {self.key}"}, timeout=timeout)

    def poll(self, **kw):
        return self.call("/api/poll", {k: v for k, v in kw.items() if v is not None}, timeout=40)

    def progress(self, job_id, text, title=None):
        try:
            return self.call(f"/api/job/{job_id}/progress", {"text": text, "title": title}, timeout=20)
        except net.NetError:
            return {}

    def done(self, job_id, result):
        return net.retry(lambda: self.call(f"/api/job/{job_id}/done", {"result": result}))

    def fail(self, job_id, error, retry=False, delay=600, defer=False):
        return net.retry(lambda: self.call(f"/api/job/{job_id}/fail", {"error": str(error)[:1500], "retry": retry,
                                                                        "delay": delay, "defer": defer}))


# ============================================================================ pemasang (Cloudflare API)

class CfError(Exception):
    pass


def _cf(method, path, token, data=None, raw_body=None, headers=None, timeout=60):
    h = {"Authorization": f"Bearer {token}"}
    h.update(headers or {})
    try:
        res = net.request(method, CF_API + path, raw_body if raw_body is not None else data, h, timeout=timeout)
    except net.NetError as ex:
        body = ex.body if isinstance(ex.body, dict) else {}
        errs = body.get("errors") or []
        msg = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in errs) or str(ex)
        if ex.status in (401, 403) or any(e.get("code") in (10000, 9109, 7403) for e in errs):
            raise CfError(f"Token Cloudflare ditolak / kurang izin ({msg}). Pastikan izinnya: Workers Scripts: Edit, "
                          f"D1: Edit, Account Settings: Read.")
        raise CfError(msg)
    if isinstance(res, dict) and res.get("success") is False:
        raise CfError("; ".join(f"{e.get('code')}: {e.get('message')}" for e in res.get("errors") or []) or "gagal")
    return res


def _split_sql(sql):
    sql = re.sub(r"--[^\n]*", "", sql)
    return [s.strip() for s in sql.split(";") if s.strip()]


def deploy(cfg, log=print):
    """cfg: dict pengaturan autopilot (cf_token, cf_account?, tg_token, owner_id, worker_key?, tg_secret?).
    -> dict yang perlu disimpan (cf_account, d1_id, worker_url, worker_key, tg_secret)."""
    tok = (cfg.get("cf_token") or "").strip()
    if not tok:
        raise CfError("Isi API token Cloudflare dulu.")
    if not cfg.get("tg_token") or not cfg.get("owner_id"):
        raise CfError("Selesaikan langkah Telegram dulu (token bot + deteksi akun kamu).")
    acc = (cfg.get("cf_account") or "").strip()
    log("Memeriksa token Cloudflare...")
    if not acc:
        res = _cf("GET", "/accounts?per_page=50", tok)
        accs = res.get("result") or []
        if not accs:
            raise CfError("Tidak ada akun Cloudflare yang bisa diakses token ini. Isi Account ID secara manual.")
        acc = accs[0]["id"]
        log(f"Akun Cloudflare: {accs[0].get('name', acc)}")
    # D1
    log("Menyiapkan database D1...")
    res = _cf("GET", f"/accounts/{acc}/d1/database?name={DBNAME}", tok)
    db = next((d for d in (res.get("result") or []) if d.get("name") == DBNAME), None)
    if db:
        db_id = db.get("uuid") or db.get("id")
    else:
        res = _cf("POST", f"/accounts/{acc}/d1/database", tok, {"name": DBNAME})
        r = res.get("result") or {}
        db_id = r.get("uuid") or r.get("id")
    if not db_id:
        raise CfError("Gagal membuat database D1.")
    for stmt in _split_sql((HERE / "schema.sql").read_text(encoding="utf-8")):
        _cf("POST", f"/accounts/{acc}/d1/database/{db_id}/query", tok, {"sql": stmt})
    log("Database siap.")
    # rahasia
    wk = cfg.get("worker_key") or secrets.token_urlsafe(32)
    ts = cfg.get("tg_secret") or "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(40))
    # upload script
    log("Mengunggah otak (Worker)...")
    meta = {"main_module": "otak.js", "compatibility_date": "2025-06-01",
            "bindings": [{"type": "d1", "name": "DB", "id": db_id},
                         {"type": "secret_text", "name": "TG_TOKEN", "text": cfg["tg_token"]},
                         {"type": "secret_text", "name": "OWNER_ID", "text": str(cfg["owner_id"])},
                         {"type": "secret_text", "name": "WORKER_KEY", "text": wk},
                         {"type": "secret_text", "name": "TG_SECRET", "text": ts}]}
    try:
        res = net.multipart(f"{CF_API}/accounts/{acc}/workers/scripts/{SCRIPT}",
                            [("metadata", json.dumps(meta))],
                            [("otak.js", (HERE / "otak.js").read_bytes(), "otak.js", "application/javascript+module")],
                            headers={"Authorization": f"Bearer {tok}"}, timeout=120, method="PUT")
    except net.NetError as ex:
        body = ex.body if isinstance(ex.body, dict) else {}
        msg = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in body.get("errors") or []) or str(ex)
        raise CfError(f"Upload Worker gagal: {msg}")
    if isinstance(res, dict) and res.get("success") is False:
        raise CfError("Upload Worker gagal: " + json.dumps(res.get("errors"))[:300])
    log("Memasang jadwal otomatis tiap 5 menit...")
    _cf("PUT", f"/accounts/{acc}/workers/scripts/{SCRIPT}/schedules", tok, [{"cron": "*/5 * * * *"}])
    # subdomain workers.dev
    sub = None
    try:
        sub = (_cf("GET", f"/accounts/{acc}/workers/subdomain", tok).get("result") or {}).get("subdomain")
    except CfError:
        sub = None
    if not sub:
        want = "klipku-" + "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        log(f"Membuat alamat workers.dev ({want})...")
        sub = (_cf("PUT", f"/accounts/{acc}/workers/subdomain", tok, {"subdomain": want}).get("result") or {}).get("subdomain") or want
    _cf("POST", f"/accounts/{acc}/workers/scripts/{SCRIPT}/subdomain", tok, {"enabled": True, "previews_enabled": False})
    url = os.environ.get("KLIPKU_TEST_WORKER_URL") or f"https://{SCRIPT}.{sub}.workers.dev"
    log(f"Alamat otak: {url}")
    log("Menunggu otak bisa diakses (alamat baru kadang butuh 1-2 menit)...")
    ok, last, t0 = False, "", time.time()
    for i in range(60):
        try:
            r = net.request("GET", url + "/sehat", raw=True, timeout=15)
            if b"OK" in r:
                ok = True
                break
            last = "jawaban tidak dikenal: " + r[:80].decode("utf-8", "replace")
        except net.NetError as ex:
            last = str(ex)[:200]
        if i == 0 or (i and i % 10 == 0):
            host = url.split("//")[1].split("/")[0]
            dns = net.LAST_DNS.get(host)
            log(f"  {'cek pertama' if i == 0 else f'masih menunggu ({int(time.time() - t0)} dtk)'}: {last}"
                + (f" [IP {dns}]" if dns else ""))
        time.sleep(4)
    if not ok:
        raise CfError(f"Otak sudah terpasang tapi laptop belum bisa membuka {url} (alasan: {last}; DNS: {net.LAST_DNS.get(url.split('//')[1].split('/')[0], 'DNS biasa')}). "
                      "Tunggu 2-3 menit lalu klik Pasang lagi (token tidak perlu ditempel ulang). Kalau tetap gagal, "
                      "buka alamat itu + /sehat di Chrome: kalau di Chrome muncul 'KlipKu Otak ... OK', berarti DNS internet "
                      "laptop memblokir workers.dev, ganti DNS Windows ke 1.1.1.1 / 8.8.8.8.")
    log("Menyambungkan bot Telegram ke otak...")
    telegram.set_webhook(cfg["tg_token"], url + "/tg", ts)
    telegram.set_commands(cfg["tg_token"])
    c = Cloud(url, wk)
    c.poll(host="pemasang", version="", want_job=False)
    c.call("/api/notify", {"text": "✅ Otak KlipKu terpasang di cloud dan nyala 24 jam.\nKetik /status atau /bantuan."})
    log("Selesai! Cek Telegram kamu.")
    return {"cf_account": acc, "d1_id": db_id, "worker_url": url, "worker_key": wk, "tg_secret": ts}
