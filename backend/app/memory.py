"""Persistent local memory (SQLite): facts, chat history and settings."""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from typing import Any

from .config import DB_PATH

# One shared SQLite connection, guarded by a lock because tools run on worker threads.
_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

# Common words ignored when matching a question against saved memories.
_STOP = {
    "the", "and", "for", "you", "that", "this", "with", "what", "was", "are", "can",
    "have", "has", "not", "but", "your", "about", "from", "into", "please", "how",
    "who", "when", "where", "why", "his", "her", "its", "they", "them", "then",
    "tell", "know", "remember", "does", "did", "any", "all", "get", "got", "let",
}


# Open (or create) the database and its three tables: memories, messages, settings.
def init() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            return
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL,
                fact TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at REAL NOT NULL,
                payload TEXT
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        cols = [r[1] for r in _conn.execute("PRAGMA table_info(messages)")]
        # Small migration so databases from older versions keep working.
        if "payload" not in cols:  # databases created by an older build
            _conn.execute("ALTER TABLE messages ADD COLUMN payload TEXT")
        _conn.commit()


# Return the open connection, opening it on first use.
def _db() -> sqlite3.Connection:
    if _conn is None:
        init()
    assert _conn is not None
    return _conn


# Lower-case keywords (3+ letters, no filler words) used for memory search.
def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]{3,}", text.lower()) if t not in _STOP]


# ---------------------------------------------------------------- memories
# Save one fact. The same fact is never stored twice (case-insensitive).
def add_memory(category: str, fact: str) -> dict[str, Any]:
    category = (category or "general").strip().lower()[:40] or "general"
    fact = (fact or "").strip()
    if not fact:
        raise ValueError("fact must not be empty")
    with _lock:
        db = _db()
        dup = db.execute(
            "SELECT id FROM memories WHERE lower(fact)=lower(?)", (fact,)
        ).fetchone()
        if dup:
            return {"id": dup["id"], "category": category, "fact": fact, "duplicate": True}
        cur = db.execute(
            "INSERT INTO memories (category, fact, created_at) VALUES (?,?,?)",
            (category, fact, time.time()),
        )
        db.commit()
        return {"id": cur.lastrowid, "category": category, "fact": fact, "duplicate": False}


def list_memories() -> list[dict[str, Any]]:
    with _lock:
        rows = _db().execute(
            "SELECT id, category, fact, created_at FROM memories ORDER BY id DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def delete_memory(memory_id: int) -> bool:
    with _lock:
        cur = _db().execute("DELETE FROM memories WHERE id=?", (memory_id,))
        _db().commit()
        return cur.rowcount > 0


# Rank memories by how many query keywords they contain.
def search_memories(query: str, limit: int = 8) -> list[dict[str, Any]]:
    """Keyword search. An empty query returns the most recent memories."""
    mems = list_memories()
    toks = _tokens(query or "")
    if not toks:
        return mems[:limit]
    scored = []
    for m in mems:
        hay = f"{m['category']} {m['fact']}".lower()
        score = sum(1 for t in toks if t in hay)
        if score:
            scored.append((score, m["id"], m))
    scored.sort(key=lambda x: (-x[0], -x[1]))
    return [m for _, _, m in scored[:limit]]


# Which memories go into the system prompt: the ones matching the user's message plus the newest few.
def relevant_for_prompt(user_text: str, limit: int = 12) -> list[dict[str, Any]]:
    """Memories injected into the system prompt: keyword hits + latest facts."""
    picked: dict[int, dict[str, Any]] = {}
    for m in search_memories(user_text, limit=limit) if _tokens(user_text) else []:
        picked[m["id"]] = m
    for m in list_memories()[:6]:
        picked.setdefault(m["id"], m)
    return list(picked.values())[:limit]


# ---------------------------------------------------------------- messages
# Chat history. `payload` keeps the full tool-call message so the model can see what it did earlier.
def add_message(role: str, content: str, payload: dict[str, Any] | None = None) -> None:
    """`payload` is the full Ollama message (tool calls / tool results) for replay."""
    if not content and not payload:
        return
    with _lock:
        _db().execute(
            "INSERT INTO messages (role, content, created_at, payload) VALUES (?,?,?,?)",
            (role, content or "", time.time(), json.dumps(payload, ensure_ascii=False) if payload else None),
        )
        _db().commit()


def _row(r: sqlite3.Row) -> dict[str, Any]:
    d = dict(r)
    try:
        d["payload"] = json.loads(d["payload"]) if d.get("payload") else None
    except ValueError:
        d["payload"] = None
    return d


def recent_messages(limit: int) -> list[dict[str, Any]]:
    """Latest raw rows (user / assistant / tool), oldest first - used to rebuild model context."""
    with _lock:
        rows = _db().execute(
            "SELECT role, content, created_at, payload FROM messages ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [_row(r) for r in reversed(rows)]


# The subset of history that makes sense to show in the chat window (no raw tool traffic).
def recent_display(limit: int) -> list[dict[str, Any]]:
    """Only what a human should see in the chat window."""
    shown = [
        m for m in recent_messages(400)
        if m["role"] in ("user", "assistant") and m["content"].strip()
        and not (m["payload"] and m["payload"].get("tool_calls"))
    ]
    return shown[-limit:]


def clear_messages() -> None:
    with _lock:
        _db().execute("DELETE FROM messages")
        _db().commit()


# ---------------------------------------------------------------- settings
# Small key/value store for preferences (selected model, disabled tools, encrypted API keys, ...).
def get_setting(key: str, default: str | None = None) -> str | None:
    with _lock:
        row = _db().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with _lock:
        _db().execute(
            "INSERT INTO settings (key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        _db().commit()
