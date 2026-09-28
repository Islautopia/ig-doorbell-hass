"""1.2.3: "back to the home page" applies ONLY to a wall panel picked in Ring notifications.

Iñaki, 2026-09-28: his desktop PC was sent to the home page at the same moment as the salon panel.
The card now applies the deadline only when get_connection_info says `back_home: true`, which the
integration answers from the page's own identity: the Home Assistant user + the companion model
in the user agent the card sends (call_page_nav.is_configured_panel). Anything else fails closed.
"""
from __future__ import annotations

from custom_components.ig_doorbell import call_page_nav, websocket_api
from custom_components.ig_doorbell.const import CONF_NOTIFY_PANELS, CONF_NOTIFY_PHONES

from .conftest import DEVICE_ID
from .test_call_page_nav import TAB_UA, _with_panel_identity
from .test_ring_notifier import _setup

DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36"
PHONE_UA = "Mozilla/5.0 (Linux; Android 14; SM-M236B Build/UP1A; wv) AppleWebKit/537.36 Home Assistant/2026.6.5"


def _identity(hass, ids, name, user_id, model):
    """Give a companion the user and model a real registration carries (any companion)."""
    from homeassistant.helpers import device_registry as dr  # noqa: PLC0415
    dev = dr.async_get(hass).async_get(ids[name])
    for eid in dev.config_entries:
        e = hass.config_entries.async_get_entry(eid)
        if e and e.domain == "mobile_app":
            hass.config_entries.async_update_entry(e, data={**e.data, "user_id": user_id, "model": model})


async def _with(hass, options_for):
    entry, ids, calls, patches = await _setup(hass, options_for)
    _with_panel_identity(hass, ids)                       # Tab Test: kiosk-user, SM-X200
    _identity(hass, ids, "M23 Test", "kiosk-user", "SM-M236B")
    return ids, patches


async def test_only_the_picked_panel_page_goes_home(hass):
    ids, patches = await _with(hass, lambda ids: {CONF_NOTIFY_PANELS: [ids["Tab Test"]],
                                                  CONF_NOTIFY_PHONES: [ids["M23 Test"]]})
    try:
        assert call_page_nav.is_configured_panel(hass, "kiosk-user", TAB_UA) is True
        # the same user on a desktop browser: attended, never navigated
        assert call_page_nav.is_configured_panel(hass, "kiosk-user", DESKTOP_UA) is False
        # the panel's user agent but another Home Assistant user
        assert call_page_nav.is_configured_panel(hass, "someone-else", TAB_UA) is False
        # a phone picked as a PHONE, same user, its own model in the user agent
        assert call_page_nav.is_configured_panel(hass, "kiosk-user", PHONE_UA) is False
        # no user agent / no user: fails closed
        assert call_page_nav.is_configured_panel(hass, "kiosk-user", "") is False
        assert call_page_nav.is_configured_panel(hass, None, TAB_UA) is False
    finally:
        for p in patches:
            p.stop()


async def test_no_panel_picked_means_no_page_goes_home(hass):
    ids, patches = await _with(hass, lambda ids: {CONF_NOTIFY_PHONES: [ids["M23 Test"]]})
    try:
        assert call_page_nav.is_configured_panel(hass, "kiosk-user", TAB_UA) is False
    finally:
        for p in patches:
            p.stop()


async def test_get_connection_info_answers_back_home_for_the_page(hass, hass_ws_client, hass_admin_user):
    ids, patches = await _with(hass, lambda ids: {CONF_NOTIFY_PANELS: [ids["Tab Test"]]})
    try:
        websocket_api.async_register_websocket_commands(hass)
        ws = await hass_ws_client(hass)
        # Whoever the test client authenticates as becomes the panel's registered user.
        await ws.send_json({"id": 1, "type": "auth/current_user"})
        me = await ws.receive_json()
        user_id = me["result"]["id"] if me.get("success") else hass_admin_user.id
        _with_panel_identity(hass, ids, user_id=user_id)
        answers = {}
        for i, ua in enumerate((TAB_UA, DESKTOP_UA, None), start=2):
            msg = {"id": i, "type": "ig_doorbell/get_connection_info", "device_id": DEVICE_ID}
            if ua is not None:
                msg["ua"] = ua
            await ws.send_json(msg)
            r = await ws.receive_json()
            assert r["success"], r
            answers[ua] = r["result"]["back_home"]
        assert answers == {TAB_UA: True, DESKTOP_UA: False, None: False}
    finally:
        for p in patches:
            p.stop()
