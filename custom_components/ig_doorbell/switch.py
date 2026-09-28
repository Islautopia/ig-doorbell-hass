"""Manual recording (REC), held open for as long as the recording actually lasts.

## Why a switch and not a button (Iñaki, 2026-09-25, fixing the Phase 0 finding)

REC works over the doorbell's signalling channel like a quick reply (§1.4-quater), but a manual
recording started that way **stops the moment the session that pressed it ends** - measured on
the Waveshare (fw 0.100.0): `rec_state:false` right after the `bye` of a one-shot command. A
`button` fires and forgets; REC needs something held open for as long as the recording runs, and
a `switch` is the entity that has an on/off lifetime instead of a single press. Turning it on
opens the session and sends `rec_start`; turning it off sends `rec_stop` and closes it - see
rec_session.py, which is where the session actually lives.

## Why `is_on` reads the session's `recording`, never "is a session held"

Holding the session open is the MECHANISM, not the fact this entity reports. If the doorbell
refuses (`admin_required`, `no_sd`, `busy`) or ends the recording on its own (the 10-minute cap,
an admin stopping it from elsewhere, a ring taking the slot for a call), the switch has to show
that immediately - a switch that reads "on" because a session happens to be open, while the
doorbell has long since stopped writing, is exactly the false "recording" state that would send
someone away thinking a moment was captured when nothing was.
"""
from __future__ import annotations

import logging

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError

from . import api
from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, AdminEntity, DoorbellEntity
from .rec_session import RecSession

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


class ManualRecordingSwitch(DoorbellEntity, SwitchEntity):
    """REC. Admin-only on the doorbell's side (§1.4-quater) - reactive here, like play_audio/
    play_sequence (services.py): the doorbell's own `admin_required` becomes a HomeAssistantError.

    The coordinator DOES track this pairing's role now (`DoorbellCoordinator.role`, since
    2026-09-25) so the card can decide whether to show the switch at all - see
    `websocket_api.get_connection_info`. This entity itself still does not pre-guess: the doorbell
    remains the one thing that enforces the rule, this is reactive on purpose.
    """

    _attr_translation_key = "rec"
    _attr_icon = "mdi:record-rec"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "rec")
        self._session: RecSession | None = None

    @property
    def is_on(self) -> bool:
        return self._session is not None and self._session.recording

    @property
    def extra_state_attributes(self) -> dict | None:
        # kind/origin are the firmware's own protocol vocabulary (§1.4-quater: call/detection/
        # manual, auto/manual) - technical, so left exactly as the doorbell sends them (project
        # language policy: internal protocol state stays in English, translated or not).
        if self._session is None:
            return None
        return {"kind": self._session.kind, "origin": self._session.origin}

    async def async_turn_on(self, **kwargs) -> None:
        if self._session is not None and self._session.recording:
            return  # already recording - a second rec_start would just be an extra round trip
        session = self.coordinator.session
        session = RecSession(
            session, self.coordinator.device_id, self.coordinator.credential, self._on_update,
        )
        try:
            await session.start()
        except api.DoorbellApiError as err:
            # Somebody may be relying on this to actually capture the moment - a refusal that
            # silently did nothing would be worse than an error (§1.8's reasoning, same family).
            raise HomeAssistantError(f"Could not start recording: {err}") from err
        self._session = session
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        session, self._session = self._session, None
        if session is not None:
            await session.stop()
        self.async_write_ha_state()

    @callback
    def _on_update(self) -> None:
        """Called by the held RecSession on every `rec_state` push and on its own close."""
        if self._session is not None and self._session.closed:
            self._session = None
        self.async_write_ha_state()

    async def async_will_remove_from_hass(self) -> None:
        """No leaks on reload/unload: an open REC session is closed, freeing its slot."""
        session, self._session = self._session, None
        if session is not None:
            await session.stop()



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
