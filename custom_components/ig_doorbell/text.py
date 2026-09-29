"""The doorbell's name (`dname`, G5) - 1.3.0.

The name every client shows, the mDNS instance and the Home Assistant device follow it (§0-bis;
__init__._watch_name renames the device when it changes). Admin only. Plan rule R5: not a secret, not
irreversible, not an editor.

## The limits are the doorbell's, in BYTES

The field holds 31 bytes of UTF-8 (`device_name[32]`). A longer name is cut by the doorbell at a
character boundary WITHOUT an error - so it is refused here, loudly, with the byte count, instead of
coming back shorter than typed. An empty name cannot be written at all (`save_states` treats an empty
field as "not sent", §1.2): refused here too rather than looking accepted and changing nothing.
"""
from __future__ import annotations

from homeassistant.components.text import TextEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, AdminEntity

NAME_MAX_BYTES = 31


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([DeviceNameText(c)])


class DeviceNameText(AdminEntity, TextEntity):
    _attr_translation_key = "device_name"
    _attr_icon = "mdi:rename"
    _attr_entity_category = EntityCategory.CONFIG
    # 0 and not 1: an unnamed doorbell reports "", and Home Assistant refuses to even SHOW a text
    # state shorter than its minimum. The empty name is refused on write instead (below).
    _attr_native_min = 0
    _attr_native_max = NAME_MAX_BYTES

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "device_name")

    @property
    def native_value(self) -> str | None:
        # "" = nobody named it (§1.4-ter): shown as empty, not as the generic name.
        return (self.coordinator.data or {}).get("dname")

    async def async_set_value(self, value: str) -> None:
        name = value.strip()
        if not name:
            raise HomeAssistantError("The doorbell's name cannot be empty")
        size = len(name.encode("utf-8"))
        if size > NAME_MAX_BYTES:
            raise HomeAssistantError(
                f"That name takes {size} bytes and the doorbell keeps {NAME_MAX_BYTES} "
                "(accented letters take two)"
            )
        await self.coordinator.async_save_states({"dname": name}, "the name")
