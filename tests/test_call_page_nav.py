"""1.2.2: a ring brings an Android wall panel to the call page IN THE WINDOW ALREADY ON SCREEN.

Measured on the salon panel: command_webview opens a new companion window (task) on every ring.
The notifier now asks the panel's own page (subscribed over the websocket, call_page_nav.py) to
navigate in place, and only falls back to command_webview when no page acknowledges.
"""
from __future__ import annotations

import asyncio
from unittest.mock import patch

from homeassistant.helpers import device_registry as dr

from custom_components.ig_doorbell import call_page_nav
from custom_components.ig_doorbell.const import CONF_NOTIFY_PANELS

from .conftest import DEVICE_ID
from .test_ring_notifier import _envelope, _post, _setup

PAGE = f"/ig-doorbell?device={DEVICE_ID}"
ANDROID = "https://home-assistant.io/android"
IOS = "https://home-assistant.io/iOS"
BROWSER = "https://hass.example.org/"


def _with_panel_identity(hass, ids, user_id, name="Tab Test", model="SM-X200"):
    """Give a companion the user (and model) a real registration carries."""
    reg = dr.async_get(hass)
    dev = reg.async_get(ids[name])
    for eid in dev.config_entries:
        e = hass.config_entries.async_get_entry(eid)
        if e and e.domain == "mobile_app":
            hass.config_entries.async_update_entry(e, data={**e.data, "user_id": user_id, "model": model})


async def _login(hass, user, client_id=ANDROID) -> str:
    """A refresh token of `user` issued to `client_id` (a companion app, or a browser)."""
    return (await hass.auth.async_create_refresh_token(user, client_id=client_id)).id


async def _kiosk(hass, ids):
    """The salon set-up: a dedicated user whose only companion is the Android panel."""
    user = await hass.auth.async_create_user("Kiosk")
    _with_panel_identity(hass, ids, user.id)
    return user, await _login(hass, user)


async def _ring_with(hass, page_behaviour, ack_s=0.3):
    entry, ids, calls, patches = await _setup(hass, lambda ids: {CONF_NOTIFY_PANELS: [ids["Tab Test"]]})
    user, tab = await _kiosk(hass, ids)
    nav = call_page_nav.async_get(hass)
    got = []
    if page_behaviour:
        def _send(payload):
            got.append(payload)
            if page_behaviour == "ack":
                nav.async_ack(payload["token"], user.id, tab)
        nav.async_subscribe(user.id, tab, _send)
    with patch.object(call_page_nav, "ACK_LIVE_S", ack_s), patch.object(call_page_nav, "ACK_RECENT_S", ack_s):
        await _post(hass, _envelope("ring"))
    msgs = [c.data["message"] for c in calls["Tab Test"]]
    for p in patches:
        p.stop()
    return msgs, got


async def test_a_visible_page_shows_the_call_page_in_place_no_new_window(hass):
    msgs, got = await _ring_with(hass, "ack")
    assert got and got[0]["url"] == PAGE
    assert "command_screen_on" in msgs
    assert "command_webview" not in msgs


async def test_no_answer_falls_back_to_command_webview(hass):
    msgs, got = await _ring_with(hass, "silent")
    assert got                                   # it was asked...
    assert msgs[-1] == "command_webview"         # ...and did not answer: a new window, but a call page


async def test_no_page_at_all_goes_straight_to_command_webview(hass):
    msgs, got = await _ring_with(hass, None)
    assert not got and msgs[-1] == "command_webview"


async def _nav_setup(hass):
    entry, ids, calls, patches = await _setup(hass, lambda ids: {CONF_NOTIFY_PANELS: [ids["Tab Test"]]})
    for p in patches:
        p.stop()
    user, tab = await _kiosk(hass, ids)
    return ids, user, tab


async def test_another_user_a_browser_or_another_device_is_never_asked(hass):
    ids, user, tab = await _nav_setup(hass)
    nav = call_page_nav.async_get(hass)
    got = []
    other = await hass.auth.async_create_user("Someone")
    nav.async_subscribe(other.id, await _login(hass, other), got.append)          # another user
    nav.async_subscribe(user.id, await _login(hass, user, BROWSER), got.append)   # the kiosk user, a browser
    nav.async_subscribe(user.id, None, got.append)                                 # no login known
    assert await nav.async_show(ids["Tab Test"], PAGE) is False
    assert await nav.async_show(ids["M23 Test"], PAGE) is False                    # nobody is the M23
    assert got == []


async def test_a_page_that_reconnects_while_the_ring_waits_gets_it(hass):
    ids, user, tab = await _nav_setup(hass)
    nav = call_page_nav.async_get(hass)
    unsub = nav.async_subscribe(user.id, tab, lambda p: None)
    unsub()                                      # the screen went off: the websocket was dropped
    got = []

    async def _reconnect():
        await asyncio.sleep(0.05)
        nav.async_subscribe(user.id, tab, lambda p: (got.append(p), nav.async_ack(p["token"], user.id, tab)))

    with patch.object(call_page_nav, "ACK_RECENT_S", 1.0):
        task = hass.async_create_task(_reconnect())
        assert await nav.async_show(ids["Tab Test"], PAGE) is True
        await task
    assert got and got[0]["url"] == PAGE


async def test_an_ack_from_another_login_does_not_count(hass):
    ids, user, tab = await _nav_setup(hass)
    nav = call_page_nav.async_get(hass)
    intruder = await hass.auth.async_create_user("Intruder")
    other = await _login(hass, intruder)
    nav.async_subscribe(user.id, tab, lambda p: nav.async_ack(p["token"], intruder.id, other))
    with patch.object(call_page_nav, "ACK_LIVE_S", 0.2):
        assert await nav.async_show(ids["Tab Test"], PAGE) is False
