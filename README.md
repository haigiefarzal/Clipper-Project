# 🎬 Clipper Project: KlipKu

**Link YouTube / Twitch + menit mulai/selesai → clip siap upload.**

KlipKu adalah aplikasi clipper yang jalan di komputer kamu sendiri. Tempel link VOD YouTube atau Twitch (VOD maupun clip), pilih menitnya, dan KlipKu membuat clip vertikal (9:16), landscape (16:9), atau kotak (1:1) lengkap dengan subtitle otomatis, judul hook, kamera AI, dan watermark, tanpa perlu edit manual.

![Versi](https://img.shields.io/badge/versi-2.3-ff3d7f)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)
![Python](https://img.shields.io/badge/python-3.10%2B-yellow)
![Lisensi](https://img.shields.io/badge/lisensi-MIT-green)

---

## 🚀 Dua cara pakai

| | 🌐 **KlipKu Web** | 💻 **KlipKu PC** |
|---|---|---|
| Buka | **https://haigiefarzal.github.io/Clipper-Project/** | Download & install (lihat di bawah) |
| Sumber video | Upload file video | Tempel link YouTube / Twitch langsung |
| Install | Tidak perlu | Sekali, otomatis |
| Diproses di | Browser kamu (GPU lewat WebGPU/WebCodecs) | Komputer kamu (FFmpeg + Whisper) |
| Fitur | Semua fitur PC kecuali link YouTube/Twitch dan sound effect bawaan (upload SFX sendiri) | Semua fitur |

KlipKu Web jalan di **Chrome, Edge, atau Safari terbaru**, termasuk di iPhone dan Android. Video tidak di-upload ke server mana pun. Subtitle jalan tanpa kunci API (model Whisper di browser), atau pakai kunci Groq milikmu sendiri supaya lebih cepat.

---

## ✨ Fitur

| Fitur | Keterangan |
|---|---|
| 🟣 **YouTube & Twitch** *(PC)* | Link YouTube, VOD Twitch (`twitch.tv/videos/...`), atau clip Twitch; kredit `twitch.tv/nama` otomatis |
| 📐 **3 rasio** | 9:16, 16:9, 1:1, zoom dan geser bebas, area kosong otomatis di-blur |
| 🤖 **AI Kamera** | Kamera otomatis mengikuti siapa yang bicara/bereaksi, lalu balik ke karakter utama |
| 🎮 **Facecam + Gameplay** | Facecam besar di atas, gameplay di bawah (khusus 9:16) |
| 💬 **Subtitle otomatis** | Whisper (`large-v3-turbo` / `large-v3`), "kata khusus", kamus ganti, cek & edit sebelum render |
| 🧠 **Koreksi AI (opsional)** | Gemini ikut mendengarkan audio lalu membetulkan kata yang salah dengar |
| 🪝 **Judul hook & intro** | 5 template (Kutipan, Kotak per baris, Label, Strip, Polos), posisi bebas (tarik di preview), sorot `*kata*`, intro dari momen puncak, efek kilat atau rewind |
| ✨ **Judul hook dari AI** | Gemini/Claude kasih 3 pilihan judul, caption + hashtag, dan momen puncak dari isi clip |
| 🔊 **Sound effect & musik** | SFX di awal/akhir/saat diulang/menit tertentu/saat kata diucapkan/tiap zoom kejut, volume disamakan otomatis, musik latar yang mengecil saat ada suara |
| 💥 **Efek tambahan** | Zoom kejut di momen heboh, potong jeda (jump cut), progress bar, teks penutup, volume disamakan ke -14 LUFS, cover JPG |
| 📢 **Banner program/sponsor** | Strip di atas video: teks + logo, atau gambar PNG jadi |
| 🎨 **Gaya tersimpan** | Simpan semua pengaturan dengan nama (misal per channel) |
| 💧 **Watermark 5 gaya** | Pojok, diagonal, pola berulang, pindah-pindah pojok, di belakang video + logo PNG |
| 🔤 **21 font bawaan** | Plus semua font yang ter-install di komputer kamu |
| ⚡ **Render cepat** | Otomatis pakai GPU (NVIDIA/Intel/AMD/Apple), fallback ke CPU kalau gagal |

---

## 📥 Download versi PC

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

1. Tempel link VOD YouTube / Twitch (atau clip Twitch) → **Muat**.
2. Isi menit **Mulai** & **Selesai** (+ judul hook kalau mau).
3. Pilih rasio dan mode kamera (Tengah / AI Kamera / Facecam + Gameplay).
4. Atur subtitle, isi **Kata khusus** dengan nama penting (contoh: `Windah Basudara, UTBK`) supaya lebih akurat.
5. Pilih template judul hook (tarik posisinya di preview), lalu watermark, logo, banner, sound effect, dan efek tambahan.
6. Klik **Buat Clip**. Hasilnya ada di folder **`hasil/`**.

📖 Panduan lengkap (termasuk tips & troubleshooting): **[CARA-PAKAI.txt](CARA-PAKAI.txt)**

---

## 📁 Struktur folder

```
├── app.py                  # Server lokal + alur kerja utama
├── engine_camera.py        # AI Kamera (deteksi wajah & pembicara)
├── engine_subs.py          # Subtitle (Whisper) + koreksi AI + judul AI
├── engine_hook.py          # Template judul hook, banner, progress bar, teks penutup
├── engine_audio.py         # Sound effect, musik, zoom kejut, potong jeda, volume
├── engine_fonts.py         # Pengelola font
├── web/index.html          # Tampilan aplikasi PC
├── docs/                   # KlipKu Web (GitHub Pages): Mediabunny + Transformers.js + YuNet
├── fonts/                  # 21 font bawaan (SIL OFL 1.1) + lisensinya
│   └── tambahan/           # Taruh font kamu sendiri di sini
├── models/                 # Model deteksi wajah YuNet (ONNX)
├── sfx/                    # Sound effect kamu (tidak ikut ke GitHub)
├── musik/                  # Musik latar kamu (tidak ikut ke GitHub)
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
- Untuk monetisasi, beri nilai tambah (hook, subtitle, editing), jangan sekadar re-upload.
- API key (Gemini, dll.) hanya disimpan di komputer kamu sendiri (`work/settings.json`).

---

## 📜 Lisensi

Kode KlipKu dirilis dengan lisensi **[MIT](LICENSE)**, bebas dipakai, diubah, dan dibagikan.

Font bawaan berlisensi **SIL Open Font License 1.1** (lihat [`fonts/lisensi/`](fonts/lisensi)). Model deteksi wajah YuNet berasal dari [OpenCV Zoo](https://github.com/opencv/opencv_zoo).
