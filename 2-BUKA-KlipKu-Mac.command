#!/bin/bash
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then echo "Jalankan 1-INSTALL-Mac.command dulu."; read -p "Enter..."; exit 1; fi
echo "Mengecek komponen..."
.venv/bin/python -m pip install -q -r requirements.txt 2>/dev/null
.venv/bin/python -m pip install -q -U "yt-dlp[default]" 2>/dev/null
.venv/bin/python app.py
