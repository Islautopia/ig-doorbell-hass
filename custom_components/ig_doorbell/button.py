"""Restart the doorbell (1.3.0).

## Where the "Open door" button went

It became the doorbell's `lock` entity (lock.py, Iñaki 2026-09-28): Home Assistant's own lock asks
for confirmation where a button is one tap - or one stray automation - away from opening the street
door. The old button is REMOVED from the entity registry here, not left behind as "no longer
provided": nothing in Iñaki's installation referenced it (checked read-only on 2026-09-28), and a
dead entity next to the real one is exactly the doubt this project keeps removing.

## Why a reboot button passes plan rule R5 (secret, irreversible or editor?)

Not a secret, not an editor, and not irreversible: the doorbell comes back by itself in ~30 s with
everything it had. The doorbell itself guards the two cases that would hurt: it refuses during an OTA
(`409 ota_in_progress` - a restart mid-download throws the update away) and it closes a running
recording first so the MP4 stays playable. Admin only, in the configuration section.
"""
from __future__ import annotations

import logging

from homeassistant.components.button import ButtonDeviceClass, ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er

from . import api, quick_replies
from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, AdminEntity, SourceEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    reg = er.async_get(hass)
    if (old := reg.async_get_entity_id("button", DOMAIN, f"{c.device_id}_open")) is not None:
        _LOGGER.info("Removing %s: opening the door is the lock entity since 1.3.0", old)
        reg.async_remove(old)
    async_add_entities([RebootButton(c), PlayQuickReplyButton(c)])


class PlayQuickReplyButton(SourceEntity, ButtonEntity):
    """Plays the quick reply picked in the "Quick reply" select (1.4.0, §1.4-quinquies). Any role.

    During a ring it does what the apps' quick reply does (§1.18.1): cuts the announcement WITHOUT chaining the
    no-answer sequence, and the ring counts as answered. Unavailable while the doorbell has no quick replies -
    a button that can only fail is worse than none.
    """

    _source = "quick"
    _attr_translation_key = "play_quick_reply"
    _attr_icon = "mdi:account-voice"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "play_quick_reply")

    @property
    def available(self) -> bool:
        return super().available and bool(quick_replies.quick_list(self.coordinator))

    async def async_press(self) -> None:
        items = quick_replies.quick_list(self.coordinator)
        if not items:
            raise HomeAssistantError("The doorbell has no quick replies.")
        sel = self.coordinator.selected_quick_reply
        seq_id = sel if any(i["id"] == sel for i in items) else items[0]["id"]
        await quick_replies.async_play_sequence(self.coordinator, seq_id)


class RebootButton(AdminEntity, ButtonEntity):
    """POST /api/reboot (confirm=REBOOT). Admin only."""

    _attr_translation_key = "reboot"
    _attr_device_class = ButtonDeviceClass.RESTART
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "reboot")

    async def async_press(self) -> None:
        c = self.coordinator
        try:
            await api.async_reboot(c.session, c.device_id, c.credential)
        except api.NotAllowedError as err:
            raise HomeAssistantError(
                "This pairing is not an administrator of the doorbell, so it cannot restart it."
            ) from err
        except api.DoorbellApiError as err:
            if "ota_in_progress" in str(err):
                raise HomeAssistantError(
                    "The doorbell is installing an update; it restarts by itself when it finishes."
                ) from err
            raise HomeAssistantError(f"Could not restart the doorbell: {err}") from err
