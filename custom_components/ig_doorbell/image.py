"""The visitor's picture for the ring notification (1.2.0, docs/design/ha-only-ringing.md).

## Why an `image` entity

A phone outside the house cannot reach the doorbell - it can reach Home Assistant. So the picture a
notification shows has to be served BY Home Assistant, and `/api/image_proxy/image.<id>` is the
path the companion apps document for exactly this. It is also what someone writing their own
automation expects to find: an entity, not a private URL.

## Privacy (principle 2), and why this looks the way it does

- Fetched with `for=alert`, so the owner's `call_snap` = 0 refuses it (`403`) and the entity is
  CLEARED: no picture, and no old visitor passed off as the current one. Never retried.
- ONE frame, in RAM only. Replaced on the next ring, gone on restart. Never written to disk here;
  HA's recorder stores this entity's state (a timestamp), not the picture.
- The push through Apple/Google carries text and a URL; the phone downloads the picture from the
  owner's own Home Assistant.

## Why the notification does not wait for it

§3.5: never delay the ring for a picture. The notification is sent at once; the phone asks for the
picture a moment later, and `async_image` waits (bounded) for the fetch already in flight.
"""
from __future__ import annotations

import asyncio
import logging
import time

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.util import dt as dt_util

from . import api
from .const import DOMAIN, SIGNAL_EVENT, SNAPSHOT_TIMEOUT_S
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity

_LOGGER = logging.getLogger(__name__)

# A picture asked for later than this after the ring would show whoever is there NOW, not the
# visitor who rang: not fetched.
LAZY_WINDOW_S = 60


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    coordinator: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    entity = VisitorImage(coordinator)
    hass.data[DOMAIN][entry.entry_id]["visitor_image"] = entity
    async_add_entities([entity])


class VisitorImage(DoorbellEntity, ImageEntity):
    """The picture taken when the bell was last pressed."""

    _attr_translation_key = "visitor"
    _attr_content_type = "image/jpeg"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        DoorbellEntity.__init__(self, coordinator, "visitor")
        ImageEntity.__init__(self, coordinator.hass)
        self._jpeg: bytes | None = None
        self._fetch: asyncio.Task | None = None
        self._ring_at: float | None = None
        # Set by __init__.py: whether the built-in ring notifier is on for this doorbell.
        self._wanted_at_ring = lambda: False

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                SIGNAL_EVENT.format(device_id=self.coordinator.device_id),
                self._received,
            )
        )

    @property
    def available(self) -> bool:
        # The picture of the last ring stays viewable while the doorbell is briefly unreachable.
        return True

    @callback
    def _received(self, envelope: dict) -> None:
        if envelope.get("ev") != "ring":
            return
        if self._fetch is not None and not self._fetch.done():
            self._fetch.cancel()
        self._fetch = None
        # The previous visitor is never this ring's: dropped at once.
        self._jpeg = None
        self._ring_at = time.monotonic()
        # ⚠️ FETCHED AT THE RING ONLY WHEN SOMEONE WILL LOOK AT IT (the built-in notifier is on).
        # Otherwise it is fetched the first time it is asked for (a dashboard, an automation's
        # notification) within LAZY_WINDOW_S of the ring. A doorbell whose owner uses none of this
        # gets no extra capture per ring and no picture ever enters Home Assistant (principle 2).
        if self._wanted_at_ring():
            self._start_fetch()

    def _start_fetch(self) -> None:
        self._fetch = self.hass.async_create_task(self._async_fetch(), eager_start=False)

    async def _async_fetch(self) -> None:
        c = self.coordinator
        try:
            jpeg = await api.async_get_alert_snapshot(
                c.session, c.device_id, c.credential, SNAPSHOT_TIMEOUT_S
            )
        except api.SnapshotDisabledError:
            _LOGGER.info("The owner turned off the picture in ring notices (call_snap): none")
            jpeg = None
        except (api.DoorbellApiError, asyncio.TimeoutError) as err:
            _LOGGER.info("No snapshot for this ring: %s", err)
            jpeg = None
        # Cleared on failure too: the previous visitor must not be shown as this ring's.
        self._jpeg = jpeg
        self._attr_image_last_updated = dt_util.utcnow()
        self.async_write_ha_state()

    async def async_image(self) -> bytes | None:
        if (self._fetch is None and self._ring_at is not None
                and time.monotonic() - self._ring_at <= LAZY_WINDOW_S):
            self._start_fetch()
        fetch = self._fetch
        if fetch is not None and not fetch.done():
            try:
                await asyncio.wait_for(asyncio.shield(fetch), SNAPSHOT_TIMEOUT_S + 1)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
        return self._jpeg

    @property
    def has_picture(self) -> bool:
        """Whether a ring notice should point at this entity at all."""
        return (self.coordinator.data or {}).get("call_snap", 1) != 0
