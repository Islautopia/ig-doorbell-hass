"""Manual recording (REC) and the doorbell's on/off settings.

## REC (1.4.0): the doorbell's own state, over its HTTP route

Until 1.3.0 REC held a signalling session open for as long as the recording ran (a recording started from a
session ended with it). Firmware 0.103.1 added `POST /api/call_action` `rec_start`/`rec_stop` (§1.4-quinquies):
a recording started there has NO owning session - it ends with `rec_stop`, at the 10-minute manual limit, with
the call or detection it joined, or when a ring or detection takes over (§1.4-quater rules 3-4). And
`get_states` carries `rec`, the same four fields as the signalling `rec_state`.

So the switch holds nothing. `is_on` IS the doorbell's `rec.recording` - from the answer to our own action and
from every poll - and it turns off by itself when the doorbell stops. Never "on because we asked": a switch that
said "recording" while the doorbell had stopped writing would send someone away thinking a moment was captured
when nothing was.

Admin only (§1.4-quater): unavailable with a user pairing (entity.AdminEntity).
"""
from __future__ import annotations

import logging

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_call_later

from . import quick_replies
from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, AdminEntity

# The doorbell's limit for a manual recording (§1.4-quater, RP_MANUAL_MAX_S).
MANUAL_REC_MAX_S = 600

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([
        ManualRecordingSwitch(c),
        StateSwitch(c, "night_mode", "night", "mdi:weather-night"),
        StateSwitch(c, "timestamp", "ts", "mdi:clock-time-four-outline"),
        # `car_open` (E7): is opening from a car screen allowed. Absent = 1 (firmware < 0.98.1,
        # §1.2: "its absence means 1, never 'unknown'"). Writing it is LAN-only on the doorbell
        # (`403 local_only` through the tunnel) - Home Assistant only ever talks over the LAN.
        StateSwitch(c, "car_open", "car_open", "mdi:car-key", default=1),
        StateSwitch(c, "sub_stream", "sen", "mdi:video-switch", enabled=False),
        DetectSwitch(c, "person_detection", "person_on", "mdi:account-eye"),
        DetectSwitch(c, "package_detection", "pkg_on", "mdi:package-variant-closed"),
    ])


class ManualRecordingSwitch(AdminEntity, SwitchEntity):
    """REC - reads and writes the doorbell's `rec` (see the module header)."""

    _attr_translation_key = "rec"
    _attr_icon = "mdi:record-rec"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "rec")
        self._cancel_recheck = None

    def _rec(self) -> dict | None:
        rec = (self.coordinator.data or {}).get("rec")
        return rec if isinstance(rec, dict) else None

    @property
    def available(self) -> bool:
        # No `rec` = firmware before 0.103.1: there is no route to drive, so no switch pretending there is.
        return super().available and self._rec() is not None

    @property
    def is_on(self) -> bool | None:
        rec = self._rec()
        return None if rec is None else bool(rec.get("recording"))

    @property
    def extra_state_attributes(self) -> dict | None:
        # kind/origin are the firmware's protocol words (call/detection/manual, auto/manual): technical, left
        # exactly as the doorbell sends them (project language policy).
        rec = self._rec()
        if rec is None:
            return None
        return {"kind": rec.get("kind"), "origin": rec.get("origin"), "sd_available": rec.get("sd_available")}

    async def _act(self, action: str) -> None:
        answer = await quick_replies.async_run(self.coordinator, action, {})
        rec = answer.get("rec") if isinstance(answer, dict) else None
        if isinstance(rec, dict):
            # The doorbell's answer IS the new state: published at once, not on the next poll.
            self.coordinator.async_set_updated_data({**(self.coordinator.data or {}), "rec": rec})
        else:
            await self.coordinator.async_request_refresh()
        if action == "rec_start":
            self._schedule_recheck()

    def _schedule_recheck(self) -> None:
        """A manual recording ends by itself at 10 minutes: look again right after, not up to 30 s later."""
        if self._cancel_recheck is not None:
            self._cancel_recheck()

        async def _recheck(_now) -> None:
            self._cancel_recheck = None
            await self.coordinator.async_request_refresh()

        self._cancel_recheck = async_call_later(self.hass, MANUAL_REC_MAX_S + 5, _recheck)

    async def async_turn_on(self, **kwargs) -> None:
        # `already_recording` is not an error: the switch shows the recording that runs (maybe a call's).
        await self._act("rec_start")

    async def async_turn_off(self, **kwargs) -> None:
        await self._act("rec_stop")

    async def async_will_remove_from_hass(self) -> None:
        if self._cancel_recheck is not None:
            self._cancel_recheck()
            self._cancel_recheck = None
        await super().async_will_remove_from_hass()


# ==================================================================================================
# DOORBELL SETTINGS (1.3.0). Admin only (entity.AdminEntity).
#
# Plan rule R5 - "secret, irreversible or editor?": none of these. `car_open` is the one that deserves
# a sentence: turning it OFF is a protection (no opening from a car screen), turning it ON only gives
# back what a paired app could already do from its own screen (§1.2), and the doorbell accepts it only
# from the LAN - which is the only way Home Assistant ever reaches it.
#
# ⚠️ Not here, on purpose:
# - Auto white balance (`awb`): `0` has NO effect on this hardware yet (§1.2: "do not present this
#   option as functional"). A switch that does nothing is worse than none.
# - The flips (`flip_v`/`flip_h`): read-only binary sensors (binary_sensor.py) - changing them live
#   destroys the colour until a reboot.
# ==================================================================================================


class StateSwitch(AdminEntity, SwitchEntity):
    """A 0/1 field of `get_states` / `save_states`."""

    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: DoorbellCoordinator, key: str, field: str, icon: str,
                 *, default: int | None = None, enabled: bool = True) -> None:
        super().__init__(coordinator, key)
        self._field = field
        self._default = default
        self._attr_translation_key = key
        self._attr_icon = icon
        self._attr_entity_registry_enabled_default = enabled

    def _raw(self):
        return (self.coordinator.data or {}).get(self._field, self._default)

    @property
    def available(self) -> bool:
        return super().available and self._raw() is not None

    @property
    def is_on(self) -> bool | None:
        raw = self._raw()
        return None if raw is None else bool(int(raw))

    async def async_turn_on(self, **kwargs) -> None:
        await self.coordinator.async_save_states({self._field: "1"}, self._attr_translation_key.replace("_", " "))

    async def async_turn_off(self, **kwargs) -> None:
        await self.coordinator.async_save_states({self._field: "0"}, self._attr_translation_key.replace("_", " "))


class DetectSwitch(AdminEntity, SwitchEntity):
    """Detection of one class (§1.14-bis). ⚠️ Turning ONE off saves notices, not CPU: the model is
    one and finds both classes in the same pass. Only with BOTH off does the inference stop."""

    _source = "detect"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: DoorbellCoordinator, key: str, field: str, icon: str) -> None:
        super().__init__(coordinator, key)
        self._field = field
        self._attr_translation_key = key
        self._attr_icon = icon

    @property
    def available(self) -> bool:
        return super().available and (self.source or {}).get(self._field) is not None

    @property
    def is_on(self) -> bool | None:
        raw = (self.source or {}).get(self._field)
        return None if raw is None else bool(int(raw))

    async def async_turn_on(self, **kwargs) -> None:
        await self.coordinator.async_save_detect({self._field: "1"}, self._attr_translation_key.replace("_", " "))

    async def async_turn_off(self, **kwargs) -> None:
        await self.coordinator.async_save_detect({self._field: "0"}, self._attr_translation_key.replace("_", " "))
