"""The doorbell's mode (§1.2, field `m`).

Governs what the device does when it rings - what sounds, what shows on the ring, and whether
phones are notified (§3.5) - so it is one of the few things about the doorbell a Home Assistant
user actually wants to automate: "do not disturb at 23:00" is a two-line automation.

## ⚠️ Changing it REQUIRES the pairing to be an administrator

`save_states` requires the admin role (§1.16-bis: reading is open to anyone, writing to the
doorbell is administrator-only). A pairing that is not one can READ the mode and not change it,
and the `403` is translated into a visible error instead of a silent no-op.
"""
from __future__ import annotations

import logging

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from . import api
from .const import DOMAIN, MODES
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, AdminEntity, DoorbellEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([
        ModeSelect(c),
        StateSelect(c, "timestamp_position", "tspos", TIMESTAMP_POSITIONS, "mdi:clock-outline"),
        StateSelect(c, "lock_type", "door_m", LOCK_TYPES, "mdi:lock-question"),
        StateSelect(c, "main_stream_rate_control", "rc", RATE_CONTROL, "mdi:tune", enabled=False),
        ExposureModeSelect(c),
    ])


class ModeSelect(DoorbellEntity, SelectEntity):
    """Normal / Away / Do not disturb / Custom -- states are translation keys (const.MODES)."""

    _attr_translation_key = "mode"
    _attr_icon = "mdi:home-clock"
    _attr_options = list(MODES.values())

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "mode")

    @property
    def current_option(self) -> str | None:
        """The current mode, or None if the doorbell returns one we do not know.

        `None` and not a made-up label: a mode new to the firmware must read as "I don't know",
        not as "Normal", which would assert something false about the device at the door.
        """
        return MODES.get((self.coordinator.data or {}).get("m"))

    async def async_select_option(self, option: str) -> None:
        number = next((k for k, v in MODES.items() if v == option), None)
        if number is None:
            raise HomeAssistantError(f"Unknown mode: {option}")

        # The doorbell's LAN session (net.py): works with the internet down, never via the VPS.
        session = self.coordinator.session
        try:
            # PARTIAL save: only `m`. Sending the whole state would turn any reading up to 30 s
            # stale into a write that stomps whatever someone else just changed from the dashboard.
            await api.async_save_states(
                session, self.coordinator.device_id, self.coordinator.credential, {"m": str(number)}
            )
        except api.NotAllowedError as err:
            raise HomeAssistantError(
                "This pairing is not an administrator of the doorbell, so it cannot change the "
                "mode. Re-pair it from an administrator account."
            ) from err
        except api.DoorbellApiError as err:
            raise HomeAssistantError(f"Could not change the mode: {err}") from err

        # CONFIRMED AT ONCE, NOT ON THE NEXT POLL (0.7.4, Inaki 2026-09-25: "the mode button is
        # quite lazy showing the new mode... sometimes it looks like it did not work").
        #
        # Until 0.7.3 this was `async_request_refresh()`. That goes through the coordinator's
        # DEBOUNCER (10 s cooldown): the first change after a quiet spell refreshed at once, but a
        # second change within 10 s waited out the cooldown, and a failed read waited for the
        # 30 s poll -- the select kept showing the OLD mode meanwhile, which reads as "it did not
        # work". Now the doorbell is read directly, right after the write, and what it says is
        # published to every entity immediately (async_set_updated_data).
        #
        # Still not "assume the new value": the doorbell owns the state. save_states ignores a
        # field it does not accept WITHOUT an error status (contract 1.2), so only the read-back
        # tells "applied" from "silently dropped". If it was dropped, the entity keeps showing
        # the doorbell's real mode AND the service call fails with a readable reason, so the card
        # (or whoever called it) can say so instead of failing in silence.
        try:
            state = await api.async_get_states(
                session, self.coordinator.device_id, self.coordinator.credential
            )
        except api.DoorbellApiError:
            # The write was accepted (200) but the read-back failed: fall back to the normal
            # refresh rather than claiming a failure that did not happen.
            await self.coordinator.async_request_refresh()
            return
        self.coordinator.async_set_updated_data({**(self.coordinator.data or {}), **state})
        try:
            applied = int(state.get("m")) == number
        except (TypeError, ValueError):
            applied = False
        if not applied:
            raise HomeAssistantError(
                f"The doorbell did not apply the mode '{option}' (it reports "
                f"'{MODES.get(state.get('m'), state.get('m'))}')."
            )



# ==================================================================================================
# DOORBELL SETTINGS (1.3.0). Admin only; states are translation keys (the stable value an automation
# stores), mapped to the doorbell's numbers here and nowhere else. Plan rule R5: none is a secret,
# irreversible or an editor.
# ==================================================================================================

# `tspos` (§1.2): where the clock is drawn on the picture.
TIMESTAMP_POSITIONS: dict[int, str] = {
    0: "top_left", 1: "top_center", 2: "top_right",
    3: "bottom_left", 4: "bottom_center", 5: "bottom_right",
}
# `door_m` (§1.2). Choosing `none` REMOVES the lock entity (§1.4-ter): the entry reloads by itself
# (__init__._watch_doorbell). `home_assistant` opens through the entity picked in the apps (`ha_e`),
# which must be one of the entities this integration gives the doorbell (options).
LOCK_TYPES: dict[int, str] = {0: "relay", 1: "home_assistant", 2: "none"}
# `rc` (§1.2): the main stream's rate control. VBR is the recommended one.
RATE_CONTROL: dict[int, str] = {0: "vbr", 1: "cbr"}


class StateSelect(AdminEntity, SelectEntity):
    """A `get_states` field with a closed set of values."""

    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: DoorbellCoordinator, key: str, field: str,
                 values: dict[int, str], icon: str, *, enabled: bool = True) -> None:
        super().__init__(coordinator, key)
        self._field = field
        self._values = values
        self._attr_translation_key = key
        self._attr_options = list(values.values())
        self._attr_icon = icon
        self._attr_entity_registry_enabled_default = enabled

    @property
    def available(self) -> bool:
        return super().available and (self.coordinator.data or {}).get(self._field) is not None

    @property
    def current_option(self) -> str | None:
        # None, not a made-up label, for a value this integration does not know (a newer firmware).
        return self._values.get((self.coordinator.data or {}).get(self._field))

    async def async_select_option(self, option: str) -> None:
        number = next((k for k, v in self._values.items() if v == option), None)
        if number is None:
            raise HomeAssistantError(f"Unknown option: {option}")
        data = self.coordinator.data or {}
        if self._field == "door_m" and number == 1 and not data.get("ha_e"):
            # The doorbell would store it and then answer every opening with `ha_not_configured`:
            # the door would stop opening with nothing on screen saying why.
            raise HomeAssistantError(
                "Pick the Home Assistant entity that opens the door in the app first "
                "(Settings > Door); then choose this lock type."
            )
        await self.coordinator.async_save_states({self._field: str(number)},
                                                 self._attr_translation_key.replace("_", " "))


class ExposureModeSelect(AdminEntity, SelectEntity):
    """`auto` (the doorbell's own loop, with EV compensation) or `manual` (fixed time + gain)."""

    _source = "img"
    _attr_translation_key = "exposure_mode"
    _attr_icon = "mdi:camera-iris"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_options = ["auto", "manual"]

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "exposure_mode")

    @property
    def available(self) -> bool:
        return super().available and bool((self.source or {}).get("sensor_soportado"))

    @property
    def current_option(self) -> str | None:
        mode = (self.source or {}).get("mode")
        return mode if mode in self._attr_options else None

    async def async_select_option(self, option: str) -> None:
        if option not in self._attr_options:
            raise HomeAssistantError(f"Unknown exposure mode: {option}")
        await self.coordinator.async_save_img({"mode": option}, "the exposure mode")
