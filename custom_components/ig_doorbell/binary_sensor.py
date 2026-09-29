"""Presence and package, plus two diagnostic ones.

## ⚠️ WHY THESE TWO TURN THEMSELVES OFF AND THE OTHER DOES NOT

MQTT used to publish `videoportero/persona` with ON and OFF: the doorbell said when someone
arrived **and when the area was clear again**. The webhook carries EVENTS (§3.6.1), which are
edges, and §1.16 has a `visitor` - "someone is there" - and **no "nobody is there any more"**.

So a visitor sensor fed by events would stay on forever. It turns itself off after a while, which
is what any Home Assistant motion sensor does and what the user already expects of one.

**The package does NOT carry a timeout, and that asymmetry is deliberate**: there §1.16 DOES have
the full pair (`package` and `package_gone`), so turning it off by time would be inventing an
ending the doorbell already knows how to say - and worse, it would turn off a package that is
still on the doormat. A package is a still object: it stays for hours.
"""
from __future__ import annotations

import logging

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.const import EntityCategory
from homeassistant.helpers.event import async_call_later

from .const import DOMAIN, SIGNAL_EVENT
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity

_LOGGER = logging.getLogger(__name__)

# How long the visitor sensor stays on with no news. Roughly the same grace period the doorbell
# itself uses to consider the area clear and close the recording.
VISITOR_SECONDS = 30


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([
        VisitorBinarySensor(c),
        PackageBinarySensor(c),
        PresenceBinarySensor(c, "panel", "street_panel", "mdi:tablet"),
        PresenceBinarySensor(c, "reader", "fingerprint_reader", "mdi:fingerprint"),
        RingingBinarySensor(c, hass.data[DOMAIN][entry.entry_id]["call_state"]),
        InCallBinarySensor(c, hass.data[DOMAIN][entry.entry_id]["call_state"]),
        FlipBinarySensor(c, "flip_v", "flip_vertical"),
        FlipBinarySensor(c, "flip_h", "flip_horizontal"),
    ])


class _EventDrivenBinarySensor(DoorbellEntity, BinarySensorEntity):
    """Base for the ones that live off what the webhook pushes."""

    def __init__(self, coordinator: DoorbellCoordinator, key: str) -> None:
        super().__init__(coordinator, key)
        self._attr_is_on = False

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
        raise NotImplementedError


class VisitorBinarySensor(_EventDrivenBinarySensor):
    """Someone at the door. Turns itself off - see the module header."""

    _attr_translation_key = "visitor"
    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "visitor")
        self._cancel_turn_off = None

    @callback
    def _received(self, envelope: dict) -> None:
        if envelope.get("ev") != "visitor":
            return
        self._attr_is_on = True
        self.async_write_ha_state()

        # Every notice RE-ARMS the timeout instead of stacking a new one. Without this, someone
        # standing there for five minutes would generate a turn-off per event and the sensor
        # would flicker.
        if self._cancel_turn_off is not None:
            self._cancel_turn_off()

        @callback
        def _turn_off(_now) -> None:
            self._cancel_turn_off = None
            self._attr_is_on = False
            self.async_write_ha_state()

        self._cancel_turn_off = async_call_later(self.hass, VISITOR_SECONDS, _turn_off)

    async def async_will_remove_from_hass(self) -> None:
        if self._cancel_turn_off is not None:
            self._cancel_turn_off()
            self._cancel_turn_off = None
        await super().async_will_remove_from_hass()


class PackageBinarySensor(_EventDrivenBinarySensor):
    """A package in view. NO timeout - see the module header."""

    _attr_translation_key = "package"
    _attr_icon = "mdi:package-variant-closed"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "package")

    @callback
    def _received(self, envelope: dict) -> None:
        ev = envelope.get("ev")
        if ev == "package":
            self._attr_is_on = True
        elif ev == "package_gone":
            self._attr_is_on = False
        else:
            return
        self.async_write_ha_state()


class PresenceBinarySensor(DoorbellEntity, BinarySensorEntity):
    """`panel` and `reader` from §1.19: they are DISCOVERED, not configured.

    There is no "I have a panel" setting, and that is deliberate: it could only ever be wrong, and
    it would be wrong on exactly the day someone changes the wiring. The doorbell publishes it on
    every poll, so it appears and disappears on its own - including while the panel reboots during
    its own update.

    ⚠️ `reader` at 0 groups THREE things - no reader, no panel, or the panel cannot assert it - and
    it fails closed on purpose, because all three lead to the same decision: do not offer
    fingerprint management. The nuance lives in `firmware_info`'s `reader_state`.
    """

    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: DoorbellCoordinator, field: str, translation_key_name: str, icon: str) -> None:
        super().__init__(coordinator, field)
        self._field = field
        self._attr_translation_key = translation_key_name
        self._attr_icon = icon

    @property
    def is_on(self) -> bool:
        return bool((self.coordinator.data or {}).get(self._field, 0))


class RingingBinarySensor(DoorbellEntity, BinarySensorEntity):
    """On from the ring until the call is resolved (answered, declined or missed). See call_state.py.

    What follows an answer is the "In call" sensor below (1.4.0), told by the doorbell. The outcome of the
    last call travels as attributes, for automations.
    """

    _attr_translation_key = "ringing"
    _attr_icon = "mdi:bell-ring"

    def __init__(self, coordinator: DoorbellCoordinator, call_state) -> None:
        super().__init__(coordinator, "ringing")
        self._call = call_state

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self._call.async_listen(self.async_write_ha_state))

    @property
    def available(self) -> bool:
        # Pushed by the webhook, not polled: a doorbell that missed ONE poll is still ringing.
        return True

    @property
    def is_on(self) -> bool:
        return self._call.ringing

    @property
    def extra_state_attributes(self) -> dict:
        # English protocol words on purpose (answered/declined/missed): an automation compares
        # them, and the project's rule is that internal state is not translated.
        return {"call_id": self._call.call_id, "last_outcome": self._call.outcome,
                "answered_by": self._call.by}


class InCallBinarySensor(DoorbellEntity, BinarySensorEntity):
    """On from the moment a ring is answered until the conversation ends (1.4.0, firmware 0.103.2+).

    Complements "Ringing": that one is on while it rings; this one while someone is TALKING to the visitor.
    The end is the doorbell's (§1.4-sexies): the answering client closed the microphone, left the live view or
    sent the app to the background, hung up, or dropped - and nobody else took the talk turn within 3 s.
    Pushed by the webhook and corrected by every poll (call_state.py). Unavailable with an older firmware.
    """

    _attr_translation_key = "in_call"
    _attr_icon = "mdi:phone-in-talk"

    def __init__(self, coordinator: DoorbellCoordinator, call_state) -> None:
        super().__init__(coordinator, "in_call")
        self._call = call_state

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(self._call.async_listen(self.async_write_ha_state))

    @property
    def available(self) -> bool:
        return self._call.supports_in_call

    @property
    def is_on(self) -> bool:
        return self._call.in_call

    @property
    def extra_state_attributes(self) -> dict:
        # English protocol words (mic_closed, hung_up...): an automation compares them.
        return {"call_id": self._call.in_call_id, "answered_by": self._call.in_call_by,
                "last_duration_s": self._call.last_duration_s, "last_end": self._call.last_end}


class FlipBinarySensor(DoorbellEntity, BinarySensorEntity):
    """`flip_v` / `flip_h`: the camera's mounting orientation. READ-ONLY, and it must stay so.

    ⚠️ NOT A SWITCH, AND DO NOT MAKE IT ONE. Changing a flip WHILE THE CAMERA RUNS destroys the colour
    until a full reboot of the doorbell (measured 2026-08-21, IG_Doorbell CLAUDE.md landmine):
    saturation P95 89 -> 42.6, and turning the flip back does NOT repair it. An automation toggling
    it would leave the picture washed out with nothing to explain why. Orientation is set once, at
    installation, from the apps or the doorbell's own page, followed by a reboot.
    """

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_icon = "mdi:flip-vertical"

    def __init__(self, coordinator: DoorbellCoordinator, field: str, key: str) -> None:
        super().__init__(coordinator, key)
        self._field = field
        self._attr_translation_key = key
        if field == "flip_h":
            self._attr_icon = "mdi:flip-horizontal"

    @property
    def is_on(self) -> bool | None:
        value = (self.coordinator.data or {}).get(self._field)
        return None if value is None else bool(value)
