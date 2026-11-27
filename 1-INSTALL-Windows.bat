@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Instalasi KlipKu
echo ==================================================
echo   INSTALASI KLIPKU  -  cukup sekali
echo ==================================================
echo.

where winget >nul 2>nul
if errorlevel 1 (
  echo [X] winget tidak ditemukan.
  echo     Buka Microsoft Store, cari "App Installer", klik Update/Install, lalu jalankan file ini lagi.
  pause
  exit /b 1
)

set NEED_RESTART=0

py -3 --version >nul 2>nul
if errorlevel 1 (
  echo [1/3] Memasang Python...
  winget install -e --id Python.Python.3.12 --scope user --accept-source-agreements --accept-package-agreements
  set NEED_RESTART=1
) else (
  echo [1/3] Python sudah ada.
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [2/3] Memasang FFmpeg...
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
  set NEED_RESTART=1
) else (
  echo [2/3] FFmpeg sudah ada.
)

where deno >nul 2>nul
if errorlevel 1 (
  echo [3/3] Memasang Deno...
  winget install -e --id DenoLand.Deno --accept-source-agreements --accept-package-agreements
  set NEED_RESTART=1
) else (
  echo [3/3] Deno sudah ada.
)

where cloudflared >nul 2>nul
if errorlevel 1 if not exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" (
  echo [+] Memasang cloudflared ^(untuk tombol Sambungkan HP^)...
  winget install -e --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
)

py -3 --version >nul 2>nul
if errorlevel 1 goto restart

echo.
echo Memasang komponen KlipKu (yt-dlp + Whisper). Bisa beberapa menit...
if not exist ".venv\Scripts\python.exe" py -3 -m venv .venv
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -U -r requirements.txt
if errorlevel 1 (
  echo.
  echo [X] Gagal memasang komponen. Cek koneksi internet lalu jalankan file ini lagi.
  pause
  exit /b 1
)

if "%NEED_RESTART%"=="1" goto restart

echo.
echo ==================================================
echo   SELESAI! Sekarang klik dua kali: 2-BUKA-KlipKu-Windows.bat
echo ==================================================
pause
exit /b 0

:restart
echo.
echo ==================================================
echo   Program baru saja dipasang.
echo   TUTUP jendela ini, lalu klik dua kali
echo   1-INSTALL-Windows.bat SEKALI LAGI untuk menyelesaikan.
echo ==================================================
pause
exit /b 0
