"""Wall panels: back to the home page after: how long a card waits, untouched, before taking a wall
panel's screen back to Home Assistant's default page (1.2.0; wall panels only since 1.2.3).

## Only on a wall panel (Iñaki, 2026-09-28, 1.2.3)

It applies ONLY on a page the integration recognises as a wall panel picked in the Ring
notifications options (call_page_nav.is_configured_panel: since 1.2.4 by its companion login,
panel_identity.py; the card gets the answer as `back_home` in get_connection_info). A desktop browser or a
phone is attended and is never navigated away - in 1.2.2 his PC was sent home at the same moment
as the salon panel. The name says so, in every language.

## What it was, and why it changed (Iñaki, 2026-09-27)

Until 1.1.x this was the *live view timeout*: after this many seconds without a touch the card
paused the stream. Iñaki's rule for 1.2.0 replaces it: **when the card is visible there is always a
stream; when it is not visible the stream stops at once** (the hide/off-screen pause, unchanged). So
the deadline no longer cuts the stream: it takes the screen back to the default page, and leaving
the card is what stops the stream.

- During a call that was **not** answered: after the deadline (counted from the ring) -> default page.
- During a call that **was** answered (microphone/turn): never while it lasts.
- Outside a call: after the deadline without a touch -> default page. `0` = never: the card stays,
  with its stream on.
- A card that IS on the default page stays there (no navigation loop).

The value, the entity id and the unique id are the same as before on purpose: an owner who had set
it keeps it (RestoreNumber), and only its meaning and name change. The card applies it, because the
card is the one on screen.
"""
from __future__ import annotations

from homeassistant.components.number import NumberMode, RestoreNumber
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LIVE_TIMEOUT_DEFAULT_S, LIVE_TIMEOUT_MAX_S
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([LiveTimeoutNumber(c)])


class LiveTimeoutNumber(DoorbellEntity, RestoreNumber):
    """Seconds without a touch before the card goes back to Home Assistant's default page."""

    _attr_translation_key = "live_view_timeout"
    _attr_icon = "mdi:home-clock-outline"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_native_min_value = 0
    _attr_native_max_value = LIVE_TIMEOUT_MAX_S
    _attr_native_step = 15
    _attr_native_unit_of_measurement = UnitOfTime.SECONDS
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "live_timeout")
        self._attr_native_value = float(LIVE_TIMEOUT_DEFAULT_S)

    @property
    def available(self) -> bool:
        # A Home Assistant setting, not a doorbell reading: it stays usable (and readable by the
        # card) while the doorbell is off. An unavailable value would make every card fall back to
        # its own default, silently ignoring what the owner set.
        return True

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        previous = await self.async_get_last_number_data()
        if previous is not None and previous.native_value is not None:
            self._attr_native_value = previous.native_value

    async def async_set_native_value(self, value: float) -> None:
        self._attr_native_value = value
        self.async_write_ha_state()
