"""Thin async client for the local Ollama REST API."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, AsyncIterator

import httpx

from .config import MODELS, OLLAMA_URL


# Any problem talking to a model; the message is written to be shown to the user as-is.
class OllamaError(RuntimeError):
    pass


# Locate ollama.exe on PATH or in its usual install folders.
def find_cli() -> str | None:
    found = shutil.which("ollama")
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA")
    candidates = [Path(local) / "Programs" / "Ollama" / "ollama.exe"] if local else []
    candidates.append(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Ollama" / "ollama.exe")
    for c in candidates:
        if c.exists():
            return str(c)
    return None


# Is Ollama running, which version, and which of BAYMAX's recommended models are installed?
async def status() -> dict[str, Any]:
    info: dict[str, Any] = {
        "running": False, "version": None, "installed": [], "cli_found": find_cli() is not None,
        "models": [],
    }
    try:
        async with httpx.AsyncClient(timeout=2.5) as client:
            v = await client.get(f"{OLLAMA_URL}/api/version")
            v.raise_for_status()
            info["running"] = True
            info["version"] = v.json().get("version")
            tags = await client.get(f"{OLLAMA_URL}/api/tags")
            info["installed"] = [m["name"] for m in tags.json().get("models", [])]
    except Exception:
        pass
    installed = set(info["installed"])
    info["models"] = [
        {**m, "installed": m["name"] in installed or f"{m['name']}:latest" in installed} for m in MODELS
    ]
    return info


# Start `ollama serve` in the background with no console window.
def start_server() -> bool:
    cli = find_cli()
    if not cli:
        return False
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    subprocess.Popen([cli, "serve"], creationflags=flags, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    return True


# Stream one model reply from Ollama. Yields chunks like {"message": {"content": ...}} or tool calls.
async def chat_stream(model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": {"temperature": 0.4, "num_ctx": 8192},
        "keep_alive": "15m",
    }
    if tools:
        payload["tools"] = tools
    # Qwen 3 can "think" out loud first; turned off so answers stay fast and clean.
    if model.startswith("qwen3"):
        payload["think"] = False  # keep answers fast and out of <think> blocks
    timeout = httpx.Timeout(600.0, connect=4.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{OLLAMA_URL}/api/chat", json=payload) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    try:
                        body = json.loads(body).get("error", body)
                    except ValueError:
                        pass
                    if resp.status_code == 404 or "not found" in body.lower():
                        raise OllamaError(f"Model '{model}' is not installed yet. Open the model panel and press PULL.")
                    if "does not support tools" in body.lower():
                        raise OllamaError(f"Model '{model}' does not support tool calling. Pick a Qwen model.")
                    raise OllamaError(f"Ollama error ({resp.status_code}): {body[:300]}")
                async for line in resp.aiter_lines():
                    if line.strip():
                        chunk = json.loads(line)
                        if "error" in chunk:
                            raise OllamaError(str(chunk["error"]))
                        yield chunk
    except httpx.ConnectError as exc:
        raise OllamaError("Ollama is not running. Start Ollama (or press START OLLAMA in the model panel).") from exc


# Download a model, yielding progress chunks (used by the Pull buttons).
async def pull_stream(model: str) -> AsyncIterator[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=4.0)) as client:
        try:
            async with client.stream("POST", f"{OLLAMA_URL}/api/pull", json={"model": model, "stream": True}) as resp:
                if resp.status_code != 200:
                    raise OllamaError((await resp.aread()).decode("utf-8", "replace")[:300])
                async for line in resp.aiter_lines():
                    if line.strip():
                        chunk = json.loads(line)
                        if "error" in chunk:
                            raise OllamaError(str(chunk["error"]))
                        yield chunk
        except httpx.ConnectError as exc:
            raise OllamaError("Ollama is not running.") from exc
