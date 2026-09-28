"""Bring a wall panel to the call page WITHOUT opening a new companion window (1.2.2).

⚠️ WHY THIS EXISTS - measured on the salon wall panel (Galaxy Tab A8, Home Assistant companion
2026.6.5, 2026-09-28): `command_webview` starts the companion's WebViewActivity with
FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_MULTIPLE_TASK (intent flg=0x18800000), so EVERY ring stacked
one more task, each with its own WebView, its own page and its own card: four of them after a few
rings (`dumpsys activity activities`, tasks #100-#103). A `homeassistant://navigate/...` deep link is
no better: it stacks a new WebViewActivity inside the front task. Only a navigation INSIDE the page
already on screen reuses the window - and only the page can do that.

So, for an Android panel: the card module (loaded on every Home Assistant page) subscribes here,
saying who it is (the user, and the WebView's user agent, which carries the device model). On a
ring the notifier asks the matching page(s) to navigate to the call page; a page that is VISIBLE
does it in place and acknowledges. No acknowledgement in time (app closed, page never loaded) and
the notifier falls back to `command_webview` - a new window is better than no call page.

Matching is by Home Assistant user + the model in the user agent, both from the companion's own
registration (mobile_app entry data). Loose on purpose and harmless when loose: the worst case is
another visible page of the same user on the same model showing the call page.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

DATA_CALL_PAGE_NAV = f"{DOMAIN}_call_page_nav"
# A page subscribed right now: its answer (navigate + ack) takes well under a second when it is in
# front; the margin covers a screen that command_screen_on is still waking.
ACK_LIVE_S = 5.0
# A page seen recently but not subscribed now: the frontend drops its websocket while hidden (a
# screen that went off) and reconnects when it is shown again - which command_screen_on does.
ACK_RECENT_S = 8.0
RECENT_S = 7 * 24 * 3600
PENDING_S = 15.0


@dataclass
class _Sub:
    user_id: str
    ua: str
    send: Callable[[dict], None]


@dataclass
class _Pending:
    user_id: str
    model: str
    url: str
    expires: float
    fut: asyncio.Future = field(repr=False)


def _matches(user_id: str, model: str, sub_user: str, ua: str) -> bool:
    return bool(model) and sub_user == user_id and model.lower() in (ua or "").lower()


class CallPageNav:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.subs: dict[int, _Sub] = {}
        self.seen: dict[tuple[str, str], float] = {}       # (user_id, ua) -> last subscribed
        self.pending: dict[str, _Pending] = {}
        self._next = 0

    @callback
    def async_subscribe(self, user_id: str, ua: str, send: Callable[[dict], None]) -> Callable[[], None]:
        self._next += 1
        key = self._next
        self.subs[key] = _Sub(user_id, ua, send)
        self.seen[(user_id, ua)] = time.monotonic()
        now = time.monotonic()
        # A page that (re)connects while a ring waits for it: the request is delivered now.
        for token, p in list(self.pending.items()):
            if p.expires > now and _matches(p.user_id, p.model, user_id, ua):
                send({"token": token, "url": p.url})

        @callback
        def _unsub() -> None:
            sub = self.subs.pop(key, None)
            if sub is not None:
                self.seen[(sub.user_id, sub.ua)] = time.monotonic()
        return _unsub

    @callback
    def async_ack(self, token: str, user_id: str) -> bool:
        p = self.pending.get(token)
        if p is None or p.user_id != user_id or p.fut.done():
            return False
        p.fut.set_result(True)
        return True

    async def async_show(self, user_id: str | None, model: str | None, url: str) -> bool:
        """Ask the panel's page to navigate in place. True = a visible page did it."""
        if not user_id or not model:
            return False
        now = time.monotonic()
        live = [s for s in self.subs.values() if _matches(user_id, model, s.user_id, s.ua)]
        recent = any(now - t < RECENT_S for (u, ua), t in self.seen.items()
                     if _matches(user_id, model, u, ua))
        wait = ACK_LIVE_S if live else ACK_RECENT_S if recent else 0.0
        if not wait:
            return False
        token = secrets.token_hex(8)
        fut: asyncio.Future = self.hass.loop.create_future()
        self.pending[token] = _Pending(user_id, model, url, now + PENDING_S, fut)
        for s in live:
            s.send({"token": token, "url": url})
        try:
            return await asyncio.wait_for(fut, wait)
        except asyncio.TimeoutError:
            _LOGGER.info("Call page: no page of the panel (%s) answered in %.0f s", model, wait)
            return False
        finally:
            self.pending.pop(token, None)


@callback
def async_get(hass: HomeAssistant) -> CallPageNav:
    nav = hass.data.get(DATA_CALL_PAGE_NAV)
    if nav is None:
        nav = hass.data[DATA_CALL_PAGE_NAV] = CallPageNav(hass)
    return nav


def summary(nav: CallPageNav) -> dict[str, Any]:
    """For diagnostics and tests."""
    return {"subs": len(nav.subs), "pending": len(nav.pending)}
