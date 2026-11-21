"""Voice: local speech-to-text (faster-whisper) and text-to-speech (Piper). Nothing leaves this PC.

Models are downloaded once, on request, into %APPDATA%\\BAYMAX\\models. All imports are lazy so the
backend still starts when the voice packages are missing.
"""
from __future__ import annotations

import asyncio
import io
import threading
import wave
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from .config import APP_DIR

# Speech models live in the user's data folder, downloaded once (about 200 MB in total).
MODELS_DIR = APP_DIR / "models"
WHISPER_DIR = MODELS_DIR / "whisper"
PIPER_DIR = MODELS_DIR / "piper"

STT_MODEL = "base.en"
STT_APPROX_BYTES = 150 * 1024 * 1024
VOICE_ID = "en_US-lessac-medium"
VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/"
VOICE_ONNX = PIPER_DIR / f"{VOICE_ID}.onnx"
VOICE_JSON = PIPER_DIR / f"{VOICE_ID}.onnx.json"
STT_MARK = WHISPER_DIR / "ready.txt"

# Callback used to report download progress to the UI.
Progress = Callable[[dict[str, Any]], Awaitable[None]]

# The loaded speech models are cached here (loading is slow, so it happens once).
_stt = None
_tts = None
_lock = threading.Lock()
_setup_task: asyncio.Task | None = None


class VoiceError(RuntimeError):
    pass


# Are the voice libraries installed? (Imports are lazy so BAYMAX still starts without them.)
def packages_ok() -> bool:
    try:
        import faster_whisper  # noqa: F401
        import numpy  # noqa: F401
        import piper  # noqa: F401
        return True
    except Exception:
        return False


# What is installed / downloaded; the UI uses this to decide whether voice can be switched on.
def status() -> dict[str, Any]:
    return {
        "packages": packages_ok(),
        "stt_ready": STT_MARK.exists(),
        "tts_ready": VOICE_ONNX.exists() and VOICE_JSON.exists(),
        "stt_model": STT_MODEL,
        "voice": VOICE_ID,
        "setting_up": bool(_setup_task and not _setup_task.done()),
    }


def ready() -> bool:
    s = status()
    return s["packages"] and s["stt_ready"] and s["tts_ready"]


# ───────────────────────────────────────────────────────────── one-time setup (downloads)
# Download a file to a ".part" name first, so an interrupted download never looks complete.
async def _download(url: str, dest: Path, on_bytes: Callable[[int], Awaitable[None]]) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(None, connect=15.0)) as client:
        async with client.stream("GET", url) as resp:
            if resp.status_code != 200:
                raise VoiceError(f"Download failed ({resp.status_code}) for {dest.name}")
            done = 0
            with open(tmp, "wb") as f:
                async for chunk in resp.aiter_bytes(1 << 16):
                    f.write(chunk)
                    done += len(chunk)
                    await on_bytes(done)
    tmp.replace(dest)


def _dir_size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0


# Load Whisper (speech to text) on the CPU in a compact 8-bit form.
def _load_stt():
    global _stt
    with _lock:
        if _stt is None:
            from faster_whisper import WhisperModel
            WHISPER_DIR.mkdir(parents=True, exist_ok=True)
            _stt = WhisperModel(STT_MODEL, device="cpu", compute_type="int8", cpu_threads=8, download_root=str(WHISPER_DIR))
        return _stt


# Load the Piper neural voice (text to speech).
def _load_tts():
    global _tts
    with _lock:
        if _tts is None:
            from piper import PiperVoice
            _tts = PiperVoice.load(VOICE_ONNX, config_path=VOICE_JSON)
        return _tts


async def setup(progress: Progress) -> None:
    """Download the speech models if needed. Reports {stage, pct, done, error} via `progress`."""
    global _setup_task
    if _setup_task and not _setup_task.done():
        return
    _setup_task = asyncio.current_task()
    try:
        if not packages_ok():
            raise VoiceError("Voice packages are missing. Run 'npm run setup' again, or reinstall BAYMAX.")
        if not (VOICE_ONNX.exists() and VOICE_JSON.exists()):
            await progress({"stage": "Downloading BAYMAX's voice", "pct": 0, "done": False})
            total_guess = 64 * 1024 * 1024
            last = {"p": -1}

            async def on_bytes(n: int) -> None:
                p = min(99, int(n / total_guess * 100))
                if p != last["p"]:
                    last["p"] = p
                    await progress({"stage": "Downloading BAYMAX's voice", "pct": p, "done": False})

            await _download(VOICE_BASE + VOICE_JSON.name, VOICE_JSON, lambda n: asyncio.sleep(0))
            await _download(VOICE_BASE + VOICE_ONNX.name, VOICE_ONNX, on_bytes)
        if not STT_MARK.exists():
            await progress({"stage": "Downloading the listening model", "pct": 0, "done": False})
            task = asyncio.create_task(asyncio.to_thread(_load_stt))
            shown = -1
            while not task.done():
                await asyncio.sleep(0.6)
                pct = min(97, int(_dir_size(WHISPER_DIR) / STT_APPROX_BYTES * 100))
                if pct != shown:
                    shown = pct
                    await progress({"stage": "Downloading the listening model", "pct": pct, "done": False})
            await task
            STT_MARK.write_text("ok")
        await progress({"stage": "Warming up", "pct": 99, "done": False})
        await asyncio.to_thread(_load_tts)
        await progress({"stage": "Ready", "pct": 100, "done": True})
    except Exception as exc:
        await progress({"stage": "Setup failed", "pct": 0, "done": True, "error": str(exc)[:300]})
    finally:
        _setup_task = None


# ───────────────────────────────────────────────────────────── speech to text / text to speech
# Whisper hears best when it is told the wake word, hence the initial_prompt.
def transcribe(pcm16: bytes) -> str:
    """16 kHz mono signed-16-bit PCM -> text. Returns '' for silence/noise."""
    import numpy as np

    if len(pcm16) < 3200:  # < 0.1 s
        return ""
    audio = np.frombuffer(pcm16[: len(pcm16) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768.0
    model = _load_stt()
    segments, _ = model.transcribe(
        audio, language="en", beam_size=1, vad_filter=True, condition_on_previous_text=False,
        initial_prompt="BAYMAX. Hey BAYMAX, what's the time?", temperature=0.0,
    )
    parts = [s.text.strip() for s in segments if getattr(s, "no_speech_prob", 0) < 0.6]
    return " ".join(p for p in parts if p).strip()


def synthesize(text: str) -> bytes:
    """Text -> WAV bytes."""
    voice = _load_tts()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize_wav(text, wf)
    return buf.getvalue()
