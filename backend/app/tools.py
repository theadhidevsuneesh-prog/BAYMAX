"""Tools exposed to Qwen through Ollama's native `tools` schema.

Every tool is a plain Python function. Each tool may also declare a `risk`
callback: when it returns a `Risk`, the agent must obtain explicit user
authorization (the Iron Man HUD modal) before the function is executed.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from . import accounts, mailcal, memory, stats
from .accounts import AccountError
from .config import WORKSPACE

# Stops a black console window from flashing when we start PowerShell / other programs.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# Browser-like User-Agent so websites serve normal pages to fetch_webpage_data.
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 BAYMAX/1.0"
)


@dataclass
# Returned by a tool's risk callback when an action is dangerous: `target` is what it touches and
# `impact` is a plain-English warning. The agent shows both in the permission prompt.
class Risk:
    target: str
    impact: str


@dataclass
# One thing BAYMAX can do: a name and description for the model, a JSON schema for its
# arguments, the Python function that does it, and an optional risk check.
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    fn: Callable[..., Any]
    # Default: no risk, run without asking.
    risk: Callable[[dict[str, Any]], Optional[Risk]] = lambda args: None
    group: str = "general"
    card: Optional[str] = None  # emit a research card in the HUD ("search" | "page")
    # destructive=True means it ALWAYS asks first (shown as "Asks first" in the Tools tab).
    destructive: bool = False  # shown as CRITICAL in the tool list

    # The tool in the format the model providers expect ("function calling").
    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


# ------------------------------------------------------------------ paths
# Turn what the user/model typed into a real absolute path. Relative paths live in the BAYMAX workspace.
def resolve_path(p: str) -> Path:
    raw = os.path.expandvars(os.path.expanduser(str(p).strip().strip('"').strip("'")))
    path = Path(raw)
    if not path.is_absolute():
        path = WORKSPACE / path
    return path.resolve()


# True when the path is inside the BAYMAX workspace folder (the safe sandbox).
def in_workspace(path: Path) -> bool:
    try:
        path.resolve().relative_to(WORKSPACE.resolve())
        return True
    except ValueError:
        return False


# System folders (Windows, Program Files, ...) that must never be deleted.
def _protected_roots() -> list[Path]:
    roots: list[Path] = []
    for var in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"):
        v = os.environ.get(var)
        if v:
            roots.append(Path(v).resolve())
    return roots


# Hard safety net for deletes, applied even after the user says yes.
def _is_protected(path: Path) -> str | None:
    """Return a reason if the path must never be deleted, even when authorized."""
    path = path.resolve()
    if path.parent == path:
        return "that is a drive root"
    home = Path.home().resolve()
    never = {home, WORKSPACE.resolve(), home.parent}
    for sub in ("Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music", "AppData"):
        never.add((home / sub).resolve())
    if path in never:
        return "that is a core user folder"
    for root in _protected_roots():
        if path == root or root in path.parents:
            return "that is inside a protected system location"
    return None


# ------------------------------------------------------------------ file ops
# ---- File tools. Each returns {"ok": True/False, ...} so the model can read the outcome. ----
def create_folder(path: str) -> dict[str, Any]:
    p = resolve_path(path)
    p.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "path": str(p)}


def create_file(path: str, content: str = "") -> dict[str, Any]:
    p = resolve_path(path)
    if p.is_dir():
        return {"ok": False, "error": f"{p} is a folder"}
    existed = p.exists()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return {"ok": True, "path": str(p), "bytes": len(content.encode("utf-8")), "overwritten": existed}


# Creating a new file is silent; overwriting an existing one needs permission.
def _risk_create_file(args: dict[str, Any]) -> Risk | None:
    try:
        p = resolve_path(args.get("path", ""))
    except Exception:
        return None
    if p.exists():
        size = p.stat().st_size if p.is_file() else 0
        return Risk(str(p), f"OVERWRITES an existing file ({size:,} bytes). The old contents will be lost.")
    return None


# Read a text file (refuses binary files, caps the amount returned).
def read_file(path: str, max_chars: int = 20000) -> dict[str, Any]:
    p = resolve_path(path)
    if not p.exists():
        return {"ok": False, "error": f"{p} does not exist"}
    if p.is_dir():
        return {"ok": False, "error": f"{p} is a folder - use list_directory"}
    max_chars = max(100, min(int(max_chars), 60000))
    with open(p, "rb") as fh:
        head = fh.read(2048)
        if b"\x00" in head:
            return {"ok": False, "error": "binary file - cannot display as text", "size": p.stat().st_size}
        fh.seek(0)
        data = fh.read(max_chars * 4 + 4)
    text = data.decode("utf-8", errors="replace")
    return {
        "ok": True,
        "path": str(p),
        "size": p.stat().st_size,
        "content": text[:max_chars],
        "truncated": len(text) > max_chars,
    }


# List a folder, folders first, at most 200 entries.
def list_directory(path: str = ".") -> dict[str, Any]:
    p = resolve_path(path)
    if not p.exists():
        return {"ok": False, "error": f"{p} does not exist"}
    if not p.is_dir():
        return {"ok": False, "error": f"{p} is a file"}
    entries = []
    try:
        children = sorted(p.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower()))
    except PermissionError:
        return {"ok": False, "error": "permission denied"}
    for c in children[:200]:
        try:
            entries.append(
                {"name": c.name, "type": "folder" if c.is_dir() else "file",
                 "size": c.stat().st_size if c.is_file() else None}
            )
        except OSError:
            entries.append({"name": c.name, "type": "unknown", "size": None})
    return {"ok": True, "path": str(p), "count": len(children), "entries": entries, "truncated": len(children) > 200}


def move_or_rename_file(source: str, destination: str) -> dict[str, Any]:
    src, dst = resolve_path(source), resolve_path(destination)
    if not src.exists():
        return {"ok": False, "error": f"{src} does not exist"}
    if dst.is_dir():
        dst = dst / src.name
    if dst.exists():
        return {"ok": False, "error": f"{dst} already exists"}
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return {"ok": True, "from": str(src), "to": str(dst)}


# Moving things inside the workspace is silent; touching anything outside it asks first.
def _risk_move(args: dict[str, Any]) -> Risk | None:
    try:
        src, dst = resolve_path(args.get("source", "")), resolve_path(args.get("destination", ""))
    except Exception:
        return None
    outside = [str(x) for x in (src, dst) if not in_workspace(x)]
    if outside:
        return Risk(f"{src}  ->  {dst}",
                    "Moves/renames files OUTSIDE the BAYMAX workspace, which may break programs that rely on them.")
    return None


# Delete to the Recycle Bin (recoverable) when possible; protected locations are refused.
def delete_path(path: str) -> dict[str, Any]:
    p = resolve_path(path)
    if not p.exists():
        return {"ok": False, "error": f"{p} does not exist"}
    reason = _is_protected(p)
    if reason:
        return {"ok": False, "error": f"Refused: {reason}."}
    try:
        from send2trash import send2trash

        send2trash(str(p))
        return {"ok": True, "path": str(p), "method": "moved to Recycle Bin"}
    except ImportError:
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
        return {"ok": True, "path": str(p), "method": "permanently deleted"}


def _risk_delete(args: dict[str, Any]) -> Risk | None:
    p = resolve_path(args.get("path", ""))
    kind = "folder and everything inside it" if p.is_dir() else "file"
    return Risk(str(p), f"DELETES this {kind} (sent to the Recycle Bin when possible).")


# ------------------------------------------------------------------ web
# ---- Web tools ----
# Accept only http(s) URLs (adds https:// to bare domains) so the model can't open file:// or other schemes.
def _check_url(url: str) -> str:
    url = (url or "").strip()
    if not re.match(r"^https?://", url, re.I):
        if re.match(r"^[\w.-]+\.[a-z]{2,}(/.*)?$", url, re.I):
            url = "https://" + url
        else:
            raise ValueError("only http(s) URLs are allowed")
    if not urlparse(url).netloc:
        raise ValueError("invalid URL")
    return url


def open_url_in_browser(url: str) -> dict[str, Any]:
    url = _check_url(url)
    webbrowser.open(url)
    return {"ok": True, "opened": url}


# Import DuckDuckGo search under either of its package names.
def _ddgs():
    try:
        from ddgs import DDGS
    except ImportError:  # older package name
        from duckduckgo_search import DDGS  # type: ignore
    return DDGS


# Search the web (no API key needed) and return titles, links and snippets.
def web_search(query: str, max_results: int = 5) -> dict[str, Any]:
    max_results = max(1, min(int(max_results), 10))
    DDGS = _ddgs()
    try:
        raw = list(DDGS().text(query, max_results=max_results))
    except Exception as exc:  # network / rate limit
        return {"ok": False, "error": f"search failed: {exc}"}
    return {
        "ok": True,
        "query": query,
        "results": [
            {"title": r.get("title", ""), "url": r.get("href") or r.get("url", ""), "snippet": r.get("body", "")}
            for r in raw
        ],
    }


# Download a page and reduce it to its readable text plus a few links.
def fetch_webpage_data(url: str, max_chars: int = 6000) -> dict[str, Any]:
    url = _check_url(url)
    max_chars = max(500, min(int(max_chars), 20000))
    try:
        with httpx.Client(follow_redirects=True, timeout=15, headers={"User-Agent": _UA}) as client:
            resp = client.get(url)
            resp.raise_for_status()
    except Exception as exc:
        return {"ok": False, "error": f"could not fetch page: {exc}"}
    ctype = resp.headers.get("content-type", "")
    if "html" not in ctype and "text" not in ctype and "json" not in ctype:
        return {"ok": False, "error": f"unsupported content type: {ctype}"}
    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "nav", "footer", "header", "form", "iframe"]):
        tag.decompose()
    title = (soup.title.string or "").strip() if soup.title and soup.title.string else ""
    main = soup.find("main") or soup.find("article") or soup.body or soup
    text = re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", main.get_text("\n", strip=True)))
    links = []
    for a in main.find_all("a", href=True)[:60]:
        label = a.get_text(" ", strip=True)
        if label and a["href"].startswith("http"):
            links.append({"text": label[:80], "url": a["href"]})
        if len(links) >= 8:
            break
    return {
        "ok": True,
        "url": str(resp.url),
        "title": title,
        "text": text[:max_chars],
        "truncated": len(text) > max_chars,
        "links": links,
    }


# ------------------------------------------------------------------ system
# ---- System tools ----
# Friendly names -> the program or Windows URI that launches them.
_APP_ALIASES = {
    "calculator": "calc", "calc": "calc", "notepad": "notepad", "paint": "mspaint",
    "file explorer": "explorer", "explorer": "explorer", "task manager": "taskmgr",
    "terminal": "wt", "windows terminal": "wt", "powershell": "powershell", "cmd": "cmd",
    "command prompt": "cmd", "settings": "ms-settings:", "edge": "msedge", "chrome": "chrome",
    "google chrome": "chrome", "firefox": "firefox", "word": "winword", "excel": "excel",
    "powerpoint": "powerpnt", "outlook": "outlook", "snipping tool": "snippingtool",
    "vscode": "code", "vs code": "code", "visual studio code": "code",
}


# Fallback for apps without an alias: find the closest-named Start Menu shortcut.
def _find_start_menu_shortcut(name: str) -> str | None:
    needle = name.lower()
    dirs = [
        Path(os.environ.get("ProgramData", "C:/ProgramData")) / "Microsoft/Windows/Start Menu/Programs",
        Path(os.environ.get("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs",
    ]
    best: tuple[int, str] | None = None
    for d in dirs:
        if not d.exists():
            continue
        for lnk in d.rglob("*.lnk"):
            stem = lnk.stem.lower()
            if needle in stem:
                score = abs(len(stem) - len(needle))
                if best is None or score < best[0]:
                    best = (score, str(lnk))
    return best[1] if best else None


# Open an app by name. Only plain names are accepted, never arbitrary commands.
def launch_application(name: str) -> dict[str, Any]:
    name = (name or "").strip()
    if not re.fullmatch(r"[\w .+\-()]{1,60}", name):
        return {"ok": False, "error": "give a plain application name (e.g. 'notepad', 'chrome', 'spotify')"}
    target = _APP_ALIASES.get(name.lower(), name)
    try:
        os.startfile(target)  # type: ignore[attr-defined]  # Windows only
        return {"ok": True, "launched": target}
    except OSError:
        pass
    lnk = _find_start_menu_shortcut(name)
    if lnk:
        os.startfile(lnk)  # type: ignore[attr-defined]
        return {"ok": True, "launched": Path(lnk).stem}
    return {"ok": False, "error": f"could not find an application called '{name}'"}


# CPU / RAM / GPU / disk numbers (same source as the Health Scan panel).
def get_system_stats() -> dict[str, Any]:
    return {"ok": True, **stats.collect()}


# Run any PowerShell command. Powerful, so it is always gated behind a permission prompt.
def run_powershell_command(command: str, timeout_seconds: int = 60) -> dict[str, Any]:
    timeout_seconds = max(1, min(int(timeout_seconds), 300))
    try:
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
            capture_output=True, text=True, timeout=timeout_seconds, creationflags=_NO_WINDOW,
            cwd=str(WORKSPACE), errors="replace",
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"timed out after {timeout_seconds}s"}
    except FileNotFoundError:
        return {"ok": False, "error": "powershell.exe not found"}
    return {
        "ok": proc.returncode == 0,
        "exit_code": proc.returncode,
        "stdout": proc.stdout[-8000:],
        "stderr": proc.stderr[-3000:],
    }


def _risk_powershell(args: dict[str, Any]) -> Risk:
    cmd = str(args.get("command", ""))
    return Risk(cmd, "Runs this command in PowerShell with YOUR user permissions. It can change or delete anything you can.")


# ------------------------------------------------------------------ system search / processes
# ---- Finding files ----
# Folders skipped by the slow fallback search because they are huge and rarely what the user means.
_SKIP_DIRS = {"appdata", "node_modules", ".git", "$recycle.bin", "windows", "program files", "program files (x86)", "__pycache__", ".venv"}


# (Windows Search index lookup, see below.)
def _index_search(term: str, folder: Path, content: bool, limit: int) -> list[dict[str, Any]] | None:
    """Query the Windows Search index (instant, can also search inside documents). None if unavailable."""
    safe = re.sub(r"[^\w .\-]", " ", term).strip()
    if not safe:
        return None
    scope = str(folder).replace("'", "''")
    cond = f"CONTAINS('\"{safe}\"')" if content else " AND ".join(f"System.FileName LIKE '%{w}%'" for w in safe.split()[:6])
    sql = (f"SELECT TOP {limit} System.ItemPathDisplay, System.Size, System.DateModified FROM SystemIndex "
           f"WHERE SCOPE='file:{scope}' AND {cond} ORDER BY System.DateModified DESC")
    ps = (
        "$ErrorActionPreference='Stop';$c=New-Object -ComObject ADODB.Connection;$r=New-Object -ComObject ADODB.Recordset;"
        "$c.Open(\"Provider=Search.CollatorDSO;Extended Properties='Application=Windows';\");"
        f"$r.Open(\"{sql.replace(chr(34), chr(96) + chr(34))}\",$c);$o=@();"
        "while(-not $r.EOF){$o+=[pscustomobject]@{path=[string]$r.Fields.Item(0).Value;size=$r.Fields.Item(1).Value;modified=[string]$r.Fields.Item(2).Value};$r.MoveNext()};"
        "$r.Close();$c.Close();ConvertTo-Json -InputObject @($o) -Compress"
    )
    try:
        proc = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True,
                              text=True, timeout=25, creationflags=_NO_WINDOW, errors="replace")
        if proc.returncode != 0 or not proc.stdout.strip():
            return None
        rows = json.loads(proc.stdout)
        return [{"path": r["path"], "size": r.get("size"), "modified": r.get("modified", "")} for r in rows if r.get("path")]
    except Exception:
        return None


# Slow fallback when the Windows Search index is unavailable: walk the folders and match names.
def _walk_search(term: str, folder: Path, limit: int) -> list[dict[str, Any]]:
    import time
    words = [w.lower() for w in re.split(r"\s+", term.strip()) if w]
    t_end, out = time.time() + 10, []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d.lower() not in _SKIP_DIRS and not d.startswith(".")]
        for name in files + dirs:
            low = name.lower()
            if all(w in low for w in words):
                p = Path(root) / name
                try:
                    st = p.stat()
                    out.append({"path": str(p), "size": st.st_size if p.is_file() else None,
                                "modified": __import__("datetime").datetime.fromtimestamp(st.st_mtime).isoformat(timespec="minutes")})
                except OSError:
                    continue
                if len(out) >= limit:
                    return out
        if time.time() > t_end:
            break
    return out


# Find files by name (or by text inside documents). Uses the instant index first, the folder walk second.
def search_files(query: str, folder: str = "", search_inside_files: bool = False, limit: int = 15) -> dict[str, Any]:
    query = (query or "").strip()
    if not query:
        return {"ok": False, "error": "give something to search for"}
    limit = max(1, min(int(limit or 15), 40))
    base = resolve_path(folder) if folder.strip() else Path.home()
    if not base.exists() or not base.is_dir():
        return {"ok": False, "error": f"{base} is not a folder"}
    rows = _index_search(query, base, bool(search_inside_files), limit * 5)
    method = "windows-search-index"
    if rows is not None:  # hide developer/system clutter unless the user searched inside it on purpose
        noisy = ("\\node_modules\\", "\\.venv\\", "\\site-packages\\", "\\appdata\\", "\\.git\\", "\\$recycle.bin\\", "\\__pycache__\\")
        if not any(n in str(base).lower() for n in noisy):
            rows = [r for r in rows if not any(n in r["path"].lower() for n in noisy)]
        rows = rows[:limit]
    if rows is None:
        if search_inside_files:
            return {"ok": False, "error": "Searching inside files needs the Windows Search index, which is not available right now."}
        rows, method = _walk_search(query, base, limit), "folder-scan"
    return {"ok": True, "query": query, "folder": str(base), "method": method, "count": len(rows), "results": rows}


# The programs using the most memory or CPU right now (for "why is my PC slow?").
def list_processes(limit: int = 15, sort_by: str = "memory") -> dict[str, Any]:
    import psutil
    procs = []
    for p in psutil.process_iter(["pid", "name", "memory_info", "cpu_percent"]):
        try:
            procs.append({"pid": p.info["pid"], "name": p.info["name"], "memory_mb": round(p.info["memory_info"].rss / 1048576), "cpu_percent": p.info["cpu_percent"]})
        except (psutil.Error, AttributeError):
            continue
    key = "cpu_percent" if sort_by.lower().startswith("cpu") else "memory_mb"
    procs.sort(key=lambda x: x[key] or 0, reverse=True)
    return {"ok": True, "sorted_by": key, "processes": procs[: max(1, min(int(limit or 15), 40))]}


# File types that RUN code when opened; opening these needs permission.
_RUNNABLE = {".exe", ".bat", ".cmd", ".ps1", ".msi", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".lnk", ".scr", ".com", ".jar", ".reg", ".hta", ".cpl"}


# Open a file or folder with its default program (like double-clicking it).
def open_path(path: str) -> dict[str, Any]:
    p = resolve_path(path)
    if not p.exists():
        return {"ok": False, "error": f"{p} does not exist"}
    os.startfile(str(p))  # type: ignore[attr-defined]  # opens with the default app / Explorer
    return {"ok": True, "opened": str(p)}


# Documents open silently; programs and scripts (.exe, .bat, .ps1, ...) ask first.
def _risk_open_path(args: dict[str, Any]) -> Risk | None:
    try:
        p = resolve_path(args.get("path", ""))
    except Exception:
        return None
    if p.suffix.lower() in _RUNNABLE:
        return Risk(str(p), "RUNS this program or script on your PC.")
    return None


# ------------------------------------------------------------------ mail + calendar (connected accounts)
# ---- Mail and calendar (only available after connecting an account) ----
def _acct(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Turn account/API failures into a clean {ok: False, error} result for the model."""
    def wrapped(*a: Any, **kw: Any) -> Any:
        try:
            return fn(*a, **kw)
        except AccountError as exc:
            return {"ok": False, "error": str(exc)}
    wrapped.__name__ = fn.__name__
    return wrapped


# Risk callbacks for mail/calendar: the prompt shows the full recipient and message text,
# because sent mail cannot be taken back.
def _risk_mail_send(args: dict[str, Any]) -> Risk:
    body = str(args.get("body", ""))
    acct = str(args.get("account") or "").strip() or (accounts.connected_ids() or ["?"])[0]
    return Risk(f"To: {args.get('to', '')}  ·  Subject: {args.get('subject', '')}",
                f"SENDS this email from your {acct} account. It cannot be unsent.\n\n{body[:700]}{'…' if len(body) > 700 else ''}")


def _risk_mail_trash(args: dict[str, Any]) -> Risk:
    return Risk(str(args.get("id", "")), "Moves this email to Trash.")


def _risk_cal_create(args: dict[str, Any]) -> Risk:
    who = f" and EMAILS an invite to {args['attendees']}" if str(args.get("attendees", "")).strip() else ""
    return Risk(f"{args.get('title', '')}  ·  {args.get('start', '')} → {args.get('end', '') or '+1h'}",
                f"Adds this event to your calendar{who}.")


def _risk_cal_delete(args: dict[str, Any]) -> Risk:
    return Risk(str(args.get("id", "")), "Deletes this calendar event (attendees may be notified).")


# ------------------------------------------------------------------ power
# Start a Windows shutdown/restart with a countdown (10-300 s, default 30) so there is time to cancel.
def shutdown_computer(action: str = "shutdown", delay_seconds: int = 30) -> dict[str, Any]:
    act = "restart" if str(action).lower().startswith(("re", "boot")) else "shutdown"
    delay = max(10, min(int(delay_seconds or 30), 300))
    flag = "/r" if act == "restart" else "/s"
    r = subprocess.run(["shutdown", flag, "/t", str(delay), "/c", f"BAYMAX: {act} requested by the user"],
                       capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or r.stdout or "shutdown failed").strip()[:200]}
    return {"ok": True, "action": act, "in_seconds": delay,
            "note": f"The PC will {act} in {delay} seconds. The user can say 'cancel shutdown' to stop it."}


# Abort a pending shutdown/restart (`shutdown /a`).
def cancel_shutdown() -> dict[str, Any]:
    r = subprocess.run(["shutdown", "/a"], capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        return {"ok": False, "error": "There is no shutdown in progress."}
    return {"ok": True, "cancelled": True}


# Powering off always needs the user's on-screen approval.
def _risk_shutdown(args: dict[str, Any]) -> Risk:
    act = "RESTARTS" if str(args.get("action", "")).lower().startswith(("re", "boot")) else "SHUTS DOWN"
    return Risk("This computer", f"{act} your PC in 30 seconds. Save your work first. Unsaved changes in open programs can be lost.")


# ------------------------------------------------------------------ memory
# ---- Memory tools ----
def save_memory(category: str, fact: str) -> dict[str, Any]:
    saved = memory.add_memory(category, fact)
    return {"ok": True, **saved}


def recall_memory(query: str = "") -> dict[str, Any]:
    found = memory.search_memories(query, limit=10)
    return {"ok": True, "count": len(found), "memories": [{"category": m["category"], "fact": m["fact"]} for m in found]}


# ------------------------------------------------------------------ registry
# ---- The registry: the master list of everything BAYMAX can do ----
# Helper that builds a JSON-schema "object" for a tool's arguments.
def _obj(props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required}


_S = {"type": "string"}

# Add a new ability by writing a function above and registering it here.
# `risk=` makes it ask first when dangerous; `destructive=True` makes it always ask.
TOOLS: list[Tool] = [
    Tool("read_file", "Read a text file and return its contents.", _obj({"path": {**_S, "description": "File path (relative = workspace)"}}, ["path"]), read_file, group="files"),
    Tool("list_directory", "List files and folders in a directory.", _obj({"path": {**_S, "description": "Directory path, default workspace"}}, []), list_directory, group="files"),
    Tool("create_folder", "Create a new folder (and any missing parents).", _obj({"path": _S}, ["path"]), create_folder, group="files"),
    Tool("create_file", "Create a text file with the given content. Overwriting an existing file needs user authorization.", _obj({"path": _S, "content": {**_S, "description": "Full text content"}}, ["path", "content"]), create_file, risk=_risk_create_file, group="files"),
    Tool("move_or_rename_file", "Move or rename a file/folder. Anything outside the workspace needs user authorization.", _obj({"source": _S, "destination": _S}, ["source", "destination"]), move_or_rename_file, risk=_risk_move, group="files"),
    Tool("delete_path", "Delete a file or folder (Recycle Bin). Always needs user authorization.", _obj({"path": _S}, ["path"]), delete_path, risk=_risk_delete, group="files", destructive=True),
    Tool("open_url_in_browser", "Open a URL in the user's default web browser.", _obj({"url": _S}, ["url"]), open_url_in_browser, group="web"),
    Tool("web_search", "Search the web (DuckDuckGo) and return titles, URLs and snippets.", _obj({"query": _S, "max_results": {"type": "integer", "description": "1-10, default 5"}}, ["query"]), web_search, group="web", card="search"),
    Tool("fetch_webpage_data", "Download a web page and return its cleaned text, title and links.", _obj({"url": _S, "max_chars": {"type": "integer", "description": "Max characters of text, default 6000"}}, ["url"]), fetch_webpage_data, group="web", card="page"),
    Tool("launch_application", "Launch a Windows application by name (notepad, calculator, chrome, spotify, ...).", _obj({"name": _S}, ["name"]), launch_application, group="system"),
    Tool("get_system_stats", "Get current CPU, RAM, GPU and disk usage.", _obj({}, []), get_system_stats, group="system"),
    Tool("run_powershell_command", "Run a PowerShell command. Always needs user authorization.", _obj({"command": _S, "timeout_seconds": {"type": "integer"}}, ["command"]), run_powershell_command, risk=_risk_powershell, group="system", destructive=True),
    Tool("search_files", "Find files anywhere on this PC by name (and optionally by text inside documents) using the Windows search index. Use this whenever the user asks to find a file or document.", _obj({"query": {**_S, "description": "Words from the file name, or text to find inside files"}, "folder": {**_S, "description": "Limit to this folder (default: the user's whole profile)"}, "search_inside_files": {"type": "boolean", "description": "true = search file contents, not just names"}, "limit": {"type": "integer"}}, ["query"]), search_files, group="files"),
    Tool("open_path", "Open a file or folder with its default app / File Explorer. Programs and scripts need user authorization.", _obj({"path": _S}, ["path"]), open_path, risk=_risk_open_path, group="files"),
    Tool("list_processes", "List the running programs using the most memory or CPU.", _obj({"limit": {"type": "integer"}, "sort_by": {**_S, "description": "memory or cpu"}}, []), list_processes, group="system"),
    Tool("mail_search", "Search the user's email (Gmail/Outlook). Empty query = latest inbox. Gmail syntax works (is:unread, from:x, newer_than:2d); Outlook takes plain words or 'unread'.", _obj({"query": _S, "limit": {"type": "integer", "description": "1-20, default 8"}, "account": {**_S, "description": "google or microsoft; omit to search all connected"}}, []), _acct(mailcal.mail_search), group="mail"),
    Tool("mail_read", "Read one email in full using the id from mail_search.", _obj({"id": {**_S, "description": "e.g. google:18c2... or microsoft:AAMk..."}}, ["id"]), _acct(mailcal.mail_read), group="mail"),
    Tool("mail_send", "Send an email. Always needs user authorization (the user sees the full message first).", _obj({"to": {**_S, "description": "Recipient address(es), comma separated"}, "subject": _S, "body": _S, "account": {**_S, "description": "google or microsoft; omit for the default"}}, ["to", "subject", "body"]), _acct(mailcal.mail_send), risk=_risk_mail_send, group="mail", destructive=True),
    Tool("mail_trash", "Move an email to Trash. Always needs user authorization.", _obj({"id": _S}, ["id"]), _acct(mailcal.mail_trash), risk=_risk_mail_trash, group="mail", destructive=True),
    Tool("calendar_list", "List calendar events for the next N days (default 7) from the start of today, or from a given start time.", _obj({"days": {"type": "integer"}, "start": {**_S, "description": "ISO date/time, default start of today"}, "account": _S}, []), _acct(mailcal.calendar_list), group="calendar"),
    Tool("calendar_create", "Create a calendar event. Always needs user authorization. Times are ISO 8601 in the user's local time, e.g. 2026-03-05T15:00.", _obj({"title": _S, "start": _S, "end": {**_S, "description": "Default: start + 1 hour"}, "description": _S, "attendees": {**_S, "description": "Comma separated emails; they get an invite"}, "account": _S}, ["title", "start"]), _acct(mailcal.calendar_create), risk=_risk_cal_create, group="calendar", destructive=True),
    Tool("calendar_delete", "Delete a calendar event by id from calendar_list. Always needs user authorization.", _obj({"id": _S}, ["id"]), _acct(mailcal.calendar_delete), risk=_risk_cal_delete, group="calendar", destructive=True),
    Tool("shutdown_computer", "Shut down or restart this PC after a 30 second countdown. Always needs user authorization.", _obj({"action": {**_S, "description": "shutdown or restart"}}, []), shutdown_computer, risk=_risk_shutdown, group="system", destructive=True),
    Tool("cancel_shutdown", "Cancel a pending shutdown or restart.", _obj({}, []), cancel_shutdown, group="system"),
    Tool("save_memory", "Save a lasting fact or preference about the user to long-term memory.", _obj({"category": {**_S, "description": "e.g. preference, personal, project, reminder"}, "fact": _S}, ["category", "fact"]), save_memory, group="memory"),
    Tool("recall_memory", "Search long-term memory for facts related to a query.", _obj({"query": _S}, ["query"]), recall_memory, group="memory"),
]

# Quick lookup by tool name.
REGISTRY: dict[str, Tool] = {t.name: t for t in TOOLS}


# Tools the user switched off in the Tools tab (stored in settings).
def disabled_tools() -> set[str]:
    try:
        return set(json.loads(memory.get_setting("disabled_tools", "[]") or "[]"))
    except (ValueError, TypeError):
        return set()


def set_tool_enabled(name: str, enabled: bool) -> None:
    if name not in REGISTRY:
        raise KeyError(name)
    off = disabled_tools()
    off.discard(name) if enabled else off.add(name)
    memory.set_setting("disabled_tools", json.dumps(sorted(off)))


# (Mail/calendar tools stay hidden from the model until an account is connected.)
def _usable(t: Tool) -> bool:
    """Mail/calendar tools only exist for the model once an account is connected (fewer tools = better small-model accuracy)."""
    return t.group not in ("mail", "calendar") or bool(accounts.connected_ids())


# The tools actually offered to the model on this turn.
def active_schemas() -> list[dict[str, Any]]:
    off = disabled_tools()
    return [t.schema() for t in TOOLS if t.name not in off and _usable(t)]


# The tool list shown in the UI (name, group, on/off, whether it asks first, ...).
def describe_tools() -> list[dict[str, Any]]:
    off = disabled_tools()
    return [
        {
            "name": t.name,
            "description": t.description,
            "group": t.group,
            "enabled": t.name not in off,
            "gated": t.destructive,
            "conditional": (t.risk is not None and not t.destructive and t.name in ("create_file", "move_or_rename_file", "open_path")),
            "needs_account": not _usable(t),
        }
        for t in TOOLS
    ]
