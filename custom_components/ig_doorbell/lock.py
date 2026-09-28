"""The street door, as a `lock` (1.3.0 - it replaces the "Open door" button).

## Why a lock (Iñaki, 2026-09-28, plan decision Dec-4)

A `button` opens on one tap from any dashboard and has no confirmation; the apps ask for two (§1.8).
Home Assistant's own lock card asks before it opens, and voice assistants treat a lock as something
to confirm. So the door is a lock.

## How it maps, and what it does NOT pretend

The doorbell drives an electric strike (or a Home Assistant entity, `door_m=1`): it RELEASES the door
for `dur` seconds and then the door is held again by itself. It does not know whether anyone pushed
the door open, and there is nothing to "lock" by command. So:

- **unlock** and **open** do the same thing: `GET /open`. The state is `unlocked` for `dur` seconds
  (what the doorbell actually commanded), then `locked` again. No sensor is claimed.
- **lock** changes nothing: the door is held again by itself when `dur` ends. It returns without an
  error - "make sure it is locked" is always true within `dur` seconds - and the state keeps saying
  `unlocked` until then, because that is the truth.
- A failure is RAISED, never swallowed: someone may be waiting outside, and a lock that says nothing
  reads as the door having opened (§1.8: a timeout is a timeout, never an "opened").

## Who may open

`/open` has NO role filter on the doorbell, on purpose (§1.2: the signalling `open` never checked
it), so this entity is available to a `user` pairing too - unlike the settings (entity.AdminEntity).

## For automations

The doorbell reports every opening, from any client, as the `door_opened` event (event.py) - that is
what an automation should trigger on, not this entity's state.

With `door_m=2` (no lock) this entity does not exist (§1.4-ter); __init__._watch_doorbell reloads
the entry when the lock type changes, so it appears and disappears with it.
"""
from __future__ import annotations

import logging

from homeassistant.components.lock import LockEntity, LockEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_call_later

from . import api
from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    if not c.has_lock:
        # NOT drawn disabled: not drawn at all (§1.4-ter). A lock entity left over from when the
        # doorbell had one is removed, not left as "no longer provided".
        reg = er.async_get(hass)
        if (old := reg.async_get_entity_id("lock", DOMAIN, f"{c.device_id}_door")) is not None:
            reg.async_remove(old)
        _LOGGER.info("That doorbell has no lock configured (door_m=2): no lock entity")
        return
    async_add_entities([DoorLock(c)])


class DoorLock(DoorbellEntity, LockEntity):
    """The street door. Unlock / open = release it for `dur` seconds."""

    _attr_translation_key = "door"
    _attr_supported_features = LockEntityFeature.OPEN

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "door")
        self._released = False
        self._opened_by_open = False
        self._cancel_relock = None

    @property
    def is_locked(self) -> bool:
        return not self._released

    @property
    def is_open(self) -> bool:
        return self._released and self._opened_by_open

    async def async_unlock(self, **kwargs) -> None:
        await self._release(opened=False)

    async def async_open(self, **kwargs) -> None:
        await self._release(opened=True)

    async def async_lock(self, **kwargs) -> None:
        # Nothing to command: the doorbell holds the door again by itself when `dur` ends. See the
        # module header for why this is not an error.
        return

    async def _release(self, *, opened: bool) -> None:
        c = self.coordinator
        try:
            await api.async_open_door(c.session, c.device_id, c.credential)
        except api.NoLockConfiguredError as err:
            # `door_m` changed since the last poll. What happened is stated, not a code (§1.0.5).
            raise HomeAssistantError("That doorbell no longer has a lock configured") from err
        except api.DoorbellApiError as err:
            raise HomeAssistantError(f"Could not open the door: {err}") from err
        self._released = True
        self._opened_by_open = opened
        self.async_write_ha_state()
        if self._cancel_relock is not None:
            self._cancel_relock()
        try:
            seconds = max(1, int((c.data or {}).get("dur") or 1))
        except (TypeError, ValueError):
            seconds = 1
        self._cancel_relock = async_call_later(self.hass, seconds, self._relocked)

    @callback
    def _relocked(self, _now) -> None:
        self._cancel_relock = None
        self._released = False
        self._opened_by_open = False
        self.async_write_ha_state()

    async def async_will_remove_from_hass(self) -> None:
        if self._cancel_relock is not None:
            self._cancel_relock()
            self._cancel_relock = None
        await super().async_will_remove_from_hass()
