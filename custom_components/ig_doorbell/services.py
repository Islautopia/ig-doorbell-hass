"""Actions: play a sequence (quick reply) or an audio slot at the street, over `POST /api/call_action`.

Since 1.4.0 over the doorbell's HTTP route (§1.4-quinquies), not the signalling channel - see quick_replies.py.
`play_sequence` takes the sequence's id OR its name (`sequence`), so an automation can say "Leave it at the door"
instead of a number it has to look up. Any role may do both (the doorbell's own rule); failures are raised.
"""
from __future__ import annotations

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr

from . import api, quick_replies
from .const import CONF_DEVICE_ID, DOMAIN
from .coordinator import DoorbellCoordinator

ATTR_DEVICE = "device_id"

_SCHEMA_SEQ = vol.All(
    vol.Schema({
        vol.Required(ATTR_DEVICE): cv.string,
        vol.Optional("seq_id"): vol.All(vol.Coerce(int), vol.Range(min=1, max=65535)),
        vol.Optional("sequence"): cv.string,
    }),
    cv.has_at_least_one_key("seq_id", "sequence"),
)
_SCHEMA_AUDIO = vol.Schema({
    vol.Required(ATTR_DEVICE): cv.string,
    vol.Required("audio_slot"): vol.All(vol.Coerce(int), vol.Range(min=1, max=10)),
})


def _coordinator_for(hass: HomeAssistant, ha_device_id: str) -> DoorbellCoordinator:
    """The coordinator for an HA device id (the device selector's value) or our own device id."""
    ours = ha_device_id
    device = dr.async_get(hass).async_get(ha_device_id)
    if device is not None:
        ours = next((i[1] for i in device.identifiers if i[0] == DOMAIN), ha_device_id)
    stored = hass.data.get(DOMAIN, {})
    for entry in hass.config_entries.async_entries(DOMAIN):
        d = stored.get(entry.entry_id)
        if isinstance(d, dict) and d.get(CONF_DEVICE_ID) == ours and "coordinator" in d:
            return d["coordinator"]
    raise ServiceValidationError(f"No IG Doorbell set up for device {ha_device_id}")


async def _seq_id_for(c: DoorbellCoordinator, data: dict) -> int:
    if "seq_id" in data:
        return data["seq_id"]
    # A name: read the list NOW, not the copy of up to 5 minutes ago - a quick reply renamed in the app a
    # minute ago must be found by its new name.
    try:
        answer = await api.async_get_json(c.session, c.device_id, c.credential, "/api/sequences?quick=1")
    except api.DoorbellApiError as err:
        raise HomeAssistantError(f"Could not read the doorbell's quick replies: {err}") from err
    c.extra["quick"] = answer
    return quick_replies.resolve_name(quick_replies.quick_list(c), data["sequence"])


@callback
def async_register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, "play_sequence"):
        return

    async def play_sequence(call: ServiceCall) -> None:
        c = _coordinator_for(hass, call.data[ATTR_DEVICE])
        await quick_replies.async_play_sequence(c, await _seq_id_for(c, call.data))

    async def play_audio(call: ServiceCall) -> None:
        c = _coordinator_for(hass, call.data[ATTR_DEVICE])
        await quick_replies.async_play_audio(c, call.data["audio_slot"])

    hass.services.async_register(DOMAIN, "play_sequence", play_sequence, schema=_SCHEMA_SEQ)
    hass.services.async_register(DOMAIN, "play_audio", play_audio, schema=_SCHEMA_AUDIO)
