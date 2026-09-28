"""Back to the home page applies ONLY to a wall panel picked in Ring notifications (1.2.3, 1.2.4).

Iñaki, 2026-09-28: his desktop PC was sent to the home page at the same moment as the salon panel.
The card applies the deadline only when get_connection_info says `back_home: true`.

(1.2.4) The integration answers it from the page's companion DEVICE (panel_identity.py), found
from the refresh token of the page's websocket - the companion's own login:
  1. exact: a login bound to a device by a nonce that only that device's push carried;
  2. unique user: a companion login whose user has exactly ONE companion of that platform;
  3. otherwise nothing, and the page is not a panel.
The iPad case is the reason: its user agent carries no model (1.2.3 matched by model), and its
user (like a family member's) also has a phone with the companion app.
"""
from __future__ import annotations

import time
from unittest.mock import patch

from custom_components.ig_doorbell import call_page_nav, panel_identity, websocket_api
from custom_components.ig_doorbell.const import CONF_NOTIFY_PANELS, CONF_NOTIFY_PHONES

from .conftest import DEVICE_ID
from .test_call_page_nav import BROWSER, IOS, _kiosk, _login, _with_panel_identity
from .test_ring_notifier import _envelope, _post, _setup


def _panel(hass, user_id, token_id):
    return call_page_nav.is_configured_panel(hass, user_id, token_id)


async def _with(hass, options_for):
    entry, ids, calls, patches = await _setup(hass, options_for)
    for p in patches:
        p.stop()
    return ids, calls


async def test_the_only_companion_of_its_user_is_identified(hass):
    """The salon panel: a dedicated user, one Android companion. No binding needed."""
    ids, _ = await _with(hass, lambda ids: {CONF_NOTIFY_PANELS: [ids["Tab Test"]],
                                            CONF_NOTIFY_PHONES: [ids["M23 Test"]]})
    kiosk, tab = await _kiosk(hass, ids)
    assert _panel(hass, kiosk.id, tab) is True
    # the same user in a desktop browser: a login no companion has - attended, never navigated
    assert _panel(hass, kiosk.id, await _login(hass, kiosk, BROWSER)) is False
    # the same login presented as another user (cannot happen, but must not count)
    other = await hass.auth.async_create_user("Other")
    assert _panel(hass, other.id, tab) is False
    # another user's companion
    assert _panel(hass, other.id, await _login(hass, other)) is False
    # the same user's iOS login: no iOS companion of this user at all
    assert _panel(hass, kiosk.id, await _login(hass, kiosk, IOS)) is False
    # no login / no user / a login that does not exist: fails closed
    assert _panel(hass, kiosk.id, None) is False
    assert _panel(hass, None, tab) is False
    assert _panel(hass, kiosk.id, "no-such-token") is False


async def test_nothing_picked_means_nothing_is_a_panel(hass):
    ids, _ = await _with(hass, lambda ids: {CONF_NOTIFY_PHONES: [ids["M23 Test"]]})
    kiosk, tab = await _kiosk(hass, ids)
    assert _panel(hass, kiosk.id, tab) is False


async def test_a_user_with_two_companions_is_ambiguous_until_the_panel_proves_itself(hass):
    """The iPad: its user also has an iPhone. Never a guess - until the iPad's own push is opened."""
    ids, _ = await _with(hass, lambda ids: {CONF_NOTIFY_PANELS: [ids["Ipad Test"]],
                                            CONF_NOTIFY_PHONES: [ids["Iphone Test"]]})
    concha = await hass.auth.async_create_user("Concha")
    _with_panel_identity(hass, ids, concha.id, name="Ipad Test", model="iPad13,2")
    _with_panel_identity(hass, ids, concha.id, name="Iphone Test", model="iPhone14,7")
    ipad, iphone = await _login(hass, concha, IOS), await _login(hass, concha, IOS)
    assert _panel(hass, concha.id, ipad) is False          # ambiguous: two iOS companions
    assert _panel(hass, concha.id, iphone) is False
    # ...and not merely "not a panel": NO device at all (a guess could land on either one)
    assert panel_identity.async_get(hass).identify(concha.id, ipad) is None

    pi = panel_identity.async_get(hass)
    # A nonce only the iPad's push carried, presented by pages that are NOT the iPad's app:
    assert pi.bind(pi.issue(ids["Ipad Test"]), concha.id, await _login(hass, concha, BROWSER)) is False
    stranger = await hass.auth.async_create_user("Stranger")
    assert pi.bind(pi.issue(ids["Ipad Test"]), stranger.id, await _login(hass, stranger, IOS)) is False
    old = pi.issue(ids["Ipad Test"])
    with patch.object(time, "monotonic", return_value=time.monotonic() + panel_identity.NONCE_TTL_S + 1):
        assert pi.bind(old, concha.id, ipad) is False       # expired
    assert pi.bind("made-up-nonce", concha.id, ipad) is False
    assert _panel(hass, concha.id, ipad) is False

    # The iPad opens its ring notification: its login is now the iPad, exactly.
    nonce = pi.issue(ids["Ipad Test"])
    assert pi.bind(nonce, concha.id, ipad) is True
    assert _panel(hass, concha.id, ipad) is True
    assert _panel(hass, concha.id, iphone) is False        # the iPhone is still not the iPad
    assert pi.bind(nonce, concha.id, iphone) is False      # and the nonce is spent


async def test_an_exact_identity_is_never_overridden_by_the_user_rule(hass):
    """A login bound to a device that is NOT a picked panel stays not-a-panel."""
    ids, _ = await _with(hass, lambda ids: {CONF_NOTIFY_PANELS: [ids["Tab Test"]],
                                            CONF_NOTIFY_PHONES: [ids["M23 Test"]]})
    kiosk, tab = await _kiosk(hass, ids)
    _with_panel_identity(hass, ids, kiosk.id, name="M23 Test", model="SM-M236B")
    phone = await _login(hass, kiosk)
    assert _panel(hass, kiosk.id, tab) is False            # two Android companions: ambiguous
    assert panel_identity.async_get(hass).identify(kiosk.id, tab) is None
    pi = panel_identity.async_get(hass)
    assert pi.bind(pi.issue(ids["M23 Test"]), kiosk.id, phone) is True
    assert pi.bind(pi.issue(ids["Tab Test"]), kiosk.id, tab) is True
    assert _panel(hass, kiosk.id, phone) is False          # exactly the phone: never a panel
    assert _panel(hass, kiosk.id, tab) is True             # exactly the panel


async def test_the_ring_carries_the_nonce_and_the_call_page_binds_with_it(
        hass, hass_ws_client):
    """End to end: the iPad's ring notification URL -> get_connection_info on that page."""
    entry, ids, calls, patches = await _setup(hass, lambda ids: {CONF_NOTIFY_PANELS: [ids["Ipad Test"]],
                                                                 CONF_NOTIFY_PHONES: [ids["Iphone Test"]]})
    concha = await hass.auth.async_create_user("Concha")
    _with_panel_identity(hass, ids, concha.id, name="Ipad Test", model="iPad13,2")
    _with_panel_identity(hass, ids, concha.id, name="Iphone Test", model="iPhone14,7")
    websocket_api.async_register_websocket_commands(hass)
    await _post(hass, _envelope("ring"))
    for p in patches:
        p.stop()
    url = calls["Ipad Test"][0].data["data"]["url"]
    assert "igd_panel=" in url
    phone_url = calls["Iphone Test"][0].data["data"]["url"]
    assert "igd_panel=" not in phone_url                   # a phone is never given one
    nonce = url.split("igd_panel=", 1)[1]

    async def _ask(client_id, **extra):
        rt = await hass.auth.async_create_refresh_token(concha, client_id=client_id)
        ws = await hass_ws_client(hass, access_token=hass.auth.async_create_access_token(rt))
        await ws.send_json({"id": 1, "type": "ig_doorbell/get_connection_info",
                            "device_id": DEVICE_ID, **extra})
        r = await ws.receive_json()
        assert r["success"], r
        return r["result"]["back_home"], rt

    # the iPhone's page, even handed the iPad's URL: not the iPad's login, not a panel
    assert (await _ask(IOS))[0] is False
    # a desktop browser of the same user with the iPad's URL: never
    assert (await _ask(BROWSER, panel_nonce=nonce))[0] is False
    # the iPad's page opened from its notification
    back_home, ipad_rt = await _ask(IOS, panel_nonce=nonce)
    assert back_home is True
    assert _panel(hass, concha.id, ipad_rt.id) is True


async def test_bindings_survive_a_restart(hass, hass_storage):
    ids, _ = await _with(hass, lambda ids: {CONF_NOTIFY_PANELS: [ids["Ipad Test"]]})
    concha = await hass.auth.async_create_user("Concha")
    _with_panel_identity(hass, ids, concha.id, name="Ipad Test")
    _with_panel_identity(hass, ids, concha.id, name="Iphone Test")
    ipad = await _login(hass, concha, IOS)
    pi = panel_identity.async_get(hass)
    assert pi.bind(pi.issue(ids["Ipad Test"]), concha.id, ipad) is True
    await pi.store.async_save({"bound": dict(pi.bound)})
    fresh = panel_identity.PanelIdentity(hass)
    await fresh.async_load()
    assert fresh.identify(concha.id, ipad) == ids["Ipad Test"]
