"""The call page: a hidden frontend panel at /ig-doorbell?device=<device_id> (1.2.0).

What a ring notification opens and where an Android wall panel is sent on a ring
(docs/design/ha-only-ringing.md). Registered by the integration so nobody has to build a dashboard
view for the doorbell experience to work.

- **Hidden from the sidebar** (no title): it is a destination, not a place to browse to.
- **Not admin-only**: the family's non-admin users are exactly who answers the door.
- It only hosts the card (frontend/ig-doorbell-panel.js): one implementation of every behaviour.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import CALL_PAGE_PATH, CONF_DEVICE_ID, DOMAIN

_LOGGER = logging.getLogger(__name__)

PANEL_FILENAME = "ig-doorbell-panel.js"
PANEL_PATH = Path(__file__).parent / "frontend" / PANEL_FILENAME
PANEL_URL = f"/{DOMAIN}/{PANEL_FILENAME}"
DATA_PANEL = f"{DOMAIN}_panel"


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


async def async_register_call_page(hass: HomeAssistant) -> None:
    """Serve the panel module and (re-)register the page with the current doorbell list.

    ⚠️ UNDER A LOCK, and it is not decoration. Home Assistant sets up the config entries of one
    integration CONCURRENTLY, so with two doorbells both passed the "not registered yet" check
    before either had registered the static route, and the second one failed with aiohttp's
    "method GET is already registered" - its whole entry in `setup_error`, which Home Assistant does
    not retry. Lived on a real installation on 2026-09-27: the doorbell that lost the race stopped
    reaching Home Assistant until the entry was reloaded by hand.
    """
    if "frontend" not in hass.config.components:
        _LOGGER.warning("The frontend is not loaded: no call page")
        return
    lock = hass.data.setdefault(f"{DATA_PANEL}_lock", asyncio.Lock())
    async with lock:
        await _async_register_locked(hass)


async def _async_register_locked(hass: HomeAssistant) -> None:
    from homeassistant.components import frontend, panel_custom

    if DATA_PANEL not in hass.data:
        digest = await hass.async_add_executor_job(_digest, PANEL_PATH)
        await hass.http.async_register_static_paths(
            [StaticPathConfig(PANEL_URL, str(PANEL_PATH), False)]
        )
        hass.data[DATA_PANEL] = f"{PANEL_URL}?v={digest}"
    devices = [e.data.get(CONF_DEVICE_ID) for e in hass.config_entries.async_entries(DOMAIN)
               if e.data.get(CONF_DEVICE_ID)]
    # Re-registered so the list of doorbells (used when the URL has no ?device=) stays current.
    frontend.async_remove_panel(hass, CALL_PAGE_PATH, warn_if_unknown=False)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=CALL_PAGE_PATH,
        webcomponent_name="ig-doorbell-panel",
        module_url=hass.data[DATA_PANEL],
        sidebar_title=None,
        sidebar_icon=None,
        require_admin=False,
        config={"devices": devices},
    )
