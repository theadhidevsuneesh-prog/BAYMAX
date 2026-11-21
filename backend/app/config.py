"""Central configuration for the BAYMAX backend."""
from __future__ import annotations

import os
from pathlib import Path

# The server only listens on this machine.
HOST = "127.0.0.1"
PORT = int(os.environ.get("BAYMAX_PORT", "8765"))

# Where BAYMAX keeps its long-term memory (SQLite) - per-user, no cloud.
APP_DIR = Path(
    os.environ.get("BAYMAX_DATA_DIR")
    or (Path(os.environ.get("APPDATA") or Path.home()) / "BAYMAX")
)
APP_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = APP_DIR / "baymax_memory.db"

# Default folder for relative paths used by file tools. Anything outside it
# counts as "outside workspace" for the permission gate.
WORKSPACE = Path(
    os.environ.get("BAYMAX_WORKSPACE") or (Path.home() / "Documents" / "BAYMAX Workspace")
)
WORKSPACE.mkdir(parents=True, exist_ok=True)

# Where the local Ollama server lives.
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")

# When set (Electron does this), every REST/WebSocket call must carry the token
# so random web pages cannot drive the local agent.
AUTH_TOKEN = os.environ.get("BAYMAX_TOKEN", "")

# The free local brain used by default; no API key is ever required.
DEFAULT_MODEL = "qwen2.5:7b"
MODELS = [
    {"name": "qwen2.5:7b", "label": "Qwen 2.5 7B", "note": "Recommended - 6GB+ GPU", "size": "~4.7 GB"},
    {"name": "qwen2.5:3b", "label": "Qwen 2.5 3B", "note": "Lightweight - low RAM / CPU", "size": "~1.9 GB"},
    {"name": "qwen3:8b", "label": "Qwen 3 8B", "note": "Strongest - 8GB+ GPU", "size": "~5.2 GB"},
]

# Limits for one conversation turn: how many tool calls in a row, how much history is replayed,
# how much of a tool result is stored, and how long a permission prompt waits.
MAX_TOOL_STEPS = 8
HISTORY_MESSAGES = 20  # raw rows (incl. tool calls/results) replayed to the model
TOOL_RESULT_KEEP_CHARS = 800  # tool results are trimmed when stored for replay
PERMISSION_TIMEOUT_S = 120
