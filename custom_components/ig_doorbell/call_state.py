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

## In call (1.4.0): the conversation, told by the doorbell itself

Until firmware 0.103.1 the doorbell said when a ring was RESOLVED and never when the conversation that
follows ENDED, so this file refused to guess it (a timer, or the viewer count, which a wall panel keeps
above zero all day). Firmware 0.103.2 knows it (API_CONTRACT §1.4-sexies): a conversation starts when a
ring is answered by opening the microphone and ends when the talk turn goes free and nobody takes it
within 3 s - mic closed, live view left / app to background, hang-up, session lost, 60 s of silence.

- ON with `call_answered` for the ringing call - unless its `d.reason` is `quick_reply` (a quick reply
  resolves the ring and nobody talks).
- OFF with `call_finished` (HA-only webhook event, `d.duration_s`, `d.reason`).
- And the doorbell's `get_states.in_call` on every poll corrects both ways, so a lost webhook costs at most
  one poll - but a poll never overrules a webhook newer than POLL_TRUST_S (the poll may have been answered
  before the event happened).

Only with a firmware that has `in_call` in get_states: with an older one the sensor is unavailable, never
a sensor that turns on and can never be told to turn off.
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
# A poll answered this soon after a webhook changed `in_call` may predate that change: it is not trusted.
POLL_TRUST_S = 10
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
        # In call (1.4.0): the conversation after an answer, as the doorbell tells it.
        self.in_call = False
        self.in_call_id: str | None = None
        self.in_call_by: str | None = None
        self.last_duration_s: int | None = None
        self.last_end: str | None = None
        self._in_call_changed = 0.0      # monotonic, last change made by a webhook event
        self._listeners: list[Callable[[], None]] = []
        self._cancel_safety: Callable[[], None] | None = None

    @callback
    def async_start(self) -> Callable[[], None]:
        unsub = async_dispatcher_connect(
            self.hass, SIGNAL_EVENT.format(device_id=self.coordinator.device_id), self._received
        )

        unsub_poll = self.coordinator.async_add_listener(self._polled)

        @callback
        def _stop() -> None:
            unsub()
            unsub_poll()
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
            by = envelope.get("by") or d.get("by")
            if ev == "call_answered" and d.get("reason") != "quick_reply" and self.supports_in_call:
                self._set_in_call(True, call_id, by)
            self._end(RESOLUTIONS[ev], by)
        elif ev == "call_finished":
            if self.in_call_id and call_id and call_id != self.in_call_id:
                return      # the end of an earlier conversation: the current one goes on
            self.last_duration_s = d.get("duration_s") if isinstance(d.get("duration_s"), int) else None
            self.last_end = d.get("reason") if isinstance(d.get("reason"), str) else None
            self._set_in_call(False, call_id, self.in_call_by)
            self._notify()

    # -- in call ---------------------------------------------------------------------------------

    @property
    def supports_in_call(self) -> bool:
        """The doorbell tells when a conversation ends (firmware 0.103.2+: `in_call` in get_states)."""
        return isinstance((self.coordinator.data or {}).get("in_call"), dict)

    def _set_in_call(self, on: bool, call_id: str | None, by: str | None) -> None:
        self.in_call = on
        self.in_call_id = call_id
        self.in_call_by = by
        self._in_call_changed = time.monotonic()

    @callback
    def _polled(self) -> None:
        """Every poll: the doorbell's `in_call` corrects a lost webhook - never a newer one."""
        ic = (self.coordinator.data or {}).get("in_call")
        if not isinstance(ic, dict) or not self.coordinator.last_update_success:
            return
        active = bool(ic.get("active"))
        if active == self.in_call and (not active or ic.get("call_id") == self.in_call_id):
            return
        if time.monotonic() - self._in_call_changed < POLL_TRUST_S:
            return
        self.in_call = active
        if active:
            self.in_call_id = ic.get("call_id")
            self.in_call_by = ic.get("by") or None
        # not a webhook: leaves _in_call_changed alone, so the next event is trusted at once
        self._notify()

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
