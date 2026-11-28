"""Text-to-speech langsung lewat API ElevenLabs (tanpa MCP).

API key dibaca dari environment variable ELEVENLABS_API_KEY.

Contoh:
    python elevenlabs_tts.py "Halo, selamat datang di KlipKu!"
    python elevenlabs_tts.py --file naskah.txt --out hasil/voiceover/intro.mp3
    python elevenlabs_tts.py --list-voices
    python elevenlabs_tts.py "Tes suara" --voice <voice_id>
"""

import argparse
import os
import sys
import time
from pathlib import Path

import requests

API_BASE = "https://api.elevenlabs.io/v1"
DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"  # "George" — ganti via --voice
DEFAULT_MODEL = "eleven_multilingual_v2"  # mendukung Bahasa Indonesia
DEFAULT_OUT_DIR = Path(__file__).parent / "hasil" / "voiceover"


def get_api_key() -> str:
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        sys.exit(
            "ELEVENLABS_API_KEY belum diset.\n"
            'Jalankan: setx ELEVENLABS_API_KEY "API_KEY_LU" lalu buka terminal baru.'
        )
    return key


def check_response(resp: requests.Response) -> None:
    if resp.ok:
        return
    try:
        detail = resp.json().get("detail", resp.text)
    except ValueError:
        detail = resp.text
    sys.exit(f"Error dari ElevenLabs ({resp.status_code}): {detail}")


def list_voices(key: str) -> None:
    resp = requests.get(f"{API_BASE}/voices", headers={"xi-api-key": key}, timeout=30)
    check_response(resp)
    for v in resp.json().get("voices", []):
        labels = v.get("labels") or {}
        info = ", ".join(str(x) for x in (labels.get("gender"), labels.get("accent")) if x)
        print(f"{v['voice_id']}  {v['name']}" + (f"  ({info})" if info else ""))


def synthesize(key: str, text: str, voice: str, model: str, out: Path) -> Path:
    resp = requests.post(
        f"{API_BASE}/text-to-speech/{voice}",
        params={"output_format": "mp3_44100_128"},
        headers={"xi-api-key": key, "Content-Type": "application/json"},
        json={"text": text, "model_id": model},
        timeout=120,
    )
    check_response(resp)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(resp.content)
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="TTS ElevenLabs untuk KlipKu")
    p.add_argument("text", nargs="?", help="teks yang mau dibacakan")
    p.add_argument("--file", help="baca teks dari file .txt")
    p.add_argument("--voice", default=DEFAULT_VOICE, help="voice_id (lihat --list-voices)")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--out", help="path file .mp3 hasil")
    p.add_argument("--list-voices", action="store_true", help="tampilkan daftar suara")
    args = p.parse_args()

    key = get_api_key()
    if args.list_voices:
        list_voices(key)
        return

    if args.file:
        text = Path(args.file).read_text(encoding="utf-8").strip()
    else:
        text = (args.text or "").strip()
    if not text:
        p.error("isi teks atau pakai --file")

    out = Path(args.out) if args.out else DEFAULT_OUT_DIR / f"tts_{time.strftime('%Y%m%d_%H%M%S')}.mp3"
    print(f"Tersimpan: {synthesize(key, text, args.voice, args.model, out)}")


if __name__ == "__main__":
    main()
