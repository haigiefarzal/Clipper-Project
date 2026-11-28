# Riwayat perubahan KlipKu

## 4.0 (29 November 2026)
**Preview hasil yang bisa diputar (sebelum Buat Clip)**
- Layar preview di kanan punya tombol **▶** besar: clip diputar seperti video jadi, lengkap dengan layout (tengah / facecam), judul hook sesuai waktu tampilnya, intro + efek kilat, watermark, logo, banner, progress bar, dan teks penutup.
- Saat diputar: putar/jeda (spasi), geser ke detik mana saja, pilih clip (kalau lebih dari satu), tarik judul hook. Pengaturan yang diubah di kiri langsung terlihat sambil video jalan. Tombol Awal/Akhir = lompat ke hook / teks penutup.
- Potongan clip diunduh kecil (480p) ke `work/<video>/pratinjau/` (maksimal 12 per video, yang lama dibuang otomatis).

**Lainnya**
- Autopilot: daftar gaya tersimpan langsung terkirim ke bot walau laptop sedang menganalisis.
- Autopilot: sambungan ke otak cloud memakai identitas KlipKu (Cloudflare menolak identitas bawaan Python, error 1010) + DNS aman khusus `workers.dev`.
- `.gitignore` ditambah: file rahasia lokal (`.env`, `.claude/settings.local.json`) dan log.

## 3.0 (27 November 2026)
- **Autopilot + bot Telegram**: otak gratis di Cloudflare Workers + D1 (bot, pantau channel YouTube tiap 5 menit, antrean, kuota & jadwal, rekap harian), laptop sebagai tangan (cari momen dari chat/suara/subtitle + Gemini, render, upload TikTok lewat Zernio setelah ✅). Panduan: `CARA-PAKAI-AUTOPILOT.txt`.

## 2.4
- **Sambungkan HP**: KlipKu Web di HP bisa minta KlipKu PC mengunduh potongan YouTube/Twitch lewat Cloudflare Tunnel + kunci rahasia.

## 2.3
- Dukungan **Twitch**: VOD (`twitch.tv/videos/...`) dan clip, kredit `twitch.tv/nama` otomatis.

## 2.2
- 5 template judul hook (Kutipan, Kotak per baris, Label, Strip, Polos), posisi bebas (tarik di preview).
- Sound effect & musik latar, zoom kejut, potong jeda, progress bar, teks penutup, volume -14 LUFS, cover JPG, banner, gaya tersimpan.
