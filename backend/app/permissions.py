"""Permission gate: pauses critical tools until the user clicks AUTHORIZE / DENY."""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Awaitable, Callable

from .config import PERMISSION_TIMEOUT_S

# A function that sends one event to every open window.
Broadcast = Callable[[dict[str, Any]], Awaitable[None]]


# Risky tools wait here until the user presses Authorize or Deny on screen.
# Nothing is ever approved automatically, by voice, or by a timeout (a timeout means "no").
class PermissionGate:
    def __init__(self) -> None:
        self._pending: dict[str, asyncio.Future[bool]] = {}

    @property
    def has_pending(self) -> bool:
        return bool(self._pending)

    # Show the prompt to the user and wait (up to PERMISSION_TIMEOUT_S) for their answer.
    async def request(self, broadcast: Broadcast, tool: str, target: str, impact: str, args: dict[str, Any]) -> bool:
        req_id = uuid.uuid4().hex[:12]
        fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        await broadcast(
            {
                "type": "PERMISSION_REQUIRED",
                "id": req_id,
                "tool": tool,
                "target": target,
                "impact": impact,
                "args": args,
                "timeout_s": PERMISSION_TIMEOUT_S,
            }
        )
        try:
            approved = await asyncio.wait_for(fut, timeout=PERMISSION_TIMEOUT_S)
        except asyncio.TimeoutError:
            approved = False
        finally:
            self._pending.pop(req_id, None)
        await broadcast({"type": "permission_resolved", "id": req_id, "approved": approved})
        return approved

    # Called when the user clicks a button in the UI.
    def resolve(self, req_id: str, approved: bool) -> bool:
        fut = self._pending.get(req_id)
        if fut and not fut.done():
            fut.set_result(bool(approved))
            return True
        return False

    # Deny everything pending (window closed, BAYMAX switched off, or the app is shutting down).
    def deny_all(self) -> None:
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_result(False)
