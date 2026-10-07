"""The doorbell may only act on the entities this integration gave it, and hears whether it happened.

0.7.6 (Inaki, 2026-09-25): the door (`ha_e`) and the `hass` step of a sequence are picked from a
list of at most 5 on/off entities chosen here and pushed to the doorbell (contract 4). These tests
pin the integration's half of the defence on both sides:

- an order for an entity NOT in this entry's list is refused and nothing is called, even though the
  doorbell asked for it;
- a listed entity is actually switched, `ok: true` comes back in the webhook answer, and a lock maps
  "on" to `lock.unlock`;
- the list pushed to the doorbell keeps only the allowed domains and at most 5, with `domain`.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

from homeassistant.core import ServiceCall
from homeassistant.setup import async_setup_component

from pytest_homeassistant_custom_component.common import MockConfigEntry, async_mock_service

from custom_components.ig_doorbell import api, net, webhook
from custom_components.ig_doorbell.const import (
    CONF_CREDENTIAL, CONF_DEVICE_ID, CONF_ENTITIES, CONF_HOST_HINT, DOMAIN,
)

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP

WID = webhook.webhook_id_for(DEVICE_ID)


async def _setup(hass, entities: list[str], state: dict | None = None):
    await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=DEVICE_ID,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL, CONF_HOST_HINT: LAN_IP},
        options={CONF_ENTITIES: entities},
    )
    entry.add_to_hass(hass)
    push = AsyncMock()
    with patch.object(net, "is_this_doorbell", AsyncMock(return_value=True)), \
         patch.object(api, "async_get_states", AsyncMock(return_value=state or {"m": 0, "door_m": 1})), \
         patch.object(api, "async_get_firmware_info", AsyncMock(return_value={"fw_version": "0.100.4"})), \
         patch.object(api, "async_get_role", AsyncMock(return_value="admin")), \
         patch.object(api, "async_set_hass_config", push):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return entry, push


async def test_refuses_an_entity_outside_its_list(hass):
    await _setup(hass, ["input_boolean.prueba"])
    hass.states.async_set("switch.otra", "off")
    calls = async_mock_service(hass, "switch", "turn_on")

    done, error = await webhook._act_on_entity(hass, WID, "switch.otra", True)

    assert (done, error) == (False, "not_listed")
    assert calls == []


async def test_acts_on_a_listed_entity_and_confirms(hass):
    await _setup(hass, ["input_boolean.prueba", "lock.puerta"])
    hass.states.async_set("input_boolean.prueba", "off")
    hass.states.async_set("lock.puerta", "locked")
    on: list[ServiceCall] = async_mock_service(hass, "input_boolean", "turn_on")
    unlock_calls: list[ServiceCall] = async_mock_service(hass, "lock", "unlock")

    assert await webhook._act_on_entity(hass, WID, "input_boolean.prueba", True) == (True, None)
    assert [c.data["entity_id"] for c in on] == ["input_boolean.prueba"]

    # In a lock, "on" is OPEN.
    assert await webhook._act_on_entity(hass, WID, "lock.puerta", True) == (True, None)
    assert [c.data["entity_id"] for c in unlock_calls] == ["lock.puerta"]


async def test_says_so_when_the_entity_is_missing_or_unavailable(hass):
    await _setup(hass, ["light.porche", "switch.caido"])
    hass.states.async_set("switch.caido", "unavailable")
    assert await webhook._act_on_entity(hass, WID, "light.porche", True) == (False, "entity_missing")
    assert await webhook._act_on_entity(hass, WID, "switch.caido", True) == (False, "entity_unavailable")


async def test_pushes_only_allowed_domains_at_most_five_with_domain(hass):
    chosen = ["button.timbre", "light.a", "light.b", "switch.c", "fan.d", "siren.e", "lock.f"]
    _entry, push = await _setup(hass, chosen)
    entity_list = push.call_args.kwargs["entities"]
    assert [e["id"] for e in entity_list] == ["light.a", "light.b", "switch.c", "fan.d", "siren.e"]
    assert all(e["domain"] == e["id"].split(".")[0] for e in entity_list)


async def test_the_entity_that_already_opens_the_door_is_adopted(hass):
    """Updating from 0.7.5 must not leave the door shut: its hand-written `ha_e` joins the list."""
    entry, push = await _setup(hass, [], {"m": 0, "door_m": 1, "ha_e": "lock.entrada"})
    assert entry.options[CONF_ENTITIES] == ["lock.entrada"]
    assert [e["id"] for e in push.call_args.kwargs["entities"]] == ["lock.entrada"]


async def test_a_door_entity_of_a_refused_domain_is_not_adopted(hass):
    entry, _ = await _setup(hass, [], {"m": 0, "door_m": 1, "ha_e": "button.abrir"})
    assert entry.options[CONF_ENTITIES] == []


# --- Launch-only entities: script and automation (1.5.3, Inaki 2026-10-07) -------------------


async def test_script_on_launches_it_and_off_is_refused_without_a_service_call(hass):
    await _setup(hass, ["script.halloween"])
    hass.states.async_set("script.halloween", "off")
    turn_on = async_mock_service(hass, "script", "turn_on")
    turn_off = async_mock_service(hass, "script", "turn_off")

    assert await webhook._act_on_entity(hass, WID, "script.halloween", True) == (True, None)
    assert [c.data["entity_id"] for c in turn_on] == ["script.halloween"]

    # NEGATIVE CONTROL: "off" must not stop the script nor call anything.
    assert await webhook._act_on_entity(hass, WID, "script.halloween", False) == (False, "no_off")
    assert turn_off == []
    assert len(turn_on) == 1


async def test_automation_on_triggers_it_with_its_conditions_and_off_is_refused(hass):
    await _setup(hass, ["automation.halloween"])
    hass.states.async_set("automation.halloween", "on")
    trigger = async_mock_service(hass, "automation", "trigger")
    turn_on = async_mock_service(hass, "automation", "turn_on")
    turn_off = async_mock_service(hass, "automation", "turn_off")

    assert await webhook._act_on_entity(hass, WID, "automation.halloween", True) == (True, None)
    assert [(c.data["entity_id"], c.data["skip_condition"]) for c in trigger] == [
        ("automation.halloween", False)]

    assert await webhook._act_on_entity(hass, WID, "automation.halloween", False) == (False, "no_off")
    # Never the enable/disable services.
    assert turn_on == [] and turn_off == [] and len(trigger) == 1


async def test_a_disabled_automation_answers_disabled_and_is_not_triggered(hass):
    await _setup(hass, ["automation.halloween"])
    hass.states.async_set("automation.halloween", "off")
    trigger = async_mock_service(hass, "automation", "trigger")

    assert await webhook._act_on_entity(hass, WID, "automation.halloween", True) == (False, "disabled")
    assert trigger == []


async def test_an_unlisted_script_or_automation_is_not_listed(hass):
    await _setup(hass, ["input_boolean.prueba"])
    hass.states.async_set("script.otro", "off")
    hass.states.async_set("automation.otra", "on")
    s = async_mock_service(hass, "script", "turn_on")
    a = async_mock_service(hass, "automation", "trigger")

    assert await webhook._act_on_entity(hass, WID, "script.otro", True) == (False, "not_listed")
    assert await webhook._act_on_entity(hass, WID, "automation.otra", True) == (False, "not_listed")
    assert s == [] and a == []


async def test_missing_or_unavailable_script_is_reported(hass):
    await _setup(hass, ["script.a", "script.b"])
    hass.states.async_set("script.b", "unavailable")
    assert await webhook._act_on_entity(hass, WID, "script.a", True) == (False, "entity_missing")
    assert await webhook._act_on_entity(hass, WID, "script.b", True) == (False, "entity_unavailable")


async def test_existing_domains_are_unchanged_off_still_works(hass):
    await _setup(hass, ["light.a", "lock.b"])
    hass.states.async_set("light.a", "on")
    hass.states.async_set("lock.b", "unlocked")
    off = async_mock_service(hass, "light", "turn_off")
    lock = async_mock_service(hass, "lock", "lock")
    assert await webhook._act_on_entity(hass, WID, "light.a", False) == (True, None)
    assert await webhook._act_on_entity(hass, WID, "lock.b", False) == (True, None)
    assert len(off) == 1 and len(lock) == 1


async def test_script_and_automation_are_pushed_with_their_domain_scene_and_button_are_not(hass):
    chosen = ["scene.x", "button.y", "script.halloween", "automation.halloween", "light.a"]
    _entry, push = await _setup(hass, chosen)
    entity_list = push.call_args.kwargs["entities"]
    assert [(e["id"], e["domain"]) for e in entity_list] == [
        ("script.halloween", "script"), ("automation.halloween", "automation"),
        ("light.a", "light")]
