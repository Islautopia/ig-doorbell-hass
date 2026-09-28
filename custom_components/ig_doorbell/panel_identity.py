"""Which companion-app device a Home Assistant page is running in (1.2.4).

Wall-panel behaviour (back to the home page after a call, the call page shown in place on a ring)
applies ONLY to companion devices picked as panels in a doorbell's Ring notifications options
(Iñaki, 2026-09-28). So the integration needs to know, for a page, WHICH `mobile_app` device it is
in - never a guess.

What was measured (2026-09-28, salon Galaxy Tab, Android companion 2026.6.5, HA 2026.9.3):
- The companion's external bus (`config/get`) says nothing about the device: capability flags and
  the app version only. No device id, no webhook id, no name.
- The page's websocket authenticates with the COMPANION'S OWN refresh token (the external auth hands
  the WebView an access token of the app's login): client_id `https://home-assistant.io/android`,
  one per installation (a reinstall made a new one; the old one stayed, unused).
- Home Assistant does NOT link that refresh token to the `mobile_app` registration: the
  registration stores only the user id.
- IP matching (the companion's IP sensor) was rejected: the Android sensor is disabled by default,
  and the iOS companion has no IP sensor at all.
- The user agent carries the model on Android only; the iPad's has none (1.2.3's failure).

So the identity is, in order (and nothing else):
1. EXACT - a refresh token bound to a device. The binding is proved, not inferred: every URL the
   notifier sends to a picked panel carries a one-use nonce (`igd_panel`) that only that device
   received (its own push), and the page that opens it presents the nonce over its websocket. The
   refresh token of THAT connection is then that device, for as long as the app keeps its login.
2. UNIQUE USER - the connection's refresh token was issued to a companion app (its client_id is one
   of the two that Home Assistant's own login only lets the companions use), and the page's user
   has exactly ONE companion registration of that platform. Anything more is ambiguous: no answer.
3. Nothing. Callers fail CLOSED on None.
"""
from __future__ import annotations

import logging
import secrets
import time
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.storage import Store

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

DATA = f"{DOMAIN}_panel_identity"
STORE_KEY = f"{DOMAIN}.panel_identity"
STORE_VERSION = 1
QUERY = "igd_panel"
# A ring notification can be tapped hours later (a missed call); the nonce must still bind then.
NONCE_TTL_S = 24 * 3600
NONCE_MAX = 200

# ⚠️ These two client ids are the ONLY ones Home Assistant's login accepts with the companions'
# redirect URIs (auth/indieauth.py: `homeassistant://auth-callback`), so a refresh token that carries
# one was issued to a companion app - a desktop browser never has one. The platform it names is
# the one the unique-user rule counts registrations of.
COMPANION_CLIENTS = {
    "https://home-assistant.io/android": "android",
    "https://home-assistant.io/iOS": "ios",
}


class PanelIdentity:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.store: Store = Store(hass, STORE_VERSION, STORE_KEY)
        self.bound: dict[str, str] = {}                     # refresh token id -> registry device id
        self.nonces: dict[str, tuple[str, float]] = {}      # nonce -> (registry device id, expires)

    async def async_load(self) -> None:
        data = await self.store.async_load() or {}
        self.bound = {str(k): str(v) for k, v in (data.get("bound") or {}).items()}

    @callback
    def _save(self) -> None:
        self.store.async_delay_save(lambda: {"bound": dict(self.bound)}, 1.0)

    @callback
    def issue(self, device_id: str) -> str:
        """A nonce for ONE URL sent to ONE picked panel (its push only)."""
        now = time.monotonic()
        for n, (_d, exp) in list(self.nonces.items()):
            if exp <= now:
                self.nonces.pop(n, None)
        while len(self.nonces) >= NONCE_MAX:
            self.nonces.pop(next(iter(self.nonces)))
        nonce = secrets.token_urlsafe(12)
        self.nonces[nonce] = (device_id, now + NONCE_TTL_S)
        return nonce

    @callback
    def bind(self, nonce: str | None, user_id: str | None, refresh_token_id: str | None) -> bool:
        """The page opened a URL only that device received: its refresh token IS that device."""
        if not nonce or not user_id or not refresh_token_id:
            return False
        held = self.nonces.get(nonce)
        if held is None or held[1] <= time.monotonic():
            return False
        device_id = held[0]
        reg = _registration(self.hass, device_id)
        # ⚠️ The nonce proves the device received it; the user and the companion client prove the
        # page that presents it is that device's app, not a link opened somewhere else.
        if reg is None or reg.get("user_id") != user_id:
            return False
        if _token_platform(self.hass, refresh_token_id) != _platform(reg):
            return False
        self.nonces.pop(nonce, None)
        if self.bound.get(refresh_token_id) != device_id:
            # One login per device: a reinstall's new login replaces the old one.
            for rt, d in list(self.bound.items()):
                if d == device_id:
                    self.bound.pop(rt)
            self.bound[refresh_token_id] = device_id
            self._save()
            _LOGGER.info("Wall panel identified by its companion login")
        return True

    @callback
    def identify(self, user_id: str | None, refresh_token_id: str | None) -> str | None:
        """The registry id of the companion device this connection is, or None (never a guess)."""
        if not user_id or not refresh_token_id:
            return None
        platform = _token_platform(self.hass, refresh_token_id)
        if platform is None:
            return None                     # not a companion login: a browser is never a panel
        device_id = self.bound.get(refresh_token_id)
        if device_id is not None:
            reg = _registration(self.hass, device_id)
            # Exact: the answer stands even when it says "not a panel" - it is never overridden
            # by the user rule below.
            return device_id if reg is not None and reg.get("user_id") == user_id else None
        mine = [d for d, reg in _registrations(self.hass)
                if reg.get("user_id") == user_id and _platform(reg) == platform]
        return mine[0] if len(mine) == 1 else None

    def summary(self) -> dict[str, Any]:
        return {"bound": len(self.bound), "nonces": len(self.nonces)}


def _platform(reg: dict) -> str:
    """Same rule as notify_ring.resolve_targets."""
    ident = f"{reg.get('app_id', '')} {reg.get('os_name', '')}".lower()
    return "android" if "android" in ident else "ios"


@callback
def _token_platform(hass: HomeAssistant, refresh_token_id: str) -> str | None:
    token = hass.auth.async_get_refresh_token(refresh_token_id)
    return COMPANION_CLIENTS.get(getattr(token, "client_id", None) or "") if token else None


@callback
def _registrations(hass: HomeAssistant) -> list[tuple[str, dict]]:
    """(registry device id, mobile_app registration data) for every companion device."""
    reg = dr.async_get(hass)
    out = []
    for e in hass.config_entries.async_entries("mobile_app"):
        for dev in dr.async_entries_for_config_entry(reg, e.entry_id):
            out.append((dev.id, dict(e.data)))
    return out


@callback
def _registration(hass: HomeAssistant, device_id: str) -> dict | None:
    dev = dr.async_get(hass).async_get(device_id)
    if dev is None:
        return None
    for eid in dev.config_entries:
        e = hass.config_entries.async_get_entry(eid)
        if e is not None and e.domain == "mobile_app":
            return dict(e.data)
    return None


@callback
def async_get(hass: HomeAssistant) -> PanelIdentity:
    pi = hass.data.get(DATA)
    if pi is None:
        pi = hass.data[DATA] = PanelIdentity(hass)
    return pi


async def async_setup(hass: HomeAssistant) -> None:
    await async_get(hass).async_load()


def with_nonce(url: str, nonce: str) -> str:
    return f"{url}{'&' if '?' in url else '?'}{QUERY}={nonce}"
