"""ONE event entity that carries EVERYTHING the doorbell can report (§1.16).

## Why a single one, not one per event

Because the catalog grows. §1.16 has 24 entries today and has already grown three times this
month, and one entity per event would mean **a new doorbell feature is invisible until someone
updates this integration**. With a single entity and an open list of types, an event this code
does not know about still arrives and can be automated the same day.

It is also what Home Assistant expects of something momentary: a ring has no state, it has an
instant. Modelling it as a `binary_sensor` that turns on and off forces you to invent how long it
lasts - and whoever looks half a second late sees nothing.

## What it does NOT do

It does not filter. The only event dropped here is `hass_action`, and it is not an event: it is a
command (§4), which should not show up in the bell icon nor here - it would be one entry per
light bulb.
"""
from __future__ import annotations

import logging

from homeassistant.components.event import EventEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import DOMAIN, SIGNAL_EVENT
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity

_LOGGER = logging.getLogger(__name__)

# The identifiers from §3.6.1. Listed so Home Assistant offers them in the automation editor -
# **not to filter**: one that is not here is accepted just the same (see `_received`).
KNOWN_EVENT_TYPES = [
    "ring", "visitor", "package", "person_with_package", "package_gone",
    "visitor_message", "door_opened", "storage_problem", "unexpected_reboot",
    "client_paired", "user_added", "user_revoked", "login_failed",
    "mode_changed", "ring_suppressed", "viewer_joined",
    "key_denied", "key_locked",
    # The call's resolution (firmware 0.101.3, API_CONTRACT §3.6.7): what lets an automation - and
    # the built-in ring notifier - clear a notice or send a panel home. `call_id`, `by` (who, when
    # known) and `reason` ("quick_reply") travel as attributes.
    "call_answered", "call_declined", "call_missed",
    # The end of the conversation that followed an answer (firmware 0.103.2, §1.4-sexies): `call_id`, `duration_s`,
    # `reason` (mic_closed / live_paused / hung_up / session_lost / silence), `by`. Home Assistant only.
    "call_finished",
]


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    coordinator: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([DoorbellEvents(coordinator)])


class DoorbellEvents(DoorbellEntity, EventEntity):
    """Everything that happens at the door, in one entity."""

    _attr_translation_key = "events"
    _attr_icon = "mdi:bell-ring-outline"
    _attr_event_types = KNOWN_EVENT_TYPES

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "events")

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                SIGNAL_EVENT.format(device_id=self.coordinator.device_id),
                self._received,
            )
        )

    @callback
    def _received(self, envelope: dict) -> None:
        ev = envelope.get("ev")
        if not ev:
            return

        # A type that was not in the list gets ADDED on the fly instead of being dropped. Without
        # this, a new doorbell event would be silently lost until someone updated this
        # integration - and the symptom would be "that feature never reaches Home Assistant",
        # which nobody connects to a list of constants.
        if ev not in self._attr_event_types:
            _LOGGER.info("Event '%s' this integration did not know about: accepted anyway", ev)
            self._attr_event_types = [*self._attr_event_types, ev]

        # The whole envelope travels as attributes, `d` flattened. This is what lets an automation
        # look at `rec` - the clip this notice points to (§1.7-quater) - or `by`, without this
        # integration having to know every field of every event.
        attributes = {k: v for k, v in envelope.items() if k not in ("ev", "type", "d")}
        d = envelope.get("d")
        if isinstance(d, dict):
            attributes.update(d)

        self._trigger_event(ev, attributes)
        self.async_write_ha_state()
