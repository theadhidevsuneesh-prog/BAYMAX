# BAYMAX — your free, local AI companion for Windows 11

A desktop assistant that lives as a **Dynamic Island** at the top of your screen and expands into a full **white-and-red BAYMAX HUD**.
It thinks with **Qwen running locally through [Ollama](https://ollama.com)** — no cloud, no accounts, **no API keys, no cost**. Your chats and memories never leave your laptop.

---

## ⚡ 3-step setup (for you — and anyone you share it with)

| # | Step | How |
|---|------|-----|
| **1** | **Install Ollama** | Download from <https://ollama.com/download> and install it (it runs in the background). |
| **2** | **Get the brain** | Open a terminal and run `ollama pull qwen2.5:7b` — or skip this and click **PULL** inside BAYMAX (step 3). |
| **3** | **Run BAYMAX** | Run **`BAYMAX Setup 1.0.0.exe`** (in `release/`), then open **BAYMAX** from the Start menu. |

> **Windows SmartScreen** may say "unknown publisher" because the installer isn't code-signed (that costs money). Click **More info → Run anyway**.

BAYMAX checks Ollama for you: if Ollama isn't running or the model is missing, the HUD shows a banner with **START OLLAMA / PULL** buttons.

### 🧪 Want to try it *before* installing?
You don't have to install anything to test BAYMAX. From this project folder (after `npm run setup` once):

```powershell
npm start
```
…or just double-click **`Start-BAYMAX.bat`**. It runs the exact same app straight from the folder (a pill appears at the top-centre of your screen; `Ctrl+Alt+B` opens the HUD). Quit with the **✕** in the HUD or the tray icon → *Quit BAYMAX*. Nothing is installed or added to the Start menu.

### Which model?
| Model | Best for | Download |
|-------|----------|----------|
| `qwen2.5:7b` *(default)* | 6 GB+ GPU — best balance | ~4.7 GB |
| `qwen2.5:3b` | Low-RAM / CPU-only laptops | ~1.9 GB |
| `qwen3:8b` | 8 GB+ GPU — strongest reasoning | ~5.2 GB |

Switch any time from the HUD's right panel (pulling is one click).

---

## 🫧 Using BAYMAX

**Dynamic Island (default)** — a small BAYMAX-head pill (white, thick outline, lavender shading) at the top-centre of your main monitor (never over the taskbar).
- **Hover** it → it grows and shows a quick-command box and BAYMAX's last reply.
- **Click** the pill to pin it open · **⤢ button** → morph into the full HUD.
- Face states: blinks and breathes when idle · eyes widen + warm pulse when you hover/type · scanning pulse along the `•—•` line while thinking/using tools · amber eyes when it needs your permission · after **2 min** idle the eyelids droop and `zZz` drift up.

**Full HUD** — left: live **CPU / RAM / GPU / Disk** gauges · centre: BAYMAX's head (his eyes follow your cursor, even outside the window), chat and web-research cards · right: **Ollama model switcher**, **long-term memory** viewer/editor (delete any memory), and **tool toggles**.
- **ONLINE ⇄ HIBERNATE / OFF** (top bar) is the **master kill-switch**: it instantly stops the running task, auto-denies pending permissions, closes BAYMAX's eyes, and he won't respond or execute anything until you switch him back ON.
- **▁ ISLAND** minimises back to the pill. **✕** quits.

**Shortcuts** — `Ctrl + Alt + B` toggles HUD ⇄ island from anywhere · tray icon (bottom-right) → *Open full HUD / Dynamic Island / Quit*.

### Things to try
- *"Create a folder called Trips and a file packing-list.txt inside it with a checklist."*
- *"Search the web for the latest Windows 11 update and summarise it."*
- *"Remember that I prefer dark mode and my name is …"* → later: *"What do you remember about me?"*
- *"Open Notepad."* · *"How's my CPU and RAM?"* · *"List what's in my Downloads folder."*

---

## 🛡️ Safety: the permission gate

BAYMAX's tools are split into two groups.

| Safe (run immediately) | Critical (**always pause and ask**) |
|---|---|
| `read_file`, `list_directory`, `create_folder`, creating a **new** file, `web_search`, `fetch_webpage_data`, `open_url_in_browser`, `get_system_stats`, `launch_application`, `save_memory`, `recall_memory` | `delete_path` · `run_powershell_command` · `create_file` that would **overwrite** an existing file · `move_or_rename_file` touching anything **outside** the workspace (or overwriting) |

Before a critical action the backend **pauses** and sends `PERMISSION_REQUIRED` to the HUD: BAYMAX's eyes turn worried and a red "!" appears and a modal shows the **exact tool, target and impact**. Only **AUTHORIZE** lets it proceed. **DENY**, closing the app, flipping the kill-switch, or 2 minutes of silence all mean *no* — and Qwen is told the user declined so it won't retry.

Extra guard rails: deletes go to the **Recycle Bin**; drive roots, your user folders, the workspace itself and Windows/Program Files are **never** deletable, even when authorised. Relative paths resolve into `Documents\BAYMAX Workspace`.

Network security: the backend listens on `127.0.0.1` only, and the app generates a random per-launch token that the UI must present — so a web page in your browser cannot talk to your local BAYMAX.

> ⚠️ `run_powershell_command` runs with *your* Windows permissions. Read the command in the modal before authorising. You can switch any tool off in **Right panel → TOOLS**.

---

## 🧠 Memory & data

- Long-term memory + conversation history: **SQLite** at `%APPDATA%\BAYMAX\baymax_memory.db`.
- BAYMAX saves lasting facts with `save_memory`, and the most relevant memories are injected into his system prompt on every message. View/add/delete them in **HUD → MEMORY**.
- Uninstalling the app keeps this folder; delete it to wipe BAYMAX's memory.

---

## 🛠️ Running from source

Requirements: **Windows 11**, **Node 20+**, **Python 3.11+**, Ollama.

```powershell
npm run setup     # creates backend\.venv, installs Python + npm packages
npm start         # builds the UI and launches BAYMAX
npm run dev       # hot-reload UI development (Vite + Electron)
```

Double-click **`Start-BAYMAX.bat`** to launch from source after setup.

### Build a shareable installer
```powershell
npm run dist      # UI build → PyInstaller backend bundle → NSIS installer in release\
```
The installer bundles the Python backend with PyInstaller, so **recipients don't need Python or Node** — only Ollama.

---

## 🗂️ Project layout

```
electron/     main.js (window morphing, tray, hotkey, spawns backend) · preload.js (secure bridge)
frontend/     React + Vite + Tailwind + Framer Motion  (Island, HUD, BAYMAX face, panels)
backend/      FastAPI + WebSocket on 127.0.0.1:8765
  app/agent.py        Ollama tool-calling loop (streaming) + permission handling
  app/tools.py        all tools + risk rules + JSON schemas sent to Qwen
  app/permissions.py  the PERMISSION_REQUIRED gate
  app/memory.py       SQLite memory / history / settings
  app/ollama.py       Ollama REST client (chat, pull, status, start)
  app/stats.py        psutil (+ nvidia-smi) telemetry
scripts/      setup.ps1 · build-backend.ps1
build/        icon.png
```

---

## ❓ Troubleshooting

| Problem | Fix |
|---|---|
| Island says **"Start Ollama"** | Open the HUD → press **START**, or launch the Ollama app. |
| Island says **"Model missing"** | HUD → right panel → **PULL** the model (or `ollama pull qwen2.5:7b`). |
| Replies are slow | Use `qwen2.5:3b`; close GPU-heavy apps. First reply after idle is slower while the model loads. |
| Tool calls act strangely | Qwen 7B/8B call tools far more reliably than 3B. |
| "Could not start its engine" (source runs) | Run `npm run setup` (needs Python 3.11+ on PATH). |
| Port 8765 busy | BAYMAX automatically picks the next free port. |

**Not included:** voice input/output. The "Listening" face reacts to hovering/typing, not a microphone.

MIT licensed — share freely.



## 🧠 Choosing BAYMAX's brain (Local or Cloud)

HUD → **Brain** tab. **Local · free** (Qwen on Ollama) is the default and needs no account. Under **Cloud · API key** you can optionally add your own key for **Claude, Gemini, OpenAI, OpenRouter, Groq** or any **OpenAI-compatible** endpoint (e.g. LM Studio), pick a model name, press **Test**, then **Use this brain**.

- Keys are encrypted with Windows DPAPI (tied to your Windows login) and never shown again, only the last 4 characters.
- A cloud brain sends your chats, and anything BAYMAX reads for you, to that company. The HUD shows a red **Cloud** badge while one is active.
- Remove a key, or pick a local model, to go back to fully private. No key is ever required.
- Gemini, Groq and OpenRouter offer free tiers.


## 🎙️ Voice (talk to BAYMAX like Jarvis)

Press **VOICE OFF** in the HUD header (or the mic button in the island) once. The first time, BAYMAX downloads two small models into `%APPDATA%\BAYMAX\models` (about 60 MB for his voice, about 150 MB for listening), then everything runs **locally**.

- Say **"BAYMAX, what's the weather like?"**: he answers out loud. Or say just **"BAYMAX"**, wait for the soft chime, then ask. After he speaks you can follow up for a few seconds without repeating the name. Say **"stop"** to interrupt.
- He narrates what he's doing ("Searching the web.") and reads a short version of the answer; the full text stays on screen.
- Speech that doesn't start with "BAYMAX" is transcribed locally, ignored and forgotten. The mic is closed whenever voice is off or BAYMAX is hibernating.
- Risky actions are **never** approved by voice: he says "Please check the screen" and you click Authorize or Deny.
- Windows must allow the mic: Settings → Privacy → Microphone → "Let desktop apps access your microphone".


## 📬 Mail, calendar & PC search

Open **HUD → Connect** to link **Google** (Gmail + Calendar) and/or **Microsoft** (Outlook + Calendar). You create your own free sign-in credentials once; BAYMAX never ships shared keys, and tokens are encrypted on this PC (Windows DPAPI).

**Google:** Google Cloud console → new project → enable *Gmail API* and *Google Calendar API* → OAuth consent screen (External, add yourself as a Test user) → Credentials → OAuth client ID, type *Desktop app* → paste Client ID + secret into Connect → **Connect**. Google will warn the app is "unverified"; that's expected for your own project.

**Microsoft:** Entra admin center → App registrations → New registration (personal + organizational accounts) → add redirect *Mobile and desktop* `http://localhost` → paste the Application (client) ID → **Connect**.

Then just ask: "any unread mail from Sam?", "what's on my calendar tomorrow?", "email Alex that I'm running late", "find my tax PDF".

- Reading and searching are automatic. **Sending mail, trashing mail, creating or deleting events, and opening runnable files always ask first**, showing the full recipient and text.
- Mail/calendar tools stay hidden from the model until an account is connected.
- Email and event text is treated as untrusted data, never as instructions.
- File search uses the Windows Search index (falls back to a folder walk) and can look inside files.


## 🤵 More ways to use BAYMAX

- **"Sir":** BAYMAX addresses you as sir, and remembers personal details you mention in passing (age, birthday, family, city, likes). See and edit them in the **Memory** tab.
- **Daily brief:** once a day it reads you the world headlines (BBC, NPR, Al Jazeera) and, if connected, your calendar. Ask any time with "daily brief". Turn on **Settings (gear) → Start with Windows** to get it when you switch the laptop on.
- **Voice commands:** say "BAYMAX …" then your request. While it talks, say **"stop"** to silence it and keep talking. Say **"close"** to quit BAYMAX completely. Say **"shut down"** (or "restart") and approve on screen; the PC powers off after a 30-second countdown, and "cancel shutdown" aborts it.
- **Everything is read aloud** when voice is on, including replies to typed messages.
- **Settings (gear):** local models and cloud API keys (Claude, Gemini, OpenAI, ...) live here. Local Qwen stays the free default.

## Author

Built by [Adhidev Suneesh](https://github.com/theadhidevsuneesh-prog). Released under the MIT License.

