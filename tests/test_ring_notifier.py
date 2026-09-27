"""Ring notifications sent by the integration itself (1.2.0, docs/design/ha-only-ringing.md).

Everything goes through the REAL webhook handler (webhook._handle) with the §3.6.1 envelopes the
doorbell sends, and the companion apps are stand-ins: `mobile_app` config entries + devices in the
registry + mocked `notify.mobile_app_*` services that record what they were asked to send.
The doorbell is never contacted: every network function is patched.
"""
from __future__ import annotations

import time
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.helpers import device_registry as dr
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util

from pytest_homeassistant_custom_component.common import (
    MockConfigEntry, async_fire_time_changed, async_mock_service,
)

from custom_components.ig_doorbell import api, net, notify_ring, panel, webhook
from custom_components.ig_doorbell.const import (
    CONF_CREDENTIAL, CONF_DEVICE_ID, CONF_HOST_HINT, CONF_NOTIFY_CRITICAL, CONF_NOTIFY_OPEN_DOOR,
    CONF_NOTIFY_PANELS, CONF_NOTIFY_PHONES, CONF_PANEL_RETURN_PATH, DOMAIN, RING_SAFETY_S,
)

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP

WID = webhook.webhook_id_for(DEVICE_ID)
CALL = "11111111-2222-4333-8444-555555555555"
TAG = f"igd_{DEVICE_ID}_{CALL}"
PAGE = f"/ig-doorbell?device={DEVICE_ID}"

COMPANIONS = {
    # name: (os_name, app_id)
    "Iphone Test": ("iOS", "io.robbie.HomeAssistant"),
    "M23 Test": ("Android", "io.homeassistant.companion.android"),
    "Tab Test": ("Android", "io.homeassistant.companion.android"),
    "Ipad Test": ("iPadOS", "io.robbie.HomeAssistant"),
}


class _Req:
    def __init__(self, body: dict) -> None:
        self._body = body

    async def json(self) -> dict:
        return self._body


def _envelope(ev: str, call_id: str | None = CALL, lang: str = "en", **d) -> dict:
    e = {"type": "event", "ev": ev, "n": 1, "ts": 1790000000, "device_id": DEVICE_ID,
         "dname": "Front door", "lang": lang, "tz_name": "Europe/Madrid"}
    if call_id:
        e["call_id"] = call_id
    if d:
        e["d"] = d
    return e


async def _post(hass, envelope: dict) -> None:
    await webhook._handle(hass, WID, _Req(envelope))
    await hass.async_block_till_done()


def _companions(hass) -> dict[str, str]:
    """name -> registry device id, and one recording notify service per companion."""
    reg = dr.async_get(hass)
    ids = {}
    for name, (os_name, app_id) in COMPANIONS.items():
        me = MockConfigEntry(domain="mobile_app", data={
            "device_name": name, "os_name": os_name, "app_id": app_id,
            "webhook_id": f"w_{name}", "device_id": f"d_{name}"})
        me.add_to_hass(hass)
        dev = reg.async_get_or_create(config_entry_id=me.entry_id,
                                      identifiers={("mobile_app", f"d_{name}")}, name=name)
        ids[name] = dev.id
    return ids


async def _setup(hass, options_for=None, state_extra: dict | None = None, snapshot=b"JPEG"):
    await async_setup_component(hass, "http", {})
    ids = _companions(hass)
    calls = {n: async_mock_service(hass, "notify", notify_ring.slugify(f"mobile_app_{n}"))
             for n in COMPANIONS}
    options = options_for(ids) if options_for else {}
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=DEVICE_ID,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL, CONF_HOST_HINT: LAN_IP},
        options=options,
    )
    entry.add_to_hass(hass)
    state = {"m": 0, "door_m": 0, "webrtc_clients": 0, "dname": "Test", "panel": 0, "reader": 0,
             "call_snap": 1, **(state_extra or {})}
    snap = snapshot if isinstance(snapshot, AsyncMock) else AsyncMock(return_value=snapshot)
    patches = [
        patch.object(net, "is_this_doorbell", AsyncMock(return_value=True)),
        patch.object(api, "async_get_states", AsyncMock(return_value=state)),
        patch.object(api, "async_get_firmware_info", AsyncMock(return_value={"fw_version": "0.101.3"})),
        patch.object(api, "async_get_role", AsyncMock(return_value="admin")),
        patch.object(api, "async_set_hass_config", AsyncMock()),
        patch.object(api, "async_get_alert_snapshot", snap),
    ]
    for p in patches:
        p.start()
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry, ids, calls, patches


def _all(ids, **extra):
    return {CONF_NOTIFY_PHONES: [ids["Iphone Test"], ids["M23 Test"]],
            CONF_NOTIFY_PANELS: [ids["Tab Test"], ids["Ipad Test"]], **extra}


@pytest.fixture
async def rung(hass):
    entry, ids, calls, patches = await _setup(
        hass, lambda ids: _all(ids, **{CONF_PANEL_RETURN_PATH: "/lovelace/home",
                                       CONF_NOTIFY_OPEN_DOOR: True}))
    await _post(hass, _envelope("ring"))
    yield entry, ids, calls
    for p in patches:
        p.stop()


def _msgs(calls, name):
    return [c.data for c in calls[name]]


async def test_off_by_default_nothing_is_sent(hass):
    _, _, calls, patches = await _setup(hass)
    await _post(hass, _envelope("ring"))
    assert all(not c for c in calls.values())
    for p in patches:
        p.stop()


async def test_iphone_gets_a_critical_ring_with_picture_and_call_page(hass, rung):
    _, _, calls = rung
    (m,) = _msgs(calls, "Iphone Test")
    assert m["title"] == "Front door" and m["message"] == "Someone is at the door"
    d = m["data"]
    assert d["tag"] == TAG
    assert d["push"]["interruption-level"] == "critical"
    assert d["push"]["sound"]["critical"] == 1
    assert d["url"] == PAGE
    assert d["image"].startswith("/api/image_proxy/image.")
    titles = [a["title"] for a in d["actions"]]
    assert titles == ["Open", "Open door"]
    assert d["actions"][1]["authenticationRequired"] is True


async def test_android_phone_rings_on_the_alarm_stream(hass, rung):
    _, _, calls = rung
    (m,) = _msgs(calls, "M23 Test")
    d = m["data"]
    assert d["tag"] == TAG and d["channel"] == "alarm_stream" and d["ttl"] == 0
    assert d["priority"] == "high" and d["clickAction"] == PAGE and d["car_ui"] is True


async def test_android_panel_wakes_and_opens_the_call_page(hass, rung):
    _, _, calls = rung
    msgs = _msgs(calls, "Tab Test")
    assert [m["message"] for m in msgs] == ["Someone is at the door", "command_screen_on",
                                            "command_webview"]
    assert msgs[2]["data"]["command"] == PAGE
    # A panel is shared: no "Open door" action on its notification.
    assert [a["title"] for a in msgs[0]["data"]["actions"]] == ["Open"]


async def test_ipad_panel_gets_a_notification_only(hass, rung):
    _, _, calls = rung
    msgs = _msgs(calls, "Ipad Test")
    assert [m["message"] for m in msgs] == ["Someone is at the door"]
    assert msgs[0]["data"]["url"] == PAGE


async def test_answered_clears_everywhere_by_the_same_tag_and_panels_go_home(hass, rung):
    _, _, calls = rung
    for c in calls.values():
        c.clear()
    await _post(hass, _envelope("call_answered", by="iPhone"))
    for name in COMPANIONS:
        clears = [m for m in _msgs(calls, name) if m["message"] == "clear_notification"]
        assert clears and clears[0]["data"]["tag"] == TAG, name
    # Android: the clear must be a high-priority push, or a phone in Doze holds it for minutes.
    (clear_android,) = [m for m in _msgs(calls, "M23 Test") if m["message"] == "clear_notification"]
    assert clear_android["data"]["priority"] == "high" and clear_android["data"]["ttl"] == 0
    home = [m for m in _msgs(calls, "Tab Test") if m["message"] == "command_webview"]
    assert home and home[0]["data"]["command"] == "/lovelace/home"
    assert not [m for m in _msgs(calls, "Ipad Test") if m["message"] == "command_webview"]


async def test_missed_replaces_the_ring_quietly_on_phones(hass, rung):
    _, _, calls = rung
    for c in calls.values():
        c.clear()
    await _post(hass, _envelope("call_missed"))
    (ios,) = _msgs(calls, "Iphone Test")
    assert ios["message"] == "Missed call at 16:13"      # the doorbell's zone, not UTC
    assert ios["data"]["tag"] == TAG and ios["data"]["push"]["interruption-level"] == "passive"
    (android,) = _msgs(calls, "M23 Test")
    assert android["data"]["tag"] == TAG and android["data"]["importance"] == "low"
    assert android["data"]["channel"] != "alarm_stream"
    assert android["data"]["priority"] == "high" and android["data"]["ttl"] == 0
    assert [m["message"] for m in _msgs(calls, "Tab Test")] == ["clear_notification", "command_webview"]


async def test_a_resolution_of_another_call_changes_nothing(hass, rung):
    _, _, calls = rung
    for c in calls.values():
        c.clear()
    await _post(hass, _envelope("call_answered", call_id="some-other-call"))
    assert all(not c for c in calls.values())


async def test_only_the_first_resolution_counts(hass, rung):
    _, _, calls = rung
    await _post(hass, _envelope("call_answered"))
    for c in calls.values():
        c.clear()
    await _post(hass, _envelope("call_missed"))
    assert all(not c for c in calls.values())


async def test_a_ring_delivered_twice_rings_once(hass, rung):
    _, _, calls = rung
    await _post(hass, _envelope("ring"))
    assert len(_msgs(calls, "Iphone Test")) == 1


async def test_no_resolution_panels_go_home_phones_keep_their_notice(hass, rung):
    _, _, calls = rung
    for c in calls.values():
        c.clear()
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=RING_SAFETY_S + 1))
    await hass.async_block_till_done()
    assert [m["message"] for m in _msgs(calls, "Tab Test")] == ["clear_notification", "command_webview"]
    assert not _msgs(calls, "Iphone Test") and not _msgs(calls, "M23 Test")


async def test_texts_follow_the_doorbell_language(hass):
    _, _, calls, patches = await _setup(hass, lambda ids: {CONF_NOTIFY_PHONES: [ids["M23 Test"]]})
    await _post(hass, _envelope("ring", lang="es"))
    (m,) = _msgs(calls, "M23 Test")
    assert m["message"] == "Están llamando a la puerta"
    assert m["data"]["actions"] == [{"action": "URI", "title": "Abrir", "uri": PAGE}]
    for p in patches:
        p.stop()


async def test_not_critical_when_the_owner_says_so(hass):
    _, _, calls, patches = await _setup(hass, lambda ids: {
        CONF_NOTIFY_PHONES: [ids["M23 Test"], ids["Iphone Test"]], CONF_NOTIFY_CRITICAL: False})
    await _post(hass, _envelope("ring"))
    assert _msgs(calls, "M23 Test")[0]["data"]["channel"] == "IG Doorbell"
    assert _msgs(calls, "Iphone Test")[0]["data"]["push"] == {"interruption-level": "time-sensitive"}
    for p in patches:
        p.stop()


async def test_no_picture_when_the_owner_turned_it_off(hass):
    _, _, calls, patches = await _setup(hass, lambda ids: {CONF_NOTIFY_PHONES: [ids["M23 Test"]]},
                                        state_extra={"call_snap": 0})
    await _post(hass, _envelope("ring"))
    assert "image" not in _msgs(calls, "M23 Test")[0]["data"]
    for p in patches:
        p.stop()


async def test_without_the_notifier_the_picture_is_only_fetched_when_asked_and_a_403_clears_it(hass):
    snap = AsyncMock(return_value=b"JPEG1")
    entry, _, _, patches = await _setup(hass, snapshot=snap)
    img = hass.data[DOMAIN][entry.entry_id]["visitor_image"]
    await _post(hass, _envelope("ring"))
    # Nobody uses the built-in notifier here: no capture at the ring (principle 2).
    assert snap.await_count == 0
    assert await img.async_image() == b"JPEG1"
    assert snap.await_count == 1
    snap.side_effect = api.SnapshotDisabledError("call_snapshot_disabled")
    await _post(hass, _envelope("ring", call_id="second"))
    # The previous visitor must not be shown as this ring's.
    assert await img.async_image() is None
    assert snap.await_count == 2
    for p in patches:
        p.stop()


async def test_with_the_notifier_on_the_picture_is_fetched_at_the_ring(hass):
    snap = AsyncMock(return_value=b"JPEG1")
    entry, _, _, patches = await _setup(hass, lambda ids: {CONF_NOTIFY_PHONES: [ids["M23 Test"]]},
                                        snapshot=snap)
    await _post(hass, _envelope("ring"))
    assert snap.await_count == 1
    for p in patches:
        p.stop()


async def test_a_picture_asked_for_too_late_is_not_the_visitor_and_is_not_fetched(hass):
    snap = AsyncMock(return_value=b"JPEG1")
    entry, _, _, patches = await _setup(hass, snapshot=snap)
    img = hass.data[DOMAIN][entry.entry_id]["visitor_image"]
    await _post(hass, _envelope("ring"))
    assert await img.async_image() == b"JPEG1"
    await _post(hass, _envelope("ring", call_id="second"))
    img._ring_at -= 3600          # asked for an hour after the ring
    assert await img.async_image() is None
    assert snap.await_count == 1
    for p in patches:
        p.stop()


async def test_open_door_from_the_notification_during_the_ring(hass, rung):
    entry, _, calls = rung
    action = _msgs(calls, "Iphone Test")[0]["data"]["actions"][1]["action"]
    with patch.object(api, "async_open_door", AsyncMock()) as opened:
        hass.bus.async_fire("mobile_app_notification_action", {"action": action})
        await hass.async_block_till_done()
    assert opened.await_count == 1
    assert _msgs(calls, "Iphone Test")[-1]["message"] == "Door opened"


async def test_open_door_refused_after_the_window(hass, rung):
    entry, _, calls = rung
    notifier = hass.data[DOMAIN][entry.entry_id]["ring_notifier"]
    notifier.calls[CALL].started = time.monotonic() - 3600
    action = _msgs(calls, "Iphone Test")[0]["data"]["actions"][1]["action"]
    with patch.object(api, "async_open_door", AsyncMock()) as opened:
        hass.bus.async_fire("mobile_app_notification_action", {"action": action})
        await hass.async_block_till_done()
    assert opened.await_count == 0
    assert _msgs(calls, "Iphone Test")[-1]["message"].startswith("This call is over")


async def test_open_door_refused_after_a_missed_call(hass, rung):
    _, _, calls = rung
    action = _msgs(calls, "Iphone Test")[0]["data"]["actions"][1]["action"]
    await _post(hass, _envelope("call_missed"))
    with patch.object(api, "async_open_door", AsyncMock()) as opened:
        hass.bus.async_fire("mobile_app_notification_action", {"action": action})
        await hass.async_block_till_done()
    assert opened.await_count == 0


async def test_open_door_failure_is_reported_not_swallowed(hass, rung):
    _, _, calls = rung
    action = _msgs(calls, "Iphone Test")[0]["data"]["actions"][1]["action"]
    with patch.object(api, "async_open_door", AsyncMock(side_effect=api.DoorbellApiError("boom"))):
        hass.bus.async_fire("mobile_app_notification_action", {"action": action})
        await hass.async_block_till_done()
    assert _msgs(calls, "Iphone Test")[-1]["message"].startswith("Could not open the door")


async def test_open_door_not_offered_by_default(hass):
    _, _, calls, patches = await _setup(hass, lambda ids: {CONF_NOTIFY_PHONES: [ids["Iphone Test"]]})
    await _post(hass, _envelope("ring"))
    assert [a["title"] for a in _msgs(calls, "Iphone Test")[0]["data"]["actions"]] == ["Open"]
    for p in patches:
        p.stop()


async def test_the_event_entity_lists_the_resolutions(hass, rung):
    st = [s for s in hass.states.async_all("event")][0]
    assert {"call_answered", "call_declined", "call_missed"} <= set(st.attributes["event_types"])


async def test_options_step_keeps_the_other_options(hass):
    entry, ids, _, patches = await _setup(hass)
    hass.config_entries.async_update_entry(entry, options={"entities": ["light.porche"]})
    await hass.async_block_till_done()
    flow = await hass.config_entries.options.async_init(entry.entry_id)
    flow = await hass.config_entries.options.async_configure(flow["flow_id"], {"next_step_id": "notifications"})
    result = await hass.config_entries.options.async_configure(flow["flow_id"], {
        CONF_NOTIFY_PHONES: [ids["M23 Test"]], CONF_NOTIFY_PANELS: [],
        CONF_NOTIFY_CRITICAL: True, CONF_NOTIFY_OPEN_DOOR: False})
    await hass.async_block_till_done()
    assert result["type"] == "create_entry"
    assert entry.options["entities"] == ["light.porche"]
    assert entry.options[CONF_NOTIFY_PHONES] == [ids["M23 Test"]]
    for p in patches:
        p.stop()


async def test_call_page_is_hidden_and_not_admin_only(hass):
    hass.config.components.add("frontend")
    await async_setup_component(hass, "http", {})
    with patch("homeassistant.components.frontend.async_remove_panel"), \
         patch("homeassistant.components.panel_custom.async_register_panel", AsyncMock()) as reg:
        await panel.async_register_call_page(hass)
    kw = reg.await_args.kwargs
    assert kw["frontend_url_path"] == "ig-doorbell"
    assert kw["sidebar_title"] is None and kw["require_admin"] is False


class _Resp:
    def __init__(self, status: int, body: bytes = b"") -> None:
        self.status, self._body = status, body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def read(self) -> bytes:
        return self._body


class _Session:
    def __init__(self, resp: _Resp) -> None:
        self.resp, self.urls = resp, []

    def get(self, url, timeout=None):
        self.urls.append(url)
        return self.resp


async def test_the_snapshot_request_is_marked_for_alert_so_call_snap_can_refuse_it():
    s = _Session(_Resp(200, b"JPEG"))
    assert await api.async_get_alert_snapshot(s, DEVICE_ID, CREDENTIAL, 4) == b"JPEG"
    assert "for=alert" in s.urls[0] and s.urls[0].startswith(f"https://{DEVICE_ID}.")
    with pytest.raises(api.SnapshotDisabledError):
        await api.async_get_alert_snapshot(_Session(_Resp(403)), DEVICE_ID, CREDENTIAL, 4)
    assert await api.async_get_alert_snapshot(_Session(_Resp(503)), DEVICE_ID, CREDENTIAL, 4) is None


class _TimeoutSession:
    """A doorbell that is off: no ARP answer, so every request TIMES OUT (not refused)."""

    def get(self, *a, **k):
        raise TimeoutError

    post = get

    async def close(self) -> None:
        return None


async def test_entry_loads_when_the_doorbell_times_out_at_startup(hass):
    """Found in the Docker HA run (2026-09-27): a doorbell that is simply OFF when Home Assistant
    starts made `async_set_hass_config` raise a bare TimeoutError (not an aiohttp.ClientError), the
    entry ended in `setup_error` - which Home Assistant does NOT retry - and no ring would ever be
    notified until someone reloaded the integration by hand."""
    from homeassistant.config_entries import ConfigEntryState

    await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=DEVICE_ID,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL, CONF_HOST_HINT: LAN_IP},
    )
    entry.add_to_hass(hass)
    with patch.object(net, "create_session", return_value=_TimeoutSession()), \
         patch.object(net, "is_this_doorbell", AsyncMock(return_value=False)):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        assert entry.state is ConfigEntryState.LOADED
        await hass.config_entries.async_unload(entry.entry_id)
        await hass.async_block_till_done()


async def test_two_doorbells_setting_up_at_once_register_the_call_page_once(hass):
    """Home Assistant sets up the entries of one integration concurrently. Without the lock both
    registered the static route and the second died with "method GET is already registered" (its
    entry in setup_error) - lived on a real installation, 2026-09-27."""
    import asyncio

    hass.config.components.add("frontend")
    await async_setup_component(hass, "http", {})
    with patch("homeassistant.components.frontend.async_remove_panel"),          patch("homeassistant.components.panel_custom.async_register_panel", AsyncMock()):
        await asyncio.gather(panel.async_register_call_page(hass), panel.async_register_call_page(hass))


async def test_a_failing_call_page_does_not_take_the_entry_down(hass):
    from homeassistant.config_entries import ConfigEntryState

    with patch.object(panel, "async_register_call_page", AsyncMock(side_effect=RuntimeError("boom"))),          patch("custom_components.ig_doorbell.async_register_call_page",
               AsyncMock(side_effect=RuntimeError("boom"))):
        entry, _, _, patches = await _setup(hass)
    assert entry.state is ConfigEntryState.LOADED
    for p in patches:
        p.stop()


@pytest.mark.parametrize("order", [("A", "B"), ("B", "A")])
async def test_two_doorbells_start_together_and_both_load(hass, order):
    """The startup that put a real doorbell's entry in setup_error (2026-09-27): Home Assistant
    boots with two doorbells and sets both entries up at the same time. Both must end LOADED,
    whichever is added first. The frontend is marked loaded so the call page really registers its
    static route (the part that raced); only the panel registry itself is stubbed."""
    from homeassistant.config_entries import ConfigEntryState

    hass.config.components.add("frontend")
    await async_setup_component(hass, "http", {})
    ids = {"A": DEVICE_ID, "B": "abcdefabcdefabcd"}
    entries = {}
    for k in order:
        e = MockConfigEntry(domain=DOMAIN, unique_id=ids[k],
                            data={CONF_DEVICE_ID: ids[k], CONF_CREDENTIAL: CREDENTIAL, CONF_HOST_HINT: LAN_IP})
        e.add_to_hass(hass)
        entries[k] = e
    state = {"m": 0, "door_m": 0, "webrtc_clients": 0, "dname": "Test", "panel": 0, "reader": 0}
    with patch.object(net, "is_this_doorbell", AsyncMock(return_value=True)), \
         patch.object(api, "async_get_states", AsyncMock(return_value=state)), \
         patch.object(api, "async_get_firmware_info", AsyncMock(return_value={"fw_version": "0.101.3"})), \
         patch.object(api, "async_get_role", AsyncMock(return_value="admin")), \
         patch.object(api, "async_set_hass_config", AsyncMock()), \
         patch("homeassistant.components.frontend.async_remove_panel"), \
         patch("homeassistant.components.panel_custom.async_register_panel", AsyncMock()), \
         patch("homeassistant.components.frontend.add_extra_js_url"):
        assert await async_setup_component(hass, DOMAIN, {})
        await hass.async_block_till_done()
        assert {k: e.state for k, e in entries.items()} == {
            "A": ConfigEntryState.LOADED, "B": ConfigEntryState.LOADED}
        for e in entries.values():
            await hass.config_entries.async_unload(e.entry_id)
        await hass.async_block_till_done()


async def test_a_refused_picture_is_not_announced_in_the_ring(hass):
    """call_snap=0 answered at the ring itself (403): the notice goes out without an image, instead
    of pointing the phone at an empty frame."""
    snap = AsyncMock(side_effect=api.SnapshotDisabledError("call_snapshot_disabled"))
    _, _, calls, patches = await _setup(hass, lambda ids: {CONF_NOTIFY_PHONES: [ids["Iphone Test"]]},
                                        snapshot=snap)
    await _post(hass, _envelope("ring"))
    assert "image" not in _msgs(calls, "Iphone Test")[0]["data"]
    for p in patches:
        p.stop()


async def test_the_missed_call_notice_keeps_the_picture_of_that_call(hass):
    """Measured on an iPhone: the 'missed call' that replaced the ring without the picture left the
    owner with no picture at all (the ring's own notice had it)."""
    _, _, calls, patches = await _setup(hass, lambda ids: {CONF_NOTIFY_PHONES: [ids["Iphone Test"]]})
    await _post(hass, _envelope("ring"))
    await _post(hass, _envelope("call_missed"))
    missed = _msgs(calls, "Iphone Test")[-1]
    assert missed["message"].startswith("Missed call") and missed["data"]["image"].startswith("/api/image_proxy/")
    for p in patches:
        p.stop()


async def test_after_a_newer_ring_the_older_missed_call_shows_no_picture(hass):
    """The picture held now belongs to the newer ring: showing it on the older call's notice would
    put somebody else's face on it."""
    _, _, calls, patches = await _setup(hass, lambda ids: {CONF_NOTIFY_PHONES: [ids["Iphone Test"]]})
    await _post(hass, _envelope("ring"))
    await _post(hass, _envelope("ring", call_id="newer"))
    await _post(hass, _envelope("call_missed"))
    missed = [m for m in _msgs(calls, "Iphone Test") if m["message"].startswith("Missed call")][0]
    assert "image" not in missed["data"]
    for p in patches:
        p.stop()


# ---- speakers that announce the call (announce.py) -------------------------------------------

async def _speakers(hass):
    from homeassistant.helpers import entity_registry as er

    reg, dreg = er.async_get(hass), dr.async_get(hass)
    alexa_entry = MockConfigEntry(domain="alexa_devices"); alexa_entry.add_to_hass(hass)
    echo = dreg.async_get_or_create(config_entry_id=alexa_entry.entry_id, identifiers={("alexa_devices", "echo1")})
    reg.async_get_or_create("media_player", "alexa_devices", "echo1_mp", device_id=echo.id,
                            config_entry=alexa_entry, suggested_object_id="echo_despacho")
    reg.async_get_or_create("notify", "alexa_devices", "echo1-announce", device_id=echo.id,
                            config_entry=alexa_entry, suggested_object_id="despacho_anunciar",
                            translation_key="announce")
    reg.async_get_or_create("notify", "alexa_devices", "echo1-speak", device_id=echo.id,
                            config_entry=alexa_entry, suggested_object_id="despacho_hablar",
                            translation_key="speak")
    hass.states.async_set("media_player.cast_salon", "idle")
    hass.states.async_set("tts.google_translate_en_com", "unknown")
    await hass.config.async_update(internal_url="http://192.168.1.2:8123")
    return {
        "sound": async_mock_service(hass, "alexa_devices", "send_sound"),
        "notify": async_mock_service(hass, "notify", "send_message"),
        "play": async_mock_service(hass, "media_player", "play_media"),
        "tts": async_mock_service(hass, "tts", "speak"),
    }, echo.id


async def test_speakers_announce_the_ring_alexa_with_its_chime_others_with_ours(hass):
    await async_setup_component(hass, "http", {})
    mocks, echo_id = await _speakers(hass)
    _, _, calls, patches = await _setup(hass, lambda ids: {
        "announce_players": ["media_player.echo_despacho", "media_player.cast_salon"],
        "announce_voice": True})
    await _post(hass, _envelope("ring", lang="es"))
    await hass.async_block_till_done()
    assert [c.data for c in mocks["sound"]] == [{"device_id": echo_id, "sound": "amzn_sfx_doorbell_chime_01"}]
    assert [c.data for c in mocks["notify"]] == [{"entity_id": "notify.despacho_anunciar",
                                                  "message": "Front door: están llamando a la puerta"}]
    (play,) = [c.data for c in mocks["play"]]
    assert play["entity_id"] == "media_player.cast_salon" and play["announce"] is True
    assert play["media_content_id"] == "http://192.168.1.2:8123/ig_doorbell/sounds/ig-doorbell-chime.mp3"
    assert [c.data["media_player_entity_id"] for c in mocks["tts"]] == ["media_player.cast_salon"]
    # No phone or panel was picked: the speakers alone are enough to announce.
    assert all(not c for c in calls.values())
    for p in patches:
        p.stop()


async def test_speakers_without_voice_only_chime(hass):
    await async_setup_component(hass, "http", {})
    mocks, _ = await _speakers(hass)
    _, _, _, patches = await _setup(hass, lambda ids: {"announce_players": ["media_player.echo_despacho"]})
    await _post(hass, _envelope("ring"))
    await hass.async_block_till_done()
    assert len(mocks["sound"]) == 1 and not mocks["notify"] and not mocks["tts"]
    for p in patches:
        p.stop()


async def test_the_chime_is_served_without_authentication(hass, hass_client_no_auth):
    _, _, _, patches = await _setup(hass)
    client = await hass_client_no_auth()
    resp = await client.get("/ig_doorbell/sounds/ig-doorbell-chime.mp3")
    assert resp.status == 200
    body = await resp.read()
    assert body[:3] == b"ID3" or body[:2] == b"\xff\xfb"
    for p in patches:
        p.stop()
