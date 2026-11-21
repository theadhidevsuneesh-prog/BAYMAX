"""Model providers: local Ollama (default, free) plus optional cloud models with the user's own API key.

Every adapter speaks BAYMAX's internal (Ollama-style) message format and yields Ollama-style chunks:
    {"message": {"content": "..."}}                     text piece
    {"message": {"tool_calls": [{"function": {...}}]}}  tool calls
so the agent loop does not care which brain is plugged in.

API keys are encrypted with Windows DPAPI (bound to this Windows user) before they touch the database,
are never sent back to the UI, and are only ever sent to the provider they belong to.
"""
from __future__ import annotations

import base64
import ctypes
import json
import re
import uuid
from ctypes import wintypes
from typing import Any, AsyncIterator
from urllib.parse import urlparse

import httpx

from . import memory, ollama
from .config import DEFAULT_MODEL

# Same kind of friendly, user-readable error as OllamaError, so callers handle both alike.
ProviderError = type("ProviderError", (ollama.OllamaError,), {})

# ───────────────────────────────────────────────────────────── catalog
# Every brain BAYMAX can use. "kind" picks the adapter (how to talk to it); the model lists are
# just suggestions - the user can type any model name.
CATALOG: dict[str, dict[str, Any]] = {
    "ollama": {
        "label": "Local · Ollama", "kind": "ollama", "cloud": False, "needs_key": False,
        "note": "Free, private, runs on this PC. The default.", "models": [],
    },
    "anthropic": {
        "label": "Claude", "kind": "anthropic", "cloud": True, "needs_key": True,
        "base_url": "https://api.anthropic.com", "key_url": "https://console.anthropic.com/settings/keys",
        "note": "Anthropic Claude models.",
        "models": ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-fable-5-2"],
    },
    "gemini": {
        "label": "Gemini", "kind": "gemini", "cloud": True, "needs_key": True,
        "base_url": "https://generativelanguage.googleapis.com", "key_url": "https://aistudio.google.com/apikey",
        "note": "Google Gemini. Has a free tier.", "free_tier": True,
        "models": ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    },
    "openai": {
        "label": "OpenAI", "kind": "openai", "cloud": True, "needs_key": True,
        "base_url": "https://api.openai.com/v1", "key_url": "https://platform.openai.com/api-keys",
        "note": "OpenAI GPT models.", "models": ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    },
    "openrouter": {
        "label": "OpenRouter", "kind": "openai", "cloud": True, "needs_key": True,
        "base_url": "https://openrouter.ai/api/v1", "key_url": "https://openrouter.ai/keys",
        "note": "One key, hundreds of models. Some are free.", "free_tier": True,
        "models": ["meta-llama/llama-3.3-70b-instruct:free", "openai/gpt-4o-mini", "anthropic/claude-3.5-haiku"],
    },
    "groq": {
        "label": "Groq", "kind": "openai", "cloud": True, "needs_key": True,
        "base_url": "https://api.groq.com/openai/v1", "key_url": "https://console.groq.com/keys",
        "note": "Very fast. Has a free tier.", "free_tier": True,
        "models": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    },
    "custom": {
        "label": "Custom (OpenAI-compatible)", "kind": "openai", "cloud": True, "needs_key": False, "custom": True,
        "note": "Any OpenAI-compatible endpoint, e.g. LM Studio (http://localhost:1234/v1).", "models": [],
    },
}

# Model names must look like model names (blocks odd characters in URLs and payloads).
_MODEL_RE = re.compile(r"^[\w.:/@\-]{1,100}$")


# True for providers that send the conversation over the internet.
def is_cloud(pid: str) -> bool:
    return bool(CATALOG.get(pid, {}).get("cloud"))


# ───────────────────────────────────────────────────────────── key storage (Windows DPAPI)
# Windows DATA_BLOB structure used by the DPAPI calls below.
class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


# Encrypt (protect=True) or decrypt bytes with Windows DPAPI. Only the same Windows user on this PC can decrypt.
def _dpapi(data: bytes, protect: bool) -> bytes:
    try:
        crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32  # type: ignore[attr-defined]
    except AttributeError as exc:  # not Windows
        raise ProviderError("Secure key storage needs Windows.") from exc
    buf = ctypes.create_string_buffer(data, len(data))
    src = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    out = _Blob()
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    args = (ctypes.byref(src), None, None, None, None, 0, ctypes.byref(out)) if protect else \
        (ctypes.byref(src), None, None, None, None, 0, ctypes.byref(out))
    if not fn(*args):
        raise ProviderError("Could not access secure key storage.")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))


# Save an API key encrypted. It is never written in plain text and never sent back to the UI.
def set_key(pid: str, key: str) -> None:
    if pid not in CATALOG or not CATALOG[pid]["cloud"]:
        raise ValueError("unknown provider")
    key = (key or "").strip()
    if not re.fullmatch(r"[\x21-\x7e]{8,400}", key):
        raise ValueError("That doesn't look like an API key.")
    memory.set_setting(f"apikey:{pid}", base64.b64encode(_dpapi(key.encode(), True)).decode())


def clear_key(pid: str) -> None:
    memory.set_setting(f"apikey:{pid}", "")


# Decrypt a saved key (empty string if none).
def get_key(pid: str) -> str:
    raw = memory.get_setting(f"apikey:{pid}", "") or ""
    if not raw:
        return ""
    try:
        return _dpapi(base64.b64decode(raw), False).decode()
    except Exception:
        return ""


def has_key(pid: str) -> bool:
    return bool(memory.get_setting(f"apikey:{pid}", ""))


# Last 4 characters only, so the UI can show which key is saved without revealing it.
def key_hint(pid: str) -> str:
    k = get_key(pid)
    return f"…{k[-4:]}" if len(k) >= 8 else ""


# Server address for a provider (the custom provider's is user-defined).
def base_url(pid: str) -> str:
    if CATALOG[pid].get("custom"):
        return (memory.get_setting("base_url:custom", "") or "").rstrip("/")
    return CATALOG[pid].get("base_url", "").rstrip("/")


def set_base_url(url: str) -> None:
    url = (url or "").strip().rstrip("/")
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.netloc:
        raise ValueError("Enter a full URL like http://localhost:1234/v1")
    memory.set_setting("base_url:custom", url)


# Can this provider be used right now? (Ollama always; others need a key; custom needs a URL.)
def usable(pid: str) -> bool:
    c = CATALOG.get(pid)
    if not c:
        return False
    if pid == "ollama":
        return True
    if c.get("custom"):
        return bool(base_url(pid))
    return has_key(pid)


# Provider list for the Settings screen. Contains only hints, never the keys themselves.
def describe() -> list[dict[str, Any]]:
    out = []
    for pid, c in CATALOG.items():
        out.append({
            "id": pid, "label": c["label"], "cloud": c["cloud"], "needs_key": c["needs_key"],
            "note": c.get("note", ""), "models": c["models"], "key_url": c.get("key_url"),
            "free_tier": bool(c.get("free_tier")), "custom": bool(c.get("custom")),
            "has_key": has_key(pid), "key_hint": key_hint(pid) if has_key(pid) else "",
            "base_url": base_url(pid) if c.get("custom") else "",
            "usable": usable(pid), "model": saved_model(pid),
        })
    return out


# The model last chosen for this provider (or its first suggestion).
def saved_model(pid: str) -> str:
    if pid == "ollama":
        return memory.get_setting("model", DEFAULT_MODEL) or DEFAULT_MODEL
    c = CATALOG[pid]
    return memory.get_setting(f"model:{pid}", "") or (c["models"][0] if c["models"] else "")


def remember_model(pid: str, model: str) -> None:
    memory.set_setting("model" if pid == "ollama" else f"model:{pid}", model)


def valid_model(model: str) -> bool:
    return bool(_MODEL_RE.match(model or ""))


# ───────────────────────────────────────────────────────────── shared helpers
# Remove the API key from any error text before it can be shown or logged.
def _redact(text: str, key: str) -> str:
    return text.replace(key, "***") if key else text


# Turn an HTTP error from a provider into a short, helpful message (bad key, quota, wrong model, ...).
async def _fail(resp: httpx.Response, pid: str, model: str, key: str) -> ProviderError:
    body = (await resp.aread()).decode("utf-8", "replace")
    msg = body
    try:
        j = json.loads(body)
        err = j.get("error", j) if isinstance(j, dict) else j
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
    except ValueError:
        pass
    label = CATALOG[pid]["label"]
    code = resp.status_code
    if code in (401, 403):
        return ProviderError(f"{label} rejected the API key ({code}). Check the key in Settings.")
    if code == 429:
        return ProviderError(f"{label} says you're out of quota or rate-limited (429). {_redact(msg, key)[:160]}")
    if code == 404:
        return ProviderError(f"{label} doesn't know the model '{model}' (404).")
    return ProviderError(f"{label} error ({code}): {_redact(msg, key)[:300]}")


# Tool arguments arrive as a dict or a JSON string depending on the provider; always return a dict.
def _json_args(args: Any) -> dict[str, Any]:
    if isinstance(args, dict):
        return args
    try:
        v = json.loads(args or "{}")
        return v if isinstance(v, dict) else {}
    except ValueError:
        return {}


# Read a Server-Sent-Events stream ("data: {...}" lines) and yield each JSON event.
def _sse(resp: httpx.Response):
    async def gen() -> AsyncIterator[dict[str, Any]]:
        async for line in resp.aiter_lines():
            if line.startswith("data:"):
                data = line[5:].strip()
                if data and data != "[DONE]":
                    try:
                        yield json.loads(data)
                    except ValueError:
                        continue
    return gen()


_TIMEOUT = httpx.Timeout(120.0, connect=10.0)


# ───────────────────────────────────────────────────────────── OpenAI-compatible
# ---- OpenAI-compatible adapter (OpenAI, OpenRouter, Groq, custom endpoints like LM Studio) ----
# Convert BAYMAX's message format to OpenAI's, inventing the tool-call ids OpenAI requires.
def _to_openai(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    pending: list[tuple[str, str]] = []
    for m in messages:
        r = m["role"]
        if r == "assistant" and m.get("tool_calls"):
            calls = []
            for tc in m["tool_calls"]:
                fn = tc["function"]
                cid = f"call_{uuid.uuid4().hex[:12]}"
                pending.append((cid, fn.get("name") or ""))
                calls.append({"id": cid, "type": "function",
                              "function": {"name": fn.get("name") or "", "arguments": json.dumps(_json_args(fn.get("arguments")))}})
            out.append({"role": "assistant", "content": m.get("content") or None, "tool_calls": calls})
        elif r == "tool":
            idx = next((i for i, (_, n) in enumerate(pending) if n == m.get("tool_name")), 0 if pending else -1)
            cid = pending.pop(idx)[0] if idx >= 0 else f"call_{uuid.uuid4().hex[:12]}"
            out.append({"role": "tool", "tool_call_id": cid, "content": m.get("content", "")})
        else:
            out.append({"role": r, "content": m.get("content", "")})
    return out


# Stream a reply; tool-call fragments are collected and emitted once complete.
async def _openai_stream(pid: str, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]):
    base, key = base_url(pid), get_key(pid)
    if not base:
        raise ProviderError("Set the endpoint URL for the custom provider first.")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    payload: dict[str, Any] = {"model": model, "messages": _to_openai(messages), "stream": True, "temperature": 0.4}
    if tools:
        payload["tools"] = tools
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            async with client.stream("POST", f"{base}/chat/completions", headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    raise await _fail(resp, pid, model, key)
                acc: dict[int, dict[str, str]] = {}
                async for obj in _sse(resp):
                    for ch in obj.get("choices") or []:
                        d = ch.get("delta") or {}
                        if d.get("content"):
                            yield {"message": {"content": d["content"]}}
                        for tc in d.get("tool_calls") or []:
                            slot = acc.setdefault(tc.get("index", 0), {"name": "", "args": ""})
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] += fn["name"]
                            if fn.get("arguments"):
                                slot["args"] += fn["arguments"]
                calls = [{"function": {"name": s["name"], "arguments": _json_args(s["args"])}} for _, s in sorted(acc.items()) if s["name"]]
                if calls:
                    yield {"message": {"tool_calls": calls}}
    except httpx.ConnectError as exc:
        raise ProviderError(f"Could not reach {CATALOG[pid]['label']} ({base}). Check your internet connection or the URL.") from exc
    except httpx.TimeoutException as exc:
        raise ProviderError(f"{CATALOG[pid]['label']} took too long to answer.") from exc


# ───────────────────────────────────────────────────────────── Anthropic
# ---- Anthropic (Claude) adapter ----
# Convert messages: system text is separate, and tool results go inside "user" messages.
def _to_anthropic(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    system, out = "", []
    pending: list[tuple[str, str]] = []
    for m in messages:
        r = m["role"]
        if r == "system":
            system += (m.get("content") or "") + "\n"
        elif r == "user":
            out.append({"role": "user", "content": m.get("content") or " "})
        elif r == "assistant":
            blocks: list[dict[str, Any]] = []
            if (m.get("content") or "").strip():
                blocks.append({"type": "text", "text": m["content"]})
            for tc in m.get("tool_calls") or []:
                fn = tc["function"]
                tid = f"toolu_{uuid.uuid4().hex[:20]}"
                pending.append((tid, fn.get("name") or ""))
                blocks.append({"type": "tool_use", "id": tid, "name": fn.get("name") or "", "input": _json_args(fn.get("arguments"))})
            if blocks:
                out.append({"role": "assistant", "content": blocks})
        elif r == "tool":
            idx = next((i for i, (_, n) in enumerate(pending) if n == m.get("tool_name")), 0 if pending else -1)
            tid = pending.pop(idx)[0] if idx >= 0 else f"toolu_{uuid.uuid4().hex[:20]}"
            block = {"type": "tool_result", "tool_use_id": tid, "content": m.get("content") or "(empty)"}
            if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
    return system.strip(), out


# Stream a Claude reply from /v1/messages.
async def _anthropic_stream(pid: str, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]):
    key = get_key(pid)
    system, msgs = _to_anthropic(messages)
    payload: dict[str, Any] = {"model": model, "max_tokens": 2048, "messages": msgs, "stream": True, "temperature": 0.4}
    if system:
        payload["system"] = system
    if tools:
        payload["tools"] = [{"name": t["function"]["name"], "description": t["function"].get("description", ""),
                             "input_schema": t["function"].get("parameters") or {"type": "object", "properties": {}}} for t in tools]
    headers = {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            async with client.stream("POST", f"{base_url(pid)}/v1/messages", headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    raise await _fail(resp, pid, model, key)
                blocks: dict[int, dict[str, str]] = {}
                async for ev in _sse(resp):
                    t = ev.get("type")
                    if t == "content_block_start":
                        cb = ev.get("content_block") or {}
                        if cb.get("type") == "tool_use":
                            blocks[ev["index"]] = {"name": cb.get("name", ""), "args": ""}
                    elif t == "content_block_delta":
                        d = ev.get("delta") or {}
                        if d.get("type") == "text_delta" and d.get("text"):
                            yield {"message": {"content": d["text"]}}
                        elif d.get("type") == "input_json_delta" and ev.get("index") in blocks:
                            blocks[ev["index"]]["args"] += d.get("partial_json", "")
                    elif t == "error":
                        raise ProviderError(f"Claude error: {_redact((ev.get('error') or {}).get('message', 'unknown'), key)[:300]}")
                calls = [{"function": {"name": b["name"], "arguments": _json_args(b["args"])}} for _, b in sorted(blocks.items())]
                if calls:
                    yield {"message": {"tool_calls": calls}}
    except httpx.ConnectError as exc:
        raise ProviderError("Could not reach Claude. Check your internet connection.") from exc
    except httpx.TimeoutException as exc:
        raise ProviderError("Claude took too long to answer.") from exc


# ───────────────────────────────────────────────────────────── Gemini
# ---- Google Gemini adapter ----
# Gemini accepts only a small subset of JSON-schema keywords; everything else is stripped.
_SCHEMA_KEYS = {"type", "properties", "required", "description", "enum", "items"}


# Reduce a tool's parameter schema to what Gemini understands.
def _gem_schema(s: Any) -> Any:
    if isinstance(s, dict):
        out = {}
        for k, v in s.items():
            if k not in _SCHEMA_KEYS:
                continue
            out[k] = {pk: _gem_schema(pv) for pk, pv in v.items()} if k == "properties" else _gem_schema(v)
        return out
    return s


# Convert messages to Gemini's "contents" format (roles user/model, functionCall/functionResponse parts).
def _to_gemini(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    system, out = "", []
    for m in messages:
        r = m["role"]
        if r == "system":
            system += (m.get("content") or "") + "\n"
        elif r == "user":
            out.append({"role": "user", "parts": [{"text": m.get("content") or " "}]})
        elif r == "assistant":
            parts: list[dict[str, Any]] = []
            if (m.get("content") or "").strip():
                parts.append({"text": m["content"]})
            for tc in m.get("tool_calls") or []:
                fn = tc["function"]
                parts.append({"functionCall": {"name": fn.get("name") or "", "args": _json_args(fn.get("arguments"))}})
            if parts:
                out.append({"role": "model", "parts": parts})
        elif r == "tool":
            try:
                result: Any = json.loads(m.get("content") or "null")
            except ValueError:
                result = m.get("content")
            part = {"functionResponse": {"name": m.get("tool_name") or "tool", "response": {"result": result}}}
            if out and out[-1]["role"] == "user" and out[-1]["parts"] and "functionResponse" in out[-1]["parts"][0]:
                out[-1]["parts"].append(part)
            else:
                out.append({"role": "user", "parts": [part]})
    return system.strip(), out


# Stream a Gemini reply (the key is sent in a header, never in the URL).
async def _gemini_stream(pid: str, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]):
    key = get_key(pid)
    system, contents = _to_gemini(messages)
    payload: dict[str, Any] = {"contents": contents, "generationConfig": {"temperature": 0.4}}
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}
    if tools:
        payload["tools"] = [{"functionDeclarations": [
            {"name": t["function"]["name"], "description": t["function"].get("description", ""),
             "parameters": _gem_schema(t["function"].get("parameters") or {"type": "object", "properties": {}})}
            for t in tools]}]
    url = f"{base_url(pid)}/v1beta/models/{model}:streamGenerateContent?alt=sse"
    headers = {"x-goog-api-key": key, "content-type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    raise await _fail(resp, pid, model, key)
                calls: list[dict[str, Any]] = []
                async for ev in _sse(resp):
                    for cand in ev.get("candidates") or []:
                        for part in (cand.get("content") or {}).get("parts") or []:
                            if part.get("thought"):
                                continue
                            if part.get("text"):
                                yield {"message": {"content": part["text"]}}
                            fc = part.get("functionCall")
                            if fc:
                                calls.append({"function": {"name": fc.get("name"), "arguments": fc.get("args") or {}}})
                if calls:
                    yield {"message": {"tool_calls": calls}}
    except httpx.ConnectError as exc:
        raise ProviderError("Could not reach Gemini. Check your internet connection.") from exc
    except httpx.TimeoutException as exc:
        raise ProviderError("Gemini took too long to answer.") from exc


# ───────────────────────────────────────────────────────────── entry points
# The one function the agent calls: pick the right adapter for the chosen brain and stream its reply.
async def chat_stream(pid: str, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
    c = CATALOG.get(pid)
    if not c:
        raise ProviderError("Unknown model provider.")
    if pid == "ollama":
        async for chunk in ollama.chat_stream(model, messages, tools):
            yield chunk
        return
    if c["needs_key"] and not has_key(pid):
        raise ProviderError(f"No API key saved for {c['label']}. Add one in Settings, or switch back to Local.")
    gen = {"anthropic": _anthropic_stream, "gemini": _gemini_stream, "openai": _openai_stream}[c["kind"]]
    async for chunk in gen(pid, model, messages, tools):
        yield chunk


# (used by the "Test" button next to an API key)
async def test(pid: str, model: str) -> str:
    """One tiny request to prove the key + model work. Returns a short reply."""
    text = ""
    async for chunk in chat_stream(pid, model, [{"role": "user", "content": "Reply with just the word OK."}], []):
        text += (chunk.get("message") or {}).get("content") or ""
        if len(text) > 40:
            break
    return text.strip()[:40] or "OK"
