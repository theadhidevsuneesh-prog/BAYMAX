"""Connected accounts (Google: Gmail + Calendar, Microsoft: Outlook mail + Calendar).

Standard OAuth 2.0 'installed app' flow with PKCE and a loopback redirect. The user creates their own
(free) OAuth client once and pastes the Client ID; BAYMAX never ships shared credentials. Refresh tokens
are encrypted with Windows DPAPI (same as API keys) and only ever sent to the provider that issued them.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from . import memory, providers

# The two supported account types: endpoints, the permissions ("scopes") requested, and which loopback
# host to use for the sign-in redirect (Google wants 127.0.0.1, Microsoft wants localhost).
PROVIDERS: dict[str, dict[str, Any]] = {
    "google": {
        "label": "Google", "covers": "Gmail + Google Calendar", "needs_secret": True, "loopback": "127.0.0.1",
        "auth_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://openidconnect.googleapis.com/v1/userinfo",
        "scopes": ["openid", "email", "https://www.googleapis.com/auth/gmail.modify",
                   "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/calendar.events"],
        "extra_auth": {"access_type": "offline", "prompt": "consent"},
        "console_url": "https://console.cloud.google.com/apis/credentials",
    },
    "microsoft": {
        "label": "Microsoft", "covers": "Outlook mail + Outlook Calendar", "needs_secret": False, "loopback": "localhost",
        "auth_url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "token_url": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "userinfo_url": "https://graph.microsoft.com/v1.0/me",
        "scopes": ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"],
        "extra_auth": {"prompt": "select_account"},
        "console_url": "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    },
}


# A problem with an account that is safe to show to the user as-is.
class AccountError(RuntimeError):
    pass


# ───────────────────────────────────────────────────────────── storage
# ---- Encrypted storage: client ids and tokens are protected with Windows DPAPI before saving ----
def _put(key: str, obj: dict[str, Any]) -> None:
    memory.set_setting(key, base64.b64encode(providers._dpapi(json.dumps(obj).encode(), True)).decode())


def _get(key: str) -> dict[str, Any]:
    raw = memory.get_setting(key, "") or ""
    if not raw:
        return {}
    try:
        return json.loads(providers._dpapi(base64.b64decode(raw), False).decode())
    except Exception:
        return {}


# The user's own OAuth client id (and secret, for Google) that they pasted into the Connect tab.
def get_config(pid: str) -> dict[str, Any]:
    return _get(f"acct:{pid}:config")


# Validate and save the client credentials. Re-saving the id keeps an existing secret.
def set_config(pid: str, client_id: str, client_secret: str = "") -> None:
    if pid not in PROVIDERS:
        raise ValueError("unknown account type")
    client_id, client_secret = (client_id or "").strip(), (client_secret or "").strip()
    if not (10 <= len(client_id) <= 300) or any(c.isspace() for c in client_id):
        raise ValueError("That doesn't look like a Client ID.")
    old = get_config(pid)
    if PROVIDERS[pid]["needs_secret"] and not client_secret:
        client_secret = old.get("client_secret", "")
    if PROVIDERS[pid]["needs_secret"] and not client_secret:
        raise ValueError("Google also needs the Client secret from the same page.")
    _put(f"acct:{pid}:config", {"client_id": client_id, "client_secret": client_secret})


# Forget the sign-in (token) but keep the client id so reconnecting is one click.
def disconnect(pid: str) -> None:
    memory.set_setting(f"acct:{pid}:token", "")


# Forget everything about this account type, including the client id.
def forget(pid: str) -> None:
    disconnect(pid)
    memory.set_setting(f"acct:{pid}:config", "")


# True when we hold a refresh token (the long-lived proof of sign-in).
def connected(pid: str) -> bool:
    return bool(_get(f"acct:{pid}:token").get("refresh_token"))


def email_of(pid: str) -> str:
    return _get(f"acct:{pid}:token").get("email", "")


def connected_ids() -> list[str]:
    return [p for p in PROVIDERS if connected(p)]


# What the Connect tab shows. Never includes secrets or tokens.
def describe() -> list[dict[str, Any]]:
    out = []
    for pid, p in PROVIDERS.items():
        cfg = get_config(pid)
        out.append({
            "id": pid, "label": p["label"], "covers": p["covers"], "needs_secret": p["needs_secret"],
            "console_url": p["console_url"], "has_config": bool(cfg.get("client_id")),
            "client_hint": (cfg.get("client_id", "")[:8] + "…") if cfg.get("client_id") else "",
            "connected": connected(pid), "email": email_of(pid), "redirect_host": p["loopback"],
            "pending": pid in _flows and _flows[pid].alive(),
        })
    return out


# ───────────────────────────────────────────────────────────── tokens
# ---- Token handling ----
# Call the provider's token endpoint. An "invalid_grant" means the sign-in expired or was revoked,
# so the account is disconnected and the user is asked to reconnect.
def _post_token(pid: str, data: dict[str, str]) -> dict[str, Any]:
    p, cfg = PROVIDERS[pid], get_config(pid)
    body = {**data, "client_id": cfg.get("client_id", "")}
    if cfg.get("client_secret"):
        body["client_secret"] = cfg["client_secret"]
    try:
        r = httpx.post(p["token_url"], data=body, timeout=20)
    except httpx.HTTPError as exc:
        raise AccountError(f"Could not reach {p['label']}: {exc.__class__.__name__}") from exc
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200:
        err = j.get("error_description") or j.get("error") or f"HTTP {r.status_code}"
        if j.get("error") == "invalid_grant":
            disconnect(pid)
            raise AccountError(f"{p['label']} sign-in expired. Reconnect it in the Connect tab.")
        raise AccountError(f"{p['label']} refused the request: {str(err)[:200]}")
    return j


# A valid short-lived access token, refreshed when needed. Microsoft rotates refresh tokens, so a new one is saved.
def access_token(pid: str) -> str:
    tok = _get(f"acct:{pid}:token")
    if not tok.get("refresh_token"):
        raise AccountError(f"{PROVIDERS[pid]['label']} is not connected. Open the Connect tab in the HUD.")
    if tok.get("access_token") and tok.get("expires_at", 0) - 60 > time.time():
        return tok["access_token"]
    j = _post_token(pid, {"grant_type": "refresh_token", "refresh_token": tok["refresh_token"]})
    tok.update(access_token=j["access_token"], expires_at=time.time() + int(j.get("expires_in", 3600)))
    if j.get("refresh_token"):  # Microsoft rotates it
        tok["refresh_token"] = j["refresh_token"]
    _put(f"acct:{pid}:token", tok)
    return tok["access_token"]


# ───────────────────────────────────────────────────────────── OAuth loopback flow
# ---- Browser sign-in (OAuth 2.0 with PKCE and a loopback redirect) ----
# One sign-in attempt: starts a tiny local web server on a random port, the browser returns the
# user there with a one-time code, and the code is exchanged for tokens. Nothing is shared with anyone else.
class _Flow:
    def __init__(self, pid: str, on_done: Callable[[bool, str], None]) -> None:
        self.pid, self.on_done = pid, on_done
        # `state` stops forged redirects; `verifier`/challenge (PKCE) stops a stolen code from being used elsewhere.
        self.state = secrets.token_urlsafe(24)
        self.verifier = secrets.token_urlsafe(64)
        self.result: dict[str, str] = {}
        self.abandoned = False
        self.event = threading.Event()
        flow = self

        # Receives the redirect from the browser and shows a small "you can close this tab" page.
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                q = parse_qs(urlparse(self.path).query)
                if urlparse(self.path).path != "/callback":
                    self.send_response(404)
                    self.end_headers()
                    return
                flow.result = {k: v[0] for k, v in q.items()}
                ok = flow.result.get("state") == flow.state and "code" in flow.result
                msg = ("You're connected. You can close this tab and go back to BAYMAX."
                       if ok else "That didn't work. Go back to BAYMAX and try again.")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(("<html><body style='font-family:Segoe UI,sans-serif;text-align:center;padding:12vh 1rem'>"
                                  f"<h2>BAYMAX</h2><p>{msg}</p></body></html>").encode())
                flow.event.set()

        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self._run, daemon=True)

    def redirect_uri(self) -> str:
        return f"http://{PROVIDERS[self.pid]['loopback']}:{self.port}/callback"

    # The sign-in page address (client id, redirect, permissions, PKCE challenge).
    def url(self) -> str:
        p, cfg = PROVIDERS[self.pid], get_config(self.pid)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(self.verifier.encode()).digest()).rstrip(b"=").decode()
        q = {"client_id": cfg["client_id"], "redirect_uri": self.redirect_uri(), "response_type": "code",
             "scope": " ".join(p["scopes"]), "state": self.state, "code_challenge": challenge,
             "code_challenge_method": "S256", **p.get("extra_auth", {})}
        return f"{p['auth_url']}?{urlencode(q)}"

    def alive(self) -> bool:
        return self.thread.is_alive()

    # Wait up to 4 minutes for the browser to come back, exchange the code, save the tokens, then report the result.
    def _run(self) -> None:
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        try:
            if not self.event.wait(240):
                return self.on_done(False, "Timed out waiting for the sign-in page.")
            if self.abandoned:
                return
            if "error" in self.result:
                return self.on_done(False, f"Sign-in was cancelled ({self.result.get('error_description') or self.result['error']}).")
            if self.result.get("state") != self.state or "code" not in self.result:
                return self.on_done(False, "Sign-in could not be verified. Try again.")
            j = _post_token(self.pid, {"grant_type": "authorization_code", "code": self.result["code"],
                                       "redirect_uri": self.redirect_uri(), "code_verifier": self.verifier})
            tok = {"refresh_token": j.get("refresh_token", ""), "access_token": j["access_token"],
                   "expires_at": time.time() + int(j.get("expires_in", 3600)), "email": ""}
            if not tok["refresh_token"]:
                return self.on_done(False, "No refresh token was granted. Remove BAYMAX from your account's connected apps and try again.")
            _put(f"acct:{self.pid}:token", tok)
            try:
                u = httpx.get(PROVIDERS[self.pid]["userinfo_url"], headers={"Authorization": f"Bearer {tok['access_token']}"}, timeout=15).json()
                tok["email"] = u.get("email") or u.get("mail") or u.get("userPrincipalName") or ""
                _put(f"acct:{self.pid}:token", tok)
            except Exception:
                pass
            self.on_done(True, f"Connected {tok['email'] or PROVIDERS[self.pid]['label']}.")
        except AccountError as exc:
            self.on_done(False, str(exc))
        except Exception as exc:  # never crash the thread silently
            self.on_done(False, f"Sign-in failed: {exc.__class__.__name__}")
        finally:
            self.server.shutdown()
            self.server.server_close()


# At most one running sign-in per account type; starting a new one cancels the old one.
_flows: dict[str, _Flow] = {}


# Start signing in and open the user's browser. `on_done(ok, message)` is called when it finishes.
def begin(pid: str, on_done: Callable[[bool, str], None], open_browser: bool = True) -> str:
    """Start the sign-in. Returns the URL (also opened in the default browser)."""
    if pid not in PROVIDERS:
        raise ValueError("unknown account type")
    if not get_config(pid).get("client_id"):
        raise AccountError("Save your Client ID first.")
    old = _flows.get(pid)
    if old and old.alive():
        old.abandoned = True  # abandon the previous attempt silently
        old.event.set()
    flow = _Flow(pid, on_done)
    _flows[pid] = flow
    flow.thread.start()
    url = flow.url()
    if open_browser:
        webbrowser.open(url)
    return url
