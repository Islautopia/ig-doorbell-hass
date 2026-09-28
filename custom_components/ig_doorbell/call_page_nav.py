"""Bring a wall panel to the call page WITHOUT opening a new companion window (1.2.2).

⚠️ WHY THIS EXISTS - measured on the salon wall panel (Galaxy Tab A8, Home Assistant companion
2026.6.5, 2026-09-28): `command_webview` starts the companion's WebViewActivity with
FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_MULTIPLE_TASK (intent flg=0x18800000), so EVERY ring stacked
one more task, each with its own WebView, its own page and its own card: four of them after a few
rings (`dumpsys activity activities`, tasks #100-#103). A `homeassistant://navigate/...` deep link is
no better: it stacks a new WebViewActivity inside the front task. Only a navigation INSIDE the page
already on screen reuses the window - and only the page can do that.

So, for an Android panel: the card module (loaded on every Home Assistant page) subscribes here.
On a ring the notifier asks the page(s) of THAT companion device to navigate to the call page; a
page that is VISIBLE does it in place and acknowledges. No acknowledgement in time (app closed, page never loaded) and
the notifier falls back to `command_webview` - a new window is better than no call page.

(1.2.4) A page is matched by its companion DEVICE (panel_identity.py: the refresh token of its
websocket, bound to the device or unique for its user) - no longer by the model in the user agent,
which the iPad's does not carry. A page that cannot be identified is never asked.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from homeassistant.core import HomeAssistant, callback

from . import panel_identity
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
    token_id: str | None      # the refresh token of the page's websocket (panel_identity.py)
    send: Callable[[dict], None]


@dataclass
class _Pending:
    device_id: str            # the registry device id of the panel
    url: str
    expires: float
    fut: asyncio.Future = field(repr=False)


def _matches(hass: HomeAssistant, device_id: str | None, user_id: str | None,
             token_id: str | None) -> bool:
    return bool(device_id) and panel_identity.async_get(hass).identify(user_id, token_id) == device_id


class CallPageNav:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.subs: dict[int, _Sub] = {}
        self.seen: dict[tuple[str, str | None], float] = {}  # (user_id, token_id) -> last subscribed
        self.pending: dict[str, _Pending] = {}
        self._next = 0

    @callback
    def async_subscribe(self, user_id: str, token_id: str | None,
                        send: Callable[[dict], None]) -> Callable[[], None]:
        self._next += 1
        key = self._next
        self.subs[key] = _Sub(user_id, token_id, send)
        self.seen[(user_id, token_id)] = time.monotonic()
        now = time.monotonic()
        # A page that (re)connects while a ring waits for it: the request is delivered now.
        for token, p in list(self.pending.items()):
            if p.expires > now and _matches(self.hass, p.device_id, user_id, token_id):
                send({"token": token, "url": p.url})

        @callback
        def _unsub() -> None:
            sub = self.subs.pop(key, None)
            if sub is not None:
                self.seen[(sub.user_id, sub.token_id)] = time.monotonic()
        return _unsub

    @callback
    def async_ack(self, token: str, user_id: str | None, token_id: str | None) -> bool:
        p = self.pending.get(token)
        if p is None or not _matches(self.hass, p.device_id, user_id, token_id) or p.fut.done():
            return False
        p.fut.set_result(True)
        return True

    async def async_show(self, device_id: str | None, url: str) -> bool:
        """Ask the panel's page to navigate in place. True = a visible page did it."""
        if not device_id:
            return False
        now = time.monotonic()
        live = [s for s in self.subs.values() if _matches(self.hass, device_id, s.user_id, s.token_id)]
        recent = any(now - t < RECENT_S for (u, tid), t in self.seen.items()
                     if _matches(self.hass, device_id, u, tid))
        wait = ACK_LIVE_S if live else ACK_RECENT_S if recent else 0.0
        if not wait:
            return False
        token = secrets.token_hex(8)
        fut: asyncio.Future = self.hass.loop.create_future()
        self.pending[token] = _Pending(device_id, url, now + PENDING_S, fut)
        for s in live:
            s.send({"token": token, "url": url})
        try:
            return await asyncio.wait_for(fut, wait)
        except asyncio.TimeoutError:
            _LOGGER.info("Call page: no page of the panel answered in %.0f s", wait)
            return False
        finally:
            self.pending.pop(token, None)


@callback
def is_configured_panel(hass: HomeAssistant, user_id: str | None, token_id: str | None) -> bool:
    """Is this page a wall panel picked in some doorbell's Ring notifications options? (1.2.3)

    ⚠️ ONLY a positively identified panel gets the "back to the home page" deadline (Iñaki,
    2026-09-28: his desktop PC was being sent to the home page too). A desktop browser or a phone
    is ATTENDED: whoever opened the card there closes it; the card never navigates it away.

    (1.2.4) The page's identity is its companion DEVICE (panel_identity.py): the refresh token of
    its websocket, bound to the device by a nonce only that device received, or the only companion
    of its platform that the page's user has. A browser, an ambiguous user, a page not identified
    yet - not a panel, and fails CLOSED: never navigated.
    """
    device_id = panel_identity.async_get(hass).identify(user_id, token_id)
    if device_id is None:
        return False
    from .const import CONF_NOTIFY_PANELS  # noqa: PLC0415

    for entry in hass.config_entries.async_entries(DOMAIN):
        if device_id in (entry.options.get(CONF_NOTIFY_PANELS) or []):
            return True
    return False


@callback
def async_get(hass: HomeAssistant) -> CallPageNav:
    nav = hass.data.get(DATA_CALL_PAGE_NAV)
    if nav is None:
        nav = hass.data[DATA_CALL_PAGE_NAV] = CallPageNav(hass)
    return nav


def summary(nav: CallPageNav) -> dict[str, Any]:
    """For diagnostics and tests."""
    return {"subs": len(nav.subs), "pending": len(nav.pending),
            **panel_identity.async_get(nav.hass).summary()}
