"""The config entry's title and the device's name track the doorbell's own name (`dname`).

Iñaki, 2026-09-26: looking for where to configure its entities, he did not recognize the entry
for his own doorbell in Settings > Devices & services - it was named `0123456789abcdef` (its bare
`device_id`), not "Ermita" or anything he'd typed. This happened because a manually-paired entry
(no zeroconf discovery) got its title from `result.device_id` at pairing time and nothing ever
corrected it afterwards.

Three things are checked here:
  - An entry from before this fix (title == bare device_id) fixes itself the first time this
    version starts - no waiting for the doorbell's name to actually change.
  - A later rename ON THE DOORBELL (a changed `dname`) is picked up on the next poll and updates
    both the entry title and the device name - but never an entity_id.
  - A doorbell with no name at all (`dname` empty) never falls back to the bare id either.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ig_doorbell import api, net
from custom_components.ig_doorbell.const import (
    CONF_CREDENTIAL, CONF_DEVICE_ID, CONF_HOST_HINT, DOMAIN,
)

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP


async def _setup(hass, *, title: str, state: dict):
    await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=DEVICE_ID, title=title,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL, CONF_HOST_HINT: LAN_IP},
    )
    entry.add_to_hass(hass)
    with patch.object(net, "is_this_doorbell", AsyncMock(return_value=True)), \
         patch.object(api, "async_get_states", AsyncMock(return_value=state)), \
         patch.object(api, "async_get_firmware_info", AsyncMock(return_value={})), \
         patch.object(api, "async_get_role", AsyncMock(return_value="admin")), \
         patch.object(api, "async_set_hass_config", AsyncMock()):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return entry


async def test_an_entry_named_by_its_bare_device_id_fixes_itself_on_startup(hass):
    """The Ermita case: upgrading to this version, with no new poll needed, fixes a stale title."""
    entry = await _setup(hass, title=DEVICE_ID, state={"m": 0, "door_m": 0, "dname": "Ermita"})
    assert entry.title == "Ermita"
    device = dr.async_get(hass).async_get_device(identifiers={(DOMAIN, DEVICE_ID)})
    assert device.name == "Ermita"


async def test_nameless_doorbell_never_falls_back_to_the_bare_id(hass):
    entry = await _setup(hass, title=DEVICE_ID, state={"m": 0, "door_m": 0, "dname": ""})
    assert entry.title != DEVICE_ID
    assert DEVICE_ID in entry.title       # e.g. "IG Doorbell <device_id>" - still identifiable
    assert entry.title.startswith("IG Doorbell")


async def test_a_later_rename_on_the_doorbell_updates_title_and_device_without_touching_entity_id(hass):
    state = {"m": 0, "door_m": 0, "dname": "Puerta Principal"}
    entry = await _setup(hass, title="Puerta Principal", state=state)

    reg_e = er.async_get(hass)
    mode_before = reg_e.async_get_entity_id("select", DOMAIN, f"{DEVICE_ID}_mode")
    assert mode_before is not None

    # Mutated in place: the mock returns this same dict on every future poll too.
    state["dname"] = "Puerta Trasera"
    coordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    with patch.object(net, "is_this_doorbell", AsyncMock(return_value=True)), \
         patch.object(api, "async_get_states", AsyncMock(return_value=state)), \
         patch.object(api, "async_get_firmware_info", AsyncMock(return_value={})), \
         patch.object(api, "async_get_role", AsyncMock(return_value="admin")), \
         patch.object(api, "async_set_hass_config", AsyncMock()):
        await coordinator.async_refresh()
        await hass.async_block_till_done()

    assert entry.title == "Puerta Trasera"
    device = dr.async_get(hass).async_get_device(identifiers={(DOMAIN, DEVICE_ID)})
    assert device.name == "Puerta Trasera"

    mode_after = reg_e.async_get_entity_id("select", DOMAIN, f"{DEVICE_ID}_mode")
    assert mode_after == mode_before


async def test_a_manual_device_rename_in_ha_is_never_overwritten(hass):
    """`name_by_user` is the user's own override; this sync must never touch it."""
    state = {"m": 0, "door_m": 0, "dname": "Puerta Principal"}
    entry = await _setup(hass, title="Puerta Principal", state=state)

    registry = dr.async_get(hass)
    device = registry.async_get_device(identifiers={(DOMAIN, DEVICE_ID)})
    registry.async_update_device(device.id, name_by_user="Como yo la llamo")

    coordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    with patch.object(net, "is_this_doorbell", AsyncMock(return_value=True)), \
         patch.object(api, "async_get_states", AsyncMock(return_value=state)), \
         patch.object(api, "async_get_firmware_info", AsyncMock(return_value={})), \
         patch.object(api, "async_get_role", AsyncMock(return_value="admin")), \
         patch.object(api, "async_set_hass_config", AsyncMock()):
        await coordinator.async_refresh()
        await hass.async_block_till_done()

    device = registry.async_get_device(identifiers={(DOMAIN, DEVICE_ID)})
    assert device.name_by_user == "Como yo la llamo"
