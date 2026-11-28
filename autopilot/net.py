"""HTTP kecil tanpa dependensi (urllib): JSON, multipart, dan upload file besar secara streaming."""
import json
import mimetypes
import os
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid

UA = "KlipKu-PC/3.0 (+https://github.com/haigiefarzal/Clipper-Project)"

# ---------------------------------------------------------------- DNS aman untuk workers.dev
# Banyak provider internet di Indonesia memblokir *.workers.dev lewat DNS (ikut kena blokir situs judi).
# Chrome lolos karena pakai DNS aman sendiri; Python memakai DNS provider. Jadi khusus alamat otak,
# alamat IP-nya ditanyakan lewat DNS-over-HTTPS (Cloudflare 1.1.1.1 / Google), bukan DNS provider.
DOH_SUFFIX = tuple(x.strip().lower() for x in os.environ.get("KLIPKU_DOH_HOSTS", "workers.dev").split(",") if x.strip())
DOH_URLS = ("https://1.1.1.1/dns-query?name={}&type=A", "https://1.0.0.1/dns-query?name={}&type=A",
            "https://8.8.8.8/resolve?name={}&type=A", "https://dns.google/resolve?name={}&type=A")
_DOH = {}
_DOH_LOCK = threading.Lock()
_orig_gai = socket.getaddrinfo
LAST_DNS = {}


def _doh_lookup(host):
    for url in DOH_URLS:
        try:
            req = urllib.request.Request(url.format(host), headers={"accept": "application/dns-json", "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=8) as r:
                js = json.loads(r.read().decode("utf-8"))
            ips = [a["data"] for a in js.get("Answer") or [] if a.get("type") == 1]
            if ips:
                return ips, url.split("/")[2]
        except Exception:  # noqa
            continue
    return [], None


def _want_doh(host):
    return isinstance(host, str) and DOH_SUFFIX and any(
        host.lower().rstrip(".") == d or host.lower().rstrip(".").endswith("." + d) for d in DOH_SUFFIX)


def _gai(host, port, family=0, type=0, proto=0, flags=0):
    if _want_doh(host):
        h = host.lower().rstrip(".")
        with _DOH_LOCK:
            ent = _DOH.get(h)
            if not ent or ent[1] < time.time():
                ips, via = _doh_lookup(h)
                if ips:
                    _DOH[h] = ent = (ips, time.time() + 600)
                    LAST_DNS[h] = f"{ips[0]} lewat DNS aman {via}"
                elif ent is None:
                    LAST_DNS[h] = "DNS aman tidak bisa dihubungi, pakai DNS biasa"
        if ent:
            out = []
            for ip in ent[0]:
                try:
                    out += _orig_gai(ip, port, socket.AF_INET, type, proto, flags)
                except OSError:
                    pass
            if out:
                return out
    return _orig_gai(host, port, family, type, proto, flags)


if os.environ.get("KLIPKU_NO_DOH") != "1" and getattr(socket.getaddrinfo, "__name__", "") != "_gai":
    socket.getaddrinfo = _gai


class NetError(Exception):
    def __init__(self, msg, status=None, body=None):
        super().__init__(msg)
        self.status, self.body = status, body


def request(method, url, data=None, headers=None, timeout=60, raw=False):
    headers = dict(headers or {})
    # Cloudflare memblokir User-Agent bawaan Python ("Python-urllib") dengan error 1010
    if not any(k.lower() == "user-agent" for k in headers):
        headers["User-Agent"] = UA
    body = None
    if data is not None and not isinstance(data, (bytes, bytearray)) and not hasattr(data, "read"):
        body = json.dumps(data).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    else:
        body = data
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = r.read()
            if raw:
                return out
            try:
                return json.loads(out.decode("utf-8") or "{}")
            except ValueError:
                return {"_text": out.decode("utf-8", "replace")}
    except urllib.error.HTTPError as ex:
        txt = ex.read().decode("utf-8", "replace")
        try:
            js = json.loads(txt)
        except ValueError:
            js = None
        raise NetError(f"HTTP {ex.code}: {txt[:400]}", ex.code, js if js is not None else txt)
    except urllib.error.URLError as ex:
        raise NetError(f"Tidak bisa terhubung: {ex.reason}")
    except TimeoutError:
        raise NetError("Koneksi timeout")
    except OSError as ex:
        raise NetError(f"Koneksi gagal: {ex}")


def retry(fn, tries=3, wait=3.0, on_retry=None):
    last = None
    for i in range(tries):
        try:
            return fn()
        except NetError as ex:
            last = ex
            if ex.status and 400 <= ex.status < 500 and ex.status != 429:
                raise
            if on_retry:
                on_retry(i + 1, ex)
            time.sleep(wait * (i + 1) * (3 if ex.status == 429 else 1))
    raise last


class _Multipart:
    """Body multipart yang dibaca bertahap (file besar tidak dimuat ke RAM)."""

    def __init__(self, fields, files):
        self.boundary = "----klipku" + uuid.uuid4().hex
        self.parts = []
        b = self.boundary.encode()
        for name, value in fields:
            self.parts.append(b"--" + b + b"\r\n" + f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
                              + str(value).encode("utf-8") + b"\r\n")
        for name, path_or_bytes, filename, ctype in files:
            ctype = ctype or mimetypes.guess_type(filename)[0] or "application/octet-stream"
            head = (b"--" + b + b"\r\n" + f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                    f"Content-Type: {ctype}\r\n\r\n".encode())
            self.parts.append(head)
            self.parts.append(path_or_bytes if isinstance(path_or_bytes, (bytes, bytearray)) else ("file", path_or_bytes))
            self.parts.append(b"\r\n")
        self.parts.append(b"--" + b + b"--\r\n")
        self.length = sum(len(p) if isinstance(p, (bytes, bytearray)) else os.path.getsize(p[1]) for p in self.parts)
        self._i, self._fh = 0, None

    def read(self, n=-1):
        out = b""
        while (n < 0 or len(out) < n) and self._i < len(self.parts):
            p = self.parts[self._i]
            if isinstance(p, (bytes, bytearray)):
                out += bytes(p)
                self._i += 1
            else:
                if self._fh is None:
                    self._fh = open(p[1], "rb")
                chunk = self._fh.read(1 << 20 if n < 0 else max(1, n - len(out)))
                if not chunk:
                    self._fh.close()
                    self._fh = None
                    self._i += 1
                else:
                    out += chunk
        return out


def multipart(url, fields, files, headers=None, timeout=600, method="POST"):
    mp = _Multipart(fields, files)
    h = dict(headers or {})
    h["Content-Type"] = f"multipart/form-data; boundary={mp.boundary}"
    h["Content-Length"] = str(mp.length)
    return request(method, url, data=mp, headers=h, timeout=timeout)


def put_file(url, path, content_type, timeout=1800):
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        return request("PUT", url, data=fh, headers={"Content-Type": content_type, "Content-Length": str(size)},
                       timeout=timeout, raw=True)
