@echo off
chcp 65001 >nul
cd /d "%~dp0"
title KlipKu - biarkan jendela ini terbuka
if not exist ".venv\Scripts\python.exe" (
  echo Jalankan 1-INSTALL-Windows.bat dulu.
  pause
  exit /b 1
)
echo Mengecek komponen (pertama kali setelah update bisa 1-3 menit)...
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt 2>nul
".venv\Scripts\python.exe" -m pip install -q -U "yt-dlp[default]" 2>nul
where nvidia-smi >nul 2>nul
if not errorlevel 1 (
  ".venv\Scripts\python.exe" -c "import nvidia.cublas, nvidia.cudnn" >nul 2>nul
  if errorlevel 1 (
    echo GPU NVIDIA terdeteksi. Memasang komponen GPU untuk subtitle cepat - sekali saja, sekitar 1 GB, sabar ya...
    ".venv\Scripts\python.exe" -m pip install -q nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"
  )
)
".venv\Scripts\python.exe" app.py
pause
