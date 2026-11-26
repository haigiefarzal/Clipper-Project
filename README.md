# 🎬 Clipper Project — KlipKu

**Link YouTube + menit mulai/selesai → clip siap upload.**

KlipKu adalah aplikasi clipper yang jalan di komputer kamu sendiri. Tempel link VOD YouTube, pilih menitnya, dan KlipKu membuat clip vertikal (9:16), landscape (16:9), atau kotak (1:1) lengkap dengan subtitle otomatis, judul hook, kamera AI, dan watermark — tanpa perlu edit manual.

![Versi](https://img.shields.io/badge/versi-2.1-ff3d7f)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)
![Python](https://img.shields.io/badge/python-3.10%2B-yellow)
![Lisensi](https://img.shields.io/badge/lisensi-MIT-green)

---

## ✨ Fitur

| Fitur | Keterangan |
|---|---|
| 📐 **3 rasio** | 9:16, 16:9, 1:1 — zoom & geser bebas, area kosong otomatis di-blur |
| 🤖 **AI Kamera** | Kamera otomatis mengikuti siapa yang bicara/bereaksi, lalu balik ke karakter utama |
| 🎮 **Facecam + Gameplay** | Facecam besar di atas, gameplay di bawah (khusus 9:16) |
| 💬 **Subtitle otomatis** | Whisper (`large-v3-turbo` / `large-v3`), "kata khusus", kamus ganti, cek & edit sebelum render |
| 🧠 **Koreksi AI (opsional)** | Gemini ikut mendengarkan audio lalu membetulkan kata yang salah dengar |
| 🪝 **Judul hook & intro** | Bingkai putih/hitam/polos, intro dari momen puncak, efek kilat atau rewind |
| 💧 **Watermark 5 gaya** | Pojok, diagonal, pola berulang, pindah-pindah pojok, di belakang video + logo PNG |
| 🔤 **21 font bawaan** | Plus semua font yang ter-install di komputer kamu |
| ⚡ **Render cepat** | Otomatis pakai GPU (NVIDIA/Intel/AMD/Apple), fallback ke CPU kalau gagal |

---

## 📥 Download

🌐 **Website:** https://haigiefarzal.github.io/Clipper-Project/

1. Download **[KlipKu.zip](https://github.com/haigiefarzal/Clipper-Project/releases/latest/download/KlipKu.zip)** dari halaman [Releases](https://github.com/haigiefarzal/Clipper-Project/releases).
2. Ekstrak ZIP-nya ke folder mana saja (misal `Downloads`).

Atau lewat Git:

```bash
git clone https://github.com/haigiefarzal/Clipper-Project.git
```

---

## 🛠️ Instalasi (cukup sekali)

### Windows
1. Buka folder hasil ekstrak, klik dua kali **`1-INSTALL-Windows.bat`**.
2. Installer otomatis memasang **Python, FFmpeg, dan Deno** (lewat `winget`) lalu komponen KlipKu.
3. Kalau diminta, tutup jendelanya lalu jalankan `1-INSTALL-Windows.bat` **sekali lagi**.

> Kalau muncul "winget tidak ditemukan": buka Microsoft Store, cari **App Installer**, klik Update/Install.

### macOS
1. Pasang [Homebrew](https://brew.sh) kalau belum ada.
2. Klik kanan **`1-INSTALL-Mac.command`** → **Open**.

---

## ▶️ Menjalankan

| OS | Cara buka |
|---|---|
| Windows | Klik dua kali **`2-BUKA-KlipKu-Windows.bat`** |
| macOS | Klik dua kali **`2-BUKA-KlipKu-Mac.command`** |

Browser akan terbuka otomatis di **http://127.0.0.1:8765**. Biarkan jendela hitam (terminal) tetap terbuka selama memakai KlipKu.

---

## 🚀 Cara pakai singkat

1. Tempel link VOD YouTube → **Muat**.
2. Isi menit **Mulai** & **Selesai** (+ judul hook kalau mau).
3. Pilih rasio dan mode kamera (Tengah / AI Kamera / Facecam + Gameplay).
4. Atur subtitle — isi **Kata khusus** dengan nama penting (contoh: `Windah Basudara, UTBK`) supaya lebih akurat.
5. Atur watermark, logo, dan hook.
6. Klik **Buat Clip**. Hasilnya ada di folder **`hasil/`**.

📖 Panduan lengkap (termasuk tips & troubleshooting): **[CARA-PAKAI.txt](CARA-PAKAI.txt)**

---

## 📁 Struktur folder

```
├── app.py                  # Server lokal + alur kerja utama
├── engine_camera.py        # AI Kamera (deteksi wajah & pembicara)
├── engine_subs.py          # Subtitle (Whisper) + koreksi AI
├── engine_fonts.py         # Pengelola font
├── web/index.html          # Tampilan aplikasi
├── fonts/                  # 21 font bawaan (SIL OFL 1.1) + lisensinya
│   └── tambahan/           # Taruh font kamu sendiri di sini
├── models/                 # Model deteksi wajah YuNet (ONNX)
├── requirements.txt        # Dependensi Python
├── 1-INSTALL-*.bat/.command
└── 2-BUKA-KlipKu-*.bat/.command
```

Folder `work/` (pengaturan & cache) dan `hasil/` (video jadi) dibuat otomatis saat aplikasi jalan dan **tidak** ikut di-upload.

---

## ❓ Kalau ada masalah

- **Kotak merah "Belum terpasang: ..."** → tutup KlipKu, buka lagi lewat `2-BUKA`.
- **Error download / 403 / "Sign in to confirm"** → tutup & buka lagi (yt-dlp update otomatis), atau tunggu 10–30 menit.
- **Font baru tidak muncul** → klik tombol ↻ di sebelah pencarian font.
- **Halaman tidak terbuka** → buka manual http://127.0.0.1:8765

---

## ⚠️ Etika pemakaian

- Clip hanya dari streamer/creator yang **mengizinkan**. Biarkan opsi **"Sumber: channel"** aktif.
- Untuk monetisasi, beri nilai tambah (hook, subtitle, editing) — jangan sekadar re-upload.
- API key (Gemini, dll.) hanya disimpan di komputer kamu sendiri (`work/settings.json`).

---

## 📜 Lisensi

Kode KlipKu dirilis dengan lisensi **[MIT](LICENSE)** — bebas dipakai, diubah, dan dibagikan.

Font bawaan berlisensi **SIL Open Font License 1.1** (lihat [`fonts/lisensi/`](fonts/lisensi)). Model deteksi wajah YuNet berasal dari [OpenCV Zoo](https://github.com/opencv/opencv_zoo).
