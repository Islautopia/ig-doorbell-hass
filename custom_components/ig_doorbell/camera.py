"""The street, as a snapshot-only `camera` (1.3.0, parity plan §3 path A).

A still from `GET /api/snapshot`: pictures in dashboards, `camera.snapshot`, voice devices that show
cameras. NO live stream (Iñaki, 2026-09-28): RTSP accepts one connection and that one is his recorder's
(§1.4, 0.74.5); the live call stays in the card over WebRTC. So no `STREAM` feature.

## What it costs the doorbell, and the three rules that bound it (plan risk R1)

`esp_http_server` serves ONE request at a time and a capture competes with a live call on a CPU that
is already tight. Home Assistant's frontend asks for a new still every ~10 s per open dashboard, and
several dashboards ask independently. So:

1. **One real capture per SNAPSHOT_MIN_INTERVAL_S for everybody.** Every caller inside that window
   gets the same JPEG; callers that arrive while a capture is in flight wait for THAT capture.
2. **No capture while a call is live** (ringing, and CALL_GRACE_S after it was answered: the
   doorbell reports when a ring is resolved, not when the talk ends - call_state.py). §1.0-quinquies:
   the call comes first. During it the camera shows the ring's own picture - which the ring flow
   already fetched (image.py, `for=alert`) - or the last still taken BEFORE the ring.
3. **The owner's `call_snap` is obeyed.** With `call_snap=0` the owner said a ring shows no picture of
   the caller; the camera then shows nothing taken during the ring, instead of being the back door
   around that decision (`/api/snapshot` without `for=alert` would not be refused, §1.2).

## Privacy (principle 2, decision Dec-3)

One JPEG in RAM, replaced by the next. Nothing written to disk by this integration. Home Assistant
lets the owner save stills with `camera.snapshot` - his house, his network, his choice (Iñaki,
2026-09-28); the product sentence is "we never store it".
"""
from __future__ import annotations

import asyncio
import logging
import time

from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import api
from .call_state import CallState
from .const import DOMAIN, SNAPSHOT_TIMEOUT_S
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity

_LOGGER = logging.getLogger(__name__)

SNAPSHOT_MIN_INTERVAL_S = 5.0
CALL_GRACE_S = 60.0


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    data = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([SnapshotCamera(data["coordinator"], data["call_state"], data)])


class SnapshotCamera(DoorbellEntity, Camera):
    """A still of the street. See the module header for the rules."""

    _attr_translation_key = "snapshot"
    # A flag, not a bare 0: Home Assistant 2026 tests `STREAM in supported_features` and a plain
    # int makes adding the entity fail (measured on 2026.9.3; the 2025.1 test harness accepts it).
    _attr_supported_features = CameraEntityFeature(0)
    # A still, not a stream: without this the frontend would ask for an MJPEG stream it cannot get.
    _attr_frame_interval = 10

    def __init__(self, coordinator: DoorbellCoordinator, call_state: CallState, entry_data: dict) -> None:
        DoorbellEntity.__init__(self, coordinator, "snapshot")
        Camera.__init__(self)
        self._call = call_state
        self._entry_data = entry_data
        self._jpeg: bytes | None = None
        self._taken_at: float | None = None     # monotonic
        self._fetch: asyncio.Task | None = None
        self.captures = 0                       # real requests to the doorbell (tests, diagnostics)

    @property
    def use_stream_for_stills(self) -> bool:
        return False

    def _call_live(self) -> bool:
        if self._call.ringing:
            return True
        answered = self._call.answered_at
        return answered is not None and time.monotonic() - answered < CALL_GRACE_S

    def _held_before_ring(self) -> bytes | None:
        """The last still, only if it was taken before the current call started."""
        rang = self._call.rang_at
        if self._jpeg is None or self._taken_at is None:
            return None
        if rang is not None and self._taken_at >= rang:
            return None
        return self._jpeg

    async def async_camera_image(
        self, width: int | None = None, height: int | None = None
    ) -> bytes | None:
        if self._call_live():
            if (self.coordinator.data or {}).get("call_snap", 1) == 0:
                # The owner said: no picture of the caller. Only a still from BEFORE the ring.
                return self._held_before_ring()
            visitor = self._entry_data.get("visitor_image")
            if visitor is not None and self._call.ringing:
                # The ring flow's own picture (fetched once with for=alert, image.py): no extra
                # capture during the call.
                picture = await visitor.async_image()
                if picture is not None:
                    return picture
            return self._jpeg

        if (self._jpeg is not None and self._taken_at is not None
                and time.monotonic() - self._taken_at < SNAPSHOT_MIN_INTERVAL_S):
            return self._jpeg
        if self._fetch is None or self._fetch.done():
            self._fetch = self.hass.async_create_task(self._capture(), eager_start=False)
        try:
            await asyncio.shield(self._fetch)
        except (asyncio.CancelledError, TimeoutError):
            pass
        return self._jpeg

    async def _capture(self) -> None:
        c = self.coordinator
        self.captures += 1
        try:
            jpeg = await api.async_get_snapshot(c.session, c.device_id, c.credential, SNAPSHOT_TIMEOUT_S)
        except api.DoorbellApiError as err:
            _LOGGER.debug("No snapshot: %s", err)
            jpeg = None
        # The window starts even on failure: a doorbell that could not capture is not asked again
        # by every dashboard in the next second.
        self._taken_at = time.monotonic()
        if jpeg is not None:
            self._jpeg = jpeg
