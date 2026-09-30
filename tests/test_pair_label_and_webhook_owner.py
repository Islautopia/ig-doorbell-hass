"""1.4.5: the pairing label is unique per Home Assistant installation, and taking over the doorbell's
ONE webhook from another Home Assistant is a question, never a silent move.

Measured 2026-09-30: two Home Assistant installations both named "Casa" paired the same doorbell with
the same admin account. The label was "Home Assistant Casa" for both, the doorbell reused the slot
(§1.5 identifies a pairing by `email|label`), and the first one lost its credential without a word.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import instance_id

from custom_components.ig_doorbell import api, config_flow
from custom_components.ig_doorbell.const import DOMAIN

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP

# Documentation-range addresses only (RFC 5737): this repository is public.
OTHER_HA = "http://192.0.2.50:8123"
OURS = "http://198.51.100.7:8123"
ID_A = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
ID_B = "a1b2c3d4e5f60718293a4b5c6d7e8f90"


def _url(base: str) -> str:
    return f"{base}/api/webhook/ig_doorbell_{DEVICE_ID}"


# ---------------------------------------------------------------------------------------------
# The label
# ---------------------------------------------------------------------------------------------

async def _label_for(hass, name: str, iid: str) -> str:
    hass.config.location_name = name
    with patch.object(instance_id, "async_get", AsyncMock(return_value=iid)):
        return await config_flow._new_label(hass)


async def test_two_installations_with_the_same_name_get_different_labels(hass):
    a = await _label_for(hass, "Casa", ID_A)
    b = await _label_for(hass, "Casa", ID_B)
    assert a == "Home Assistant Casa 0f1e2d"
    assert b == "Home Assistant Casa a1b2c3"
    assert a != b


async def test_label_is_stable_across_restarts(hass):
    """The real instance id (stored by HA in .storage/core.uuid), asked twice: same label."""
    hass.config.location_name = "Casa"
    first = await config_flow._new_label(hass)
    second = await config_flow._new_label(hass)
    iid = await instance_id.async_get(hass)
    assert first == second
    assert first.endswith(" " + iid.replace("-", "")[:6])


async def test_long_accented_name_is_trimmed_never_the_id_and_fits_the_firmware(hass):
    label = await _label_for(hass, "Casa de campo de la señora Muñoz en Alcalá", ID_A)
    assert label.endswith(" 0f1e2d")
    assert len(label.encode("utf-8")) <= 32
    label.encode("utf-8").decode("utf-8")          # no split character
    assert label.startswith("Home Assistant Casa")


async def test_characters_the_firmware_rewrites_are_dropped(hass):
    label = await _label_for(hass, 'Ca"sa\\\n  Norte', ID_A)
    assert label == "Home Assistant Casa Norte 0f1e2d"


async def test_empty_name_still_unique(hass):
    assert await _label_for(hass, "", ID_A) == "Home Assistant 0f1e2d"


# ---------------------------------------------------------------------------------------------
# The webhook owner
# ---------------------------------------------------------------------------------------------

async def _up_to_pair(hass):
    r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    with patch.object(api, "async_get_device_id", AsyncMock(return_value=DEVICE_ID)), \
         patch.object(api, "async_check_tls", AsyncMock()):
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {"host": LAN_IP})
    assert r["step_id"] == "pair"
    return r


def _doorbell(current_webhook: str, pair: AsyncMock):
    return (
        patch.object(api, "async_login", AsyncMock()),
        patch.object(api, "async_logout", AsyncMock()),
        patch.object(api, "async_get_hass_webhook_url", AsyncMock(return_value=current_webhook)),
        patch.object(api, "async_pair_app", pair),
        patch.object(api, "async_get_states", AsyncMock(return_value={})),
        patch.object(config_flow, "_our_webhook_url", AsyncMock(return_value=_url(OURS))),
        patch("custom_components.ig_doorbell.async_setup_entry", AsyncMock(return_value=True)),
    )


async def _submit(hass, r, current_webhook, pair, user_input):
    ps = _doorbell(current_webhook, pair)
    for p in ps:
        p.start()
    try:
        return await hass.config_entries.flow.async_configure(r["flow_id"], user_input)
    finally:
        for p in ps:
            p.stop()


async def test_another_home_assistant_owns_the_webhook_asks_before_pairing(hass):
    r = await _up_to_pair(hass)
    pair = AsyncMock(return_value=api.PairResult(DEVICE_ID, CREDENTIAL))
    r = await _submit(hass, r, _url(OTHER_HA), pair, {"email": "a@b.c", "password": "p"})
    assert r["type"] is FlowResultType.FORM
    assert r["step_id"] == "move_notifications"
    assert r["description_placeholders"] == {"other": "192.0.2.50:8123"}
    pair.assert_not_awaited()                       # nothing moved yet
    assert hass.config_entries.async_entries(DOMAIN) == []

    r = await _submit(hass, r, _url(OTHER_HA), pair, {})
    assert r["type"] is FlowResultType.CREATE_ENTRY
    pair.assert_awaited_once()
    assert r["data"]["credential"] == CREDENTIAL


async def test_no_webhook_or_our_own_pairs_without_asking(hass):
    for current in ("", _url(OURS)):
        for e in hass.config_entries.async_entries(DOMAIN):
            await hass.config_entries.async_remove(e.entry_id)
        r = await _up_to_pair(hass)
        pair = AsyncMock(return_value=api.PairResult(DEVICE_ID, CREDENTIAL))
        r = await _submit(hass, r, current, pair, {"email": "a@b.c", "password": "p"})
        assert r["type"] is FlowResultType.CREATE_ENTRY, current
        pair.assert_awaited_once()


async def test_wrong_password_is_reported_before_any_warning(hass):
    r = await _up_to_pair(hass)
    with patch.object(api, "async_login", AsyncMock(side_effect=api.AuthenticationError())):
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {"email": "a", "password": "b"})
    assert r["step_id"] == "pair"
    assert r["errors"] == {"base": "invalid_auth"}


async def test_the_warning_is_translated_in_all_six_languages():
    import json
    from pathlib import Path

    base = Path(config_flow.__file__).parent
    for lang in ("en", "es", "fr", "it", "de", "pt"):
        d = json.loads((base / "translations" / f"{lang}.json").read_text(encoding="utf-8"))
        for section, step in (("config", "move_notifications"), ("options", "repair_move_notifications")):
            desc = d[section]["step"][step]["description"]
            assert "{other}" in desc and "Home Assistant" in desc, (lang, step)


async def test_repair_asks_too_and_keeps_the_stored_label(hass):
    """Re-pairing an existing entry: same question, and the STORED label (its slot), never a new one."""
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    from custom_components.ig_doorbell.const import CONF_CREDENTIAL, CONF_DEVICE_ID, CONF_HOST_HINT, CONF_LABEL

    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=DEVICE_ID,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: "old", CONF_HOST_HINT: LAN_IP,
              CONF_LABEL: "Home Assistant Casa"},
    )
    entry.add_to_hass(hass)
    r = await hass.config_entries.options.async_init(entry.entry_id)
    r = await hass.config_entries.options.async_configure(r["flow_id"], {"next_step_id": "repair"})
    assert r["step_id"] == "repair"
    pair = AsyncMock(return_value=api.PairResult(DEVICE_ID, CREDENTIAL))
    ps = _doorbell(_url(OTHER_HA), pair)
    for p in ps:
        p.start()
    try:
        r = await hass.config_entries.options.async_configure(r["flow_id"], {"email": "a@b.c", "password": "p"})
        assert r["step_id"] == "repair_move_notifications"
        assert r["description_placeholders"] == {"other": "192.0.2.50:8123"}
        pair.assert_not_awaited()
        r = await hass.config_entries.options.async_configure(r["flow_id"], {})
    finally:
        for p in ps:
            p.stop()
    assert r["type"] is FlowResultType.CREATE_ENTRY
    assert pair.await_args.args[2] == "Home Assistant Casa"
    assert entry.data[CONF_CREDENTIAL] == CREDENTIAL
