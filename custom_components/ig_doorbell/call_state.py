"""Is the doorbell ringing right now? One answer per doorbell, shared (1.3.0).

The `binary_sensor` "Ringing" shows it, and the snapshot camera obeys it (no picture is taken while a
call is live, camera.py). Both read THIS object, so they can never disagree about whether there is a
call.

## Where the answer comes from

- `ring` on the webhook -> ringing, with its `call_id`.
- `call_answered` / `call_declined` / `call_missed` (firmware 0.101.3, §3.6.7) for THAT `call_id` ->
  not ringing, and the outcome is kept as an attribute.
- No resolution after RING_SAFETY_S (a lost webhook, a firmware before 0.101.3): the doorbell is
  ASKED - `GET /api/call_status?call_id=` (§1.2-septies) - instead of guessing. `ringing` re-arms,
  anything else ends it. The route never says "don't know" on purpose: an unknown call is `ended`.

## ⚠️ What this does NOT claim: "call in progress" after it was answered

The doorbell reports when a ring is RESOLVED, not when the conversation that follows ends - there is
no such event, and `call_status` only knows `ringing` / `ended`. A "call in progress" sensor would
have to invent that ending (a timer, or the viewer count, which a wall panel keeps above zero all
day). What is kept instead is `answered_at`, which the camera uses for a short grace period.
"""
from __future__ import annotations

import logging
import time
from typing import Callable

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_call_later

from . import api
from .const import RING_SAFETY_S, SIGNAL_EVENT
from .coordinator import DoorbellCoordinator

_LOGGER = logging.getLogger(__name__)

RESOLUTIONS = {"call_answered": "answered", "call_declined": "declined", "call_missed": "missed"}
# call_status `reason` -> the same words as the webhook's events (§3.3-nonies).
_STATUS_REASONS = {"answered": "answered", "quick_reply": "answered", "declined": "declined",
                   "timeout": "missed"}


class CallState:
    """The ring in progress, if any. Updated by the webhook; asked to the doorbell as a fallback."""

    def __init__(self, hass: HomeAssistant, coordinator: DoorbellCoordinator) -> None:
        self.hass = hass
        self.coordinator = coordinator
        self.ringing = False
        self.call_id: str | None = None
        self.rang_at: float | None = None        # monotonic
        self.answered_at: float | None = None    # monotonic
        self.outcome: str | None = None          # answered / declined / missed
        self.by: str | None = None
        self._listeners: list[Callable[[], None]] = []
        self._cancel_safety: Callable[[], None] | None = None

    @callback
    def async_start(self) -> Callable[[], None]:
        unsub = async_dispatcher_connect(
            self.hass, SIGNAL_EVENT.format(device_id=self.coordinator.device_id), self._received
        )

        @callback
        def _stop() -> None:
            unsub()
            self._disarm()

        return _stop

    @callback
    def async_listen(self, update: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(update)
        return lambda: self._listeners.remove(update)

    def _notify(self) -> None:
        for update in list(self._listeners):
            update()

    def _disarm(self) -> None:
        if self._cancel_safety is not None:
            self._cancel_safety()
            self._cancel_safety = None

    @callback
    def _received(self, envelope: dict) -> None:
        ev = envelope.get("ev")
        d = envelope.get("d") if isinstance(envelope.get("d"), dict) else {}
        call_id = envelope.get("call_id") or d.get("call_id")
        if ev == "ring":
            if call_id and call_id == self.call_id:
                return      # the same ring delivered twice (a webhook retry): one ring
            self.ringing = True
            self.call_id = call_id
            self.rang_at = time.monotonic()
            self.answered_at = None
            self.outcome = None
            self.by = None
            self._disarm()
            self._cancel_safety = async_call_later(self.hass, RING_SAFETY_S, self._safety)
            self._notify()
        elif ev in RESOLUTIONS:
            # A late resolution of an EARLIER call must not end the current ring.
            if call_id and self.call_id and call_id != self.call_id:
                return
            self._end(RESOLUTIONS[ev], envelope.get("by") or d.get("by"))

    def _end(self, outcome: str | None, by: str | None) -> None:
        self._disarm()
        self.ringing = False
        self.outcome = outcome
        self.by = by
        if outcome == "answered":
            self.answered_at = time.monotonic()
        self._notify()

    async def _safety(self, _now) -> None:
        self._cancel_safety = None
        if not self.ringing:
            return
        c = self.coordinator
        path = "/api/call_status" + (f"?call_id={self.call_id}" if self.call_id else "")
        try:
            status = await api.async_get_json(c.session, c.device_id, c.credential, path)
        except api.DoorbellApiError as err:
            # The doorbell cannot be asked: the ring is over anyway (§1.2-septies' own rule - the
            # safe answer to "should I keep ringing?" is no), with its outcome unknown.
            _LOGGER.info("No resolution for the ring and call_status failed (%s): ended", err)
            self._end(None, None)
            return
        if status.get("state") == "ringing":
            self._cancel_safety = async_call_later(self.hass, RING_SAFETY_S, self._safety)
            return
        self._end(_STATUS_REASONS.get(status.get("reason")), status.get("by"))
