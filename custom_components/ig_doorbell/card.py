"""Serve the Lovelace card from the integration itself.

The card used to be a separate HACS repository, installed on its own and added by hand as a
dashboard resource. Two installs that had to agree on versions, and one manual step that a user
who skipped it paid for with a "Custom element doesn't exist" error. Since 1.0.0 the card ships
inside this integration: installing the integration IS installing the card.

How it reaches the browser:

  1. `frontend/ig-doorbell-card.js` is served at `CARD_URL` as a static file.
  2. That URL is registered as an extra frontend module (`frontend.add_extra_js_url`), which is
     what Home Assistant puts in every page it serves - so the card is defined on every
     dashboard with no Lovelace resource at all, and `window.customCards` makes it show up in
     the card picker.

CACHE BUSTING. The module URL carries `?v=<first 12 hex of the file's SHA-256>`. The hash, and
not the version number, because what the browser must not reuse is a different FILE: a build
that forgot to bump the version (or a local edit while debugging) still changes the hash. A new
integration version needs a Home Assistant restart anyway (new Python), and on that restart the
new URL goes into the page. A page that stays open keeps the build it loaded (Home Assistant
2026.9.3's frontend does not pick up new extra modules; docs/card.md).

The static route is registered WITHOUT long-lived cache headers (`cache_headers=False`), so even
a request for the same URL revalidates instead of trusting a month-old copy. Measured behaviour
per update path is in docs/card.md ("Updating the card").

ALSO A LOVELACE RESOURCE (1.2.1), because the extra module lives in the PAGE'S HTML and that HTML
can be old. Home Assistant's service worker serves every page outside /static, /frontend_* and /api
stale-while-revalidate, and the root route matches with `ignoreSearch` - so `/?homescreen=1` (the
installed app's start URL) keeps getting whatever `/` was cached as, while each refresh is stored
under `/?homescreen=1`, and that runtime cache has no expiry. A page cached before this integration
added its module (before 1.0.0, or during the few seconds of a Home Assistant start before
`async_setup` runs) imports no card at all: "Custom element doesn't exist" on every open, until a
Ctrl+F5 - and the next launch is broken again. Measured on 2026-09-28 in a real desktop Chrome's
cache (`/` from 2026-09-27 09:38 UTC, no card import) and reproduced on the real frontend (docs/
card.md). Lovelace resources are NOT in the HTML: the dashboard asks for them over the websocket
each time it loads, so the list is always the server's current one. The resource carries the same
URL as the extra module; the browser's module map runs it once.
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

CARD_FILENAME = "ig-doorbell-card.js"
CARD_PATH = Path(__file__).parent / "frontend" / CARD_FILENAME
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"
# The module URL actually registered (with its ?v=); also a "done" marker so a reload of the
# integration does not register the static route twice (aiohttp raises on a duplicate route).
DATA_CARD_URL = f"{DOMAIN}_card_url"
RESOURCE_TYPE = "module"


def _file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


async def async_register_card(hass: HomeAssistant) -> str | None:
    """Serve the card and load it on every frontend page. Returns the module URL."""
    if DATA_CARD_URL in hass.data:
        return hass.data[DATA_CARD_URL]
    if not CARD_PATH.is_file():
        # Loud, not silent: a missing card is a broken install, and an empty dashboard with no
        # log line is the failure that costs an afternoon.
        _LOGGER.error("The card file is missing from the install: %s", CARD_PATH)
        return None
    digest = await hass.async_add_executor_job(_file_digest, CARD_PATH)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(CARD_PATH), False)]
    )
    url = f"{CARD_URL}?v={digest}"
    hass.data[DATA_CARD_URL] = url
    if "frontend" not in hass.config.components:
        # Only happens in a stripped-down HA (or a test harness): the frontend is loaded in
        # bootstrap's first stage on every normal install, and after_dependencies orders us
        # after it. Said out loud because the symptom would be "the card does not exist".
        _LOGGER.warning("The frontend is not loaded: the card is served at %s but not "
                        "added to the pages", url)
        return url
    from homeassistant.components.frontend import add_extra_js_url

    add_extra_js_url(hass, url)
    _LOGGER.debug("Card served and added to the frontend as %s", url)
    await async_sync_lovelace_resource(hass, url)
    return url


def _lovelace_resources(hass: HomeAssistant):
    """The Lovelace resource collection, or None when there is none we can write to.

    `hass.data["lovelace"]` is a dict up to Home Assistant 2025.1 and a `LovelaceData` object after;
    both carry `resources`. In YAML resource mode it is a read-only collection with no
    `async_create_item`: then the user owns the list and we only have the extra module.
    """
    data = hass.data.get("lovelace")
    resources = data.get("resources") if isinstance(data, dict) else getattr(data, "resources", None)
    if resources is None or not hasattr(resources, "async_create_item"):
        return None
    return resources


def _is_ours(item: dict) -> bool:
    return str(item.get("url", "")).split("?", 1)[0] == CARD_URL


async def async_sync_lovelace_resource(hass: HomeAssistant, url: str | None) -> None:
    """Keep exactly one Lovelace resource for the card, at `url`; None removes it.

    Best effort, never fatal: the extra module still loads the card from a fresh page, and a broken
    integration setup would be a far worse failure than the one this guards against.
    """
    resources = _lovelace_resources(hass)
    if resources is None:
        if url is not None:
            _LOGGER.debug("Lovelace resources are not writable (YAML mode?): the card is loaded "
                          "by the extra module only")
        return
    try:
        if not resources.loaded:
            # What Home Assistant's own websocket handler does before listing them.
            await resources.async_load()
            resources.loaded = True
        ours = [item for item in resources.async_items() if _is_ours(item)]
        if url is None:
            for item in ours:
                await resources.async_delete_item(item["id"])
            return
        keep, extra = (ours[0], ours[1:]) if ours else (None, [])
        for item in extra:
            # Two entries would load two copies (the second only warns, but it is still a download).
            await resources.async_delete_item(item["id"])
        if keep is None:
            await resources.async_create_item({"res_type": RESOURCE_TYPE, "url": url})
            _LOGGER.info("Card added to the Lovelace resources as %s", url)
        elif keep.get("url") != url or keep.get("type") != RESOURCE_TYPE:
            await resources.async_update_item(keep["id"], {"res_type": RESOURCE_TYPE, "url": url})
    except Exception:  # noqa: BLE001 - see the docstring: this must never take the setup down
        _LOGGER.warning("Could not update the card's Lovelace resource; the card still loads "
                        "from the page itself", exc_info=True)
