"""BAYMAX backend - FastAPI + WebSocket server (localhost only)."""
from __future__ import annotations

import asyncio
import hmac
import sys
from contextlib import asynccontextmanager

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from app import accounts, memory, ollama, providers, stats, tools, voice
from app.agent import Agent, Hub
from app.config import AUTH_TOKEN, DB_PATH, HOST, PORT, WORKSPACE

# The Hub fans every event out to all connected UI windows over the WebSocket.
hub = Hub()
# The Agent (the "brain loop") is created once the server starts; see lifespan() below.
agent: Agent  # created in lifespan


# Start-up / shut-down hook: open the database and create the agent on start,
# and make sure no permission prompt or running turn is left hanging on exit.
@asynccontextmanager
async def lifespan(_: FastAPI):
    global agent
    memory.init()
    agent = Agent(hub)
    yield
    agent.gate.deny_all()
    await agent.cancel()


# The web app. CORS is open, but every call still has to carry the secret token (see require_token),
# and the server only ever listens on 127.0.0.1, so other PCs and web pages cannot reach it.
app = FastAPI(title="BAYMAX", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# Constant-time check of the shared secret that Electron generates for each launch.
def _token_ok(candidate: str | None) -> bool:
    return not AUTH_TOKEN or hmac.compare_digest(candidate or "", AUTH_TOKEN)


# FastAPI dependency: rejects REST calls that do not send the correct X-Baymax-Token header.
async def require_token(x_baymax_token: str | None = Header(default=None)) -> None:
    if not _token_ok(x_baymax_token):
        raise HTTPException(status_code=401, detail="bad token")


# ---- Basic status and Ollama (local model server) endpoints ----
@app.get("/api/health")
async def health():
    return {"ok": True, "app": "baymax", "db": str(DB_PATH), "workspace": str(WORKSPACE)}


@app.get("/api/ollama/status", dependencies=[Depends(require_token)])
async def ollama_status():
    return await ollama.status()


@app.post("/api/ollama/start", dependencies=[Depends(require_token)])
async def ollama_start():
    started = await asyncio.to_thread(ollama.start_server)
    if started:
        for _ in range(20):  # wait up to ~10s for it to answer
            await asyncio.sleep(0.5)
            if (await ollama.status())["running"]:
                break
    return {"started": started, **(await ollama.status())}


# ---- Live CPU / RAM / GPU / disk numbers for the Health Scan panel ----
@app.get("/api/stats", dependencies=[Depends(require_token)])
async def get_stats():
    return await asyncio.to_thread(stats.collect)


# ---- Long-term memory (facts BAYMAX remembers about the user) ----
@app.get("/api/memories", dependencies=[Depends(require_token)])
async def list_memories():
    return memory.list_memories()


@app.delete("/api/memories/{memory_id}", dependencies=[Depends(require_token)])
async def delete_memory(memory_id: int):
    if not memory.delete_memory(memory_id):
        raise HTTPException(404, "memory not found")
    await hub.broadcast({"type": "memories_changed"})
    return {"ok": True}


@app.post("/api/memories", dependencies=[Depends(require_token)])
async def add_memory(body: dict):
    try:
        saved = memory.add_memory(str(body.get("category", "general")), str(body.get("fact", "")))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    await hub.broadcast({"type": "memories_changed"})
    return saved


# ---- Chat history shown in the window (the model's own context is rebuilt from the same table) ----
@app.get("/api/history", dependencies=[Depends(require_token)])
async def history():
    return memory.recent_display(40)


@app.delete("/api/history", dependencies=[Depends(require_token)])
async def clear_history():
    memory.clear_messages()
    return {"ok": True}


# Message telling every window which brain (provider + model) is now active.
def _model_event() -> dict:
    return {"type": "model", "model": agent.model, "provider": agent.provider, "cloud": providers.is_cloud(agent.provider)}


# ---- Brains: local Ollama (default) or a cloud provider with the user's own API key ----
@app.get("/api/providers", dependencies=[Depends(require_token)])
async def list_providers():
    return {"active": {"provider": agent.provider, "model": agent.model}, "providers": providers.describe()}


@app.put("/api/providers/{pid}/key", dependencies=[Depends(require_token)])
async def put_provider_key(pid: str, body: dict):
    try:
        providers.set_key(pid, str(body.get("key", "")))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except providers.ProviderError as exc:
        raise HTTPException(500, str(exc))
    return {"ok": True}


@app.delete("/api/providers/{pid}/key", dependencies=[Depends(require_token)])
async def delete_provider_key(pid: str):
    if pid not in providers.CATALOG:
        raise HTTPException(404, "unknown provider")
    providers.clear_key(pid)
    if agent.provider == pid:  # never leave the agent on a brain it can no longer reach
        agent.set_provider("ollama")
        await hub.broadcast(_model_event())
    return {"ok": True}


@app.put("/api/providers/custom/config", dependencies=[Depends(require_token)])
async def put_custom_config(body: dict):
    try:
        providers.set_base_url(str(body.get("base_url", "")))
        if str(body.get("key", "")).strip():
            providers.set_key("custom", str(body["key"]))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True}


@app.post("/api/providers/{pid}/test", dependencies=[Depends(require_token)])
async def test_provider(pid: str, body: dict):
    if pid not in providers.CATALOG or pid == "ollama":
        raise HTTPException(404, "unknown provider")
    model = str(body.get("model") or providers.saved_model(pid))
    if not providers.valid_model(model):
        return {"ok": False, "error": "Enter a model name first."}
    try:
        return {"ok": True, "reply": await providers.test(pid, model)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ---- Connected accounts (Google / Microsoft) for mail and calendar ----
@app.get("/api/accounts", dependencies=[Depends(require_token)])
async def list_accounts():
    return accounts.describe()


@app.put("/api/accounts/{pid}/config", dependencies=[Depends(require_token)])
async def put_account_config(pid: str, body: dict):
    try:
        accounts.set_config(pid, str(body.get("client_id", "")), str(body.get("client_secret", "")))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True}


@app.post("/api/accounts/{pid}/connect", dependencies=[Depends(require_token)])
# Starts the browser sign-in. The result arrives later on the sign-in thread, so it is
# pushed to the UI as an "accounts_changed" WebSocket event instead of in this response.
async def connect_account(pid: str):
    loop = asyncio.get_running_loop()

    def done(ok: bool, message: str) -> None:  # runs on the sign-in thread
        asyncio.run_coroutine_threadsafe(hub.broadcast({"type": "accounts_changed", "ok": ok, "message": message, "account": pid}), loop)

    try:
        url = accounts.begin(pid, done)
    except (ValueError, accounts.AccountError) as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True, "url": url}


@app.delete("/api/accounts/{pid}", dependencies=[Depends(require_token)])
async def disconnect_account(pid: str, forget: bool = False):
    if pid not in accounts.PROVIDERS:
        raise HTTPException(404, "unknown account type")
    (accounts.forget if forget else accounts.disconnect)(pid)
    await hub.broadcast({"type": "accounts_changed", "ok": True, "message": "Disconnected.", "account": pid})
    await hub.broadcast({"type": "tools", "tools": tools.describe_tools()})
    return {"ok": True}


# ---- Voice: local speech-to-text (Whisper) and text-to-speech (Piper) ----
@app.get("/api/voice/status", dependencies=[Depends(require_token)])
async def voice_status():
    return voice.status()


@app.post("/api/voice/setup", dependencies=[Depends(require_token)])
async def voice_setup():
    if voice.status()["setting_up"]:
        return {"started": False}

    async def progress(msg: dict) -> None:
        await hub.broadcast({"type": "voice_setup", **msg})

    asyncio.create_task(voice.setup(progress))
    return {"started": True}


@app.post("/api/voice/transcribe", dependencies=[Depends(require_token)])
# Speech to text. The UI sends one finished utterance as raw 16 kHz mono 16-bit audio.
async def voice_transcribe(request: Request):
    """Body: raw 16 kHz mono PCM16. Returns the recognised text ('' when it was just noise)."""
    if not voice.ready():
        raise HTTPException(409, "voice is not set up yet")
    pcm = await request.body()
    if len(pcm) > 16000 * 2 * 30:
        raise HTTPException(413, "audio too long")
    try:
        text = await asyncio.to_thread(voice.transcribe, pcm)
    except Exception as exc:
        raise HTTPException(500, f"transcription failed: {exc}")
    return {"text": text}


@app.post("/api/tts", dependencies=[Depends(require_token)])
# Text to speech. Returns a WAV that the UI plays; text is capped so one sentence never blocks for long.
async def tts(body: dict):
    if not voice.ready():
        raise HTTPException(409, "voice is not set up yet")
    text = str(body.get("text", "")).strip()[:700]
    if not text:
        raise HTTPException(400, "no text")
    try:
        wav = await asyncio.to_thread(voice.synthesize, text)
    except Exception as exc:
        raise HTTPException(500, f"speech failed: {exc}")
    return Response(content=wav, media_type="audio/wav")


# ---- Tool list (what BAYMAX is able and allowed to do) ----
@app.get("/api/tools", dependencies=[Depends(require_token)])
async def get_tools():
    return tools.describe_tools()


# The live channel: the UI sends chat messages / permission answers / settings, and the backend
# streams back tokens, tool activity, status changes and permission requests.
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if not _token_ok(ws.query_params.get("token")):
        await ws.close(code=1008)
        return
    await ws.accept()
    # Send the current state first so a fresh window can draw itself immediately.
    hub.clients.add(ws)
    await ws.send_json(agent.snapshot())
    try:
        while True:
            msg = await ws.receive_json()
            # One branch per message type the UI may send.
            kind = msg.get("type")
            if kind == "chat":
                text = str(msg.get("text", "")).strip()
                if not text:
                    continue
                if not agent.enabled:
                    await hub.broadcast({"type": "error", "message": "BAYMAX is hibernating. Switch him ON to continue."})
                    continue
                agent.start_chat(text[:8000])
            elif kind == "brief":
                if agent.enabled:
                    agent.start_brief()
            elif kind == "cancel":
                await agent.cancel()
            elif kind == "permission_response":
                agent.gate.resolve(str(msg.get("id", "")), bool(msg.get("approved")))
            elif kind == "set_enabled":
                await agent.set_enabled(bool(msg.get("enabled")))
            elif kind in ("set_model", "set_provider"):
                try:
                    if kind == "set_model":
                        agent.set_model(str(msg.get("model", "")))
                    else:
                        agent.set_provider(str(msg.get("provider", "")), str(msg.get("model") or "") or None)
                    await hub.broadcast(_model_event())
                except ValueError as exc:
                    await ws.send_json({"type": "error", "message": str(exc)})
            elif kind == "set_tool":
                try:
                    tools.set_tool_enabled(str(msg.get("name")), bool(msg.get("enabled")))
                    await hub.broadcast({"type": "tools", "tools": tools.describe_tools()})
                except KeyError:
                    pass
            elif kind == "pull_model":
                agent.start_pull(str(msg.get("model", "")))
            elif kind == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        hub.clients.discard(ws)
        if not hub.clients:
            # Safety: if every window closed while a permission prompt was open, that action is denied.
            agent.gate.deny_all()  # nobody can answer a prompt any more -> deny


if __name__ == "__main__":
    # Entry point used both in development and by the packaged baymax-backend.exe.
    # Never listen on anything but loopback.
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
    sys.exit(0)
