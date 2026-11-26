#!/bin/bash
cd "$(dirname "$0")"
echo "=================================================="
echo "  INSTALASI KLIPKU  -  cukup sekali"
echo "=================================================="
if ! command -v brew >/dev/null 2>&1; then
  echo "[X] Homebrew belum terpasang."
  echo "    Buka https://brew.sh, salin perintah instalasinya ke Terminal, lalu jalankan file ini lagi."
  read -p "Tekan Enter untuk menutup..."
  exit 1
fi
echo "[1/2] Memasang Python, FFmpeg, Deno..."
brew install python ffmpeg deno
echo "[2/2] Memasang komponen KlipKu (yt-dlp + Whisper)..."
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -U -r requirements.txt || { echo "[X] Gagal. Cek internet lalu ulangi."; read -p "Enter..."; exit 1; }
chmod +x "2-BUKA-KlipKu-Mac.command"
echo
echo "SELESAI! Sekarang klik dua kali: 2-BUKA-KlipKu-Mac.command"
read -p "Tekan Enter untuk menutup..."
