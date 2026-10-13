"""1.6.0: with several wall panels, ONE loads the live video on a ring (docs/design/panel-roles.md).

Three layers, in this order:
  1. the rules alone (panel_roles.py: no Home Assistant), including "never zero, never two" over
     generated cases checked against an independent reference;
  2. the migration of options stored before 1.6.0, through the real options flow;
  3. the notifier and the websocket: who is told what at the ring, when the primary is gone,
     when the call is resolved, and the iPad taken to the call page in place.

The companions are stand-ins (see test_ring_notifier); the doorbell is never contacted.
"""
from __future__ import annotations

import random
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from homeassistant.helpers import device_registry as dr
from homeassistant.util import dt as dt_util

from pytest_homeassistant_custom_component.common import async_fire_time_changed

from custom_components.ig_doorbell import call_page_nav, panel_roles, websocket_api
from custom_components.ig_doorbell.const import (
    CONF_NOTIFY_PANELS, CONF_NOTIFY_PHONES, CONF_NOTIFY_PRIMARY_PANEL, DOMAIN, RING_SAFETY_S,
)
from custom_components.ig_doorbell.panel_roles import AUTO, STANDBY, CallRoles

from .conftest import DEVICE_ID
from .test_call_page_nav import ANDROID, BROWSER, IOS, PAGE, _login, _with_panel_identity
from .test_ring_notifier import CALL, _envelope, _post, _setup

CALL_B = "99999999-2222-4333-8444-555555555555"
GRACE = panel_roles.PRIMARY_GRACE_S


# ---- 1. the rules alone ----------------------------------------------------------------------------

def test_the_declared_primary_goes_first_then_the_list_order():
    assert panel_roles.declared_order(["a", "b", "c"], "b") == ["b", "a", "c"]
    assert panel_roles.declared_order(["a", "b", "c"], "a") == ["a", "b", "c"]
    assert panel_roles.declared_order(["a", "b", "a", ""], "b") == ["b", "a"]   # no duplicates


def test_options_from_before_1_6_0_are_legacy_until_a_primary_is_stored():
    # nothing stored: every panel loads, with one panel or with several
    assert panel_roles.effective_primary(["a"], None) is None
    assert panel_roles.effective_primary(["a", "b"], None) is None
    assert panel_roles.effective_primary([], "a") is None
    # stored: it is the primary
    assert panel_roles.effective_primary(["a", "b"], "b") == "b"
    assert panel_roles.effective_primary(["a"], "a") == "a"
    # stored but no longer one of the panels: ONE loader is kept (the first), never "all" again
    assert panel_roles.effective_primary(["a", "b"], "gone") == "a"
    assert panel_roles.effective_primary(["a", "b"], "") == "a"


def test_a_saved_form_always_stores_a_primary_when_there_are_panels():
    assert panel_roles.primary_to_store(["a", "b"], None) == "a"
    assert panel_roles.primary_to_store(["a", "b"], "") == "a"
    assert panel_roles.primary_to_store(["a", "b"], "b") == "b"
    assert panel_roles.primary_to_store(["a"], None) == "a"
    assert panel_roles.primary_to_store([], "a") is None
    # what the form proposes is what saving it untouched would store
    assert panel_roles.form_default_primary(["a", "b"], None) == "a"
    assert panel_roles.form_default_primary(["a", "b"], "b") == "b"


def test_the_primary_takes_the_video_at_once_and_the_others_wait():
    r = CallRoles(order=["p", "s1", "s2"], ring_at=100.0)
    assert r.claim("s1", 100.5) == STANDBY      # a secondary first: it waits for the primary
    assert r.claim("p", 101.0) == AUTO
    assert r.claim("s2", 101.5) == STANDBY
    assert r.claim("s1", 150.0) == STANDBY      # long after the grace: the holder never changes
    assert r.tick(100.0 + GRACE) is None
    assert r.claim("stranger", 101.0) is None   # not a panel of this call


def test_the_role_passes_in_the_declared_order_when_the_primary_does_not_show_up():
    r = CallRoles(order=["p", "s1", "s2"], ring_at=0.0)
    assert r.claim("s2", 1.0) == STANDBY
    assert r.claim("s1", 2.0) == STANDBY
    assert r.tick(GRACE - 0.1) is None          # the primary still has its chance
    assert r.tick(GRACE) == "s1"                # s1 ranks above s2, though s2 reported first
    assert r.role("s1") == AUTO and r.role("s2") == STANDBY
    assert r.claim("p", GRACE + 3) == STANDBY   # the primary woke late: never a second video
    assert r.tick(GRACE + 10) is None


def test_after_the_grace_the_first_panel_to_show_up_takes_it():
    r = CallRoles(order=["p", "s1", "s2"], ring_at=0.0)
    assert r.tick(GRACE) is None                # nobody is there: nobody to promote
    assert r.claim("s2", GRACE + 1) == AUTO
    assert r.claim("s1", GRACE + 2) == STANDBY
    assert r.claim("p", GRACE + 3) == STANDBY


def test_a_late_tick_still_gives_it_to_the_best_ranked_and_says_who():
    """The timer ran late: a claim after the grace finds a better-ranked panel already waiting."""
    r = CallRoles(order=["p", "s1", "s2"], ring_at=0.0)
    assert r.claim("s1", 1.0) == STANDBY
    assert r.claim("s2", GRACE + 1) == STANDBY  # s1 was there first AND ranks higher
    assert r.holder == "s1"


def test_legacy_every_panel_loads():
    r = CallRoles(order=["a", "b", "c"], ring_at=0.0, legacy=True)
    assert [r.claim(p, 1.0) for p in "abc"] == [AUTO, AUTO, AUTO]
    assert r.tick(GRACE) is None and r.holder is None


def _reference_holder(order, events, grace):
    """Who must hold the video, worked out from the rule's WORDS, not from the code under test."""
    first = {}
    for t, p in events:
        first.setdefault(p, t)
    if not first:
        return None
    if order[0] in first and first[order[0]] < grace:
        return order[0]
    early = [p for p in order if p in first and first[p] < grace]
    if early:
        return early[0]                                     # promoted at the grace, in order
    late = [(t, i, p) for i, (t, p) in enumerate(events)]
    return min(late)[2]                                     # the first to show up after it


def test_never_zero_never_two_over_generated_calls():
    rng = random.Random(1600)
    for case in range(3000):
        n = rng.randint(1, 5)
        order = [f"p{i}" for i in range(n)]
        events = sorted(((round(rng.uniform(0, 3 * GRACE), 2), rng.choice(order))
                         for _ in range(rng.randint(0, 8))), key=lambda e: e[0])
        # never exactly at the grace: there the order of the tick and the claim is the timer's
        events = [(t if t != GRACE else t + 0.01, p) for t, p in events]
        r = CallRoles(order=list(order), ring_at=0.0)
        told_auto: set[str] = set()
        ticked = False
        reported: set[str] = set()

        def check(now):
            loading = [p for p in order if r.role(p) == AUTO]
            assert len(loading) <= 1, (case, order, events, loading)                 # never two
            if reported and (now >= GRACE or order[0] in reported):
                assert len(loading) == 1, (case, order, events, now)                 # never zero
            assert len(told_auto) <= 1, (case, order, events, told_auto)             # ...ever

        for t, p in events:
            if t >= GRACE and not ticked:
                ticked = True
                promoted = r.tick(GRACE)
                if promoted:
                    told_auto.add(promoted)
                check(GRACE)
            reported.add(p)
            if r.claim(p, t) == AUTO:
                told_auto.add(p)
            if r.holder:
                told_auto.add(r.holder)
            check(t)
        if not ticked:
            promoted = r.tick(GRACE)
            if promoted:
                told_auto.add(promoted)
            check(GRACE)
        assert r.holder == _reference_holder(order, events, GRACE), (case, order, events)


# ---- 2. the migration, through the real options flow ----------------------------------------------

def _three(ids, **extra):
    return {CONF_NOTIFY_PANELS: [ids["Tab Test"], ids["Ipad Test"], ids["M23 Test"]],
            CONF_NOTIFY_PHONES: [ids["Iphone Test"]], **extra}


def _roles_on(ids, primary="Tab Test"):
    return _three(ids, **{CONF_NOTIFY_PRIMARY_PANEL: ids[primary]})


async def _open_form(hass, entry):
    flow = await hass.config_entries.options.async_init(entry.entry_id)
    return await hass.config_entries.options.async_configure(
        flow["flow_id"], {"next_step_id": "notifications"})


def _suggested(form, key):
    for k in form["data_schema"].schema:
        if k == key:
            return (k.description or {}).get("suggested_value")
    raise AssertionError(f"{key} is not in the form")


async def test_old_options_get_a_primary_only_when_the_form_is_saved(hass):
    entry, ids, _, patches = await _setup(hass, _three)
    notifier = hass.data[DOMAIN][entry.entry_id]["ring_notifier"]
    # upgraded, untouched: no primary stored, nothing is told to any panel (as 1.5.4)
    assert CONF_NOTIFY_PRIMARY_PANEL not in entry.options
    assert notifier.roles_configured(ids["Tab Test"]) is False
    # the form SHOWS who will load: the first panel of the stored list
    form = await _open_form(hass, entry)
    assert _suggested(form, CONF_NOTIFY_PRIMARY_PANEL) == ids["Tab Test"]
    # saved untouched (the main panel field left as proposed = not sent back empty)
    result = await hass.config_entries.options.async_configure(form["flow_id"], {
        CONF_NOTIFY_PANELS: entry.options[CONF_NOTIFY_PANELS],
        CONF_NOTIFY_PHONES: entry.options[CONF_NOTIFY_PHONES]})
    await hass.async_block_till_done()
    assert result["type"] == "create_entry"
    assert entry.options[CONF_NOTIFY_PRIMARY_PANEL] == ids["Tab Test"]
    assert entry.options[CONF_NOTIFY_PANELS] == [ids["Tab Test"], ids["Ipad Test"], ids["M23 Test"]]
    for p in patches:
        p.stop()


async def test_the_owner_picks_another_primary_and_a_foreign_one_is_refused(hass):
    entry, ids, _, patches = await _setup(hass, _three)
    form = await _open_form(hass, entry)
    refused = await hass.config_entries.options.async_configure(form["flow_id"], {
        CONF_NOTIFY_PANELS: [ids["Tab Test"], ids["Ipad Test"]],
        CONF_NOTIFY_PRIMARY_PANEL: ids["Iphone Test"]})          # a phone, not one of the panels
    assert refused["type"] == "form"
    assert refused["errors"] == {CONF_NOTIFY_PRIMARY_PANEL: "primary_not_a_panel"}
    assert CONF_NOTIFY_PRIMARY_PANEL not in entry.options       # nothing was saved
    result = await hass.config_entries.options.async_configure(refused["flow_id"], {
        CONF_NOTIFY_PANELS: [ids["Tab Test"], ids["Ipad Test"]],
        CONF_NOTIFY_PRIMARY_PANEL: ids["Ipad Test"]})
    await hass.async_block_till_done()
    assert result["type"] == "create_entry"
    assert entry.options[CONF_NOTIFY_PRIMARY_PANEL] == ids["Ipad Test"]
    for p in patches:
        p.stop()


async def test_with_no_panel_left_no_primary_is_kept(hass):
    entry, ids, _, patches = await _setup(hass, _roles_on)
    form = await _open_form(hass, entry)
    await hass.config_entries.options.async_configure(form["flow_id"], {
        CONF_NOTIFY_PANELS: [], CONF_NOTIFY_PHONES: [ids["Iphone Test"]]})
    await hass.async_block_till_done()
    assert CONF_NOTIFY_PRIMARY_PANEL not in entry.options
    for p in patches:
        p.stop()


# ---- 3. the notifier ------------------------------------------------------------------------------

async def _rung(hass, options_for=_roles_on, **kw):
    entry, ids, calls, patches = await _setup(hass, options_for, **kw)
    notifier = hass.data[DOMAIN][entry.entry_id]["ring_notifier"]
    return entry, ids, calls, patches, notifier


def _listen(notifier, ids, *names):
    got = {n: [] for n in names}
    for n in names:
        notifier.async_panel_subscribe(ids[n], got[n].append)
    return got


async def test_every_panel_rings_and_only_the_primary_loads(hass):
    snap = AsyncMock(return_value=b"JPEG")
    entry, ids, calls, patches, notifier = await _rung(hass, snapshot=snap)
    await _post(hass, _envelope("ring"))
    # ALL of them ring: the notice goes to the three panels and the phone
    for name in ("Tab Test", "Ipad Test", "M23 Test", "Iphone Test"):
        assert any(c.data["message"] == "Someone is at the door" for c in calls[name]), name
    told = {n: notifier.panel_instruction(ids[n]) for n in ("Ipad Test", "M23 Test", "Tab Test")}
    assert told["Tab Test"]["stream"] == "auto"
    assert told["Ipad Test"]["stream"] == "standby" and told["M23 Test"]["stream"] == "standby"
    assert all(t["call_id"] == CALL and t["phase"] == "ringing" for t in told.values())
    # the still picture: the integration's ONE image entity for every panel...
    image = hass.data[DOMAIN][entry.entry_id]["visitor_image"].entity_id
    assert {t["still_entity"] for t in told.values()} == {image}
    # ...filled by ONE snapshot request for the whole ring, however many panels asked
    assert snap.await_count == 1
    # a phone is never a panel: nothing is told to it
    assert notifier.panel_instruction(ids["Iphone Test"]) is None
    for p in patches:
        p.stop()


async def test_legacy_options_tell_no_panel_anything(hass):
    entry, ids, calls, patches, notifier = await _rung(hass, _three)
    got = _listen(notifier, ids, "Tab Test", "Ipad Test")
    await _post(hass, _envelope("ring"))
    assert all(notifier.panel_instruction(ids[n]) is None for n in ("Tab Test", "Ipad Test", "M23 Test"))
    await _post(hass, _envelope("call_answered"))
    assert got == {"Tab Test": [], "Ipad Test": []}
    for p in patches:
        p.stop()


async def test_a_primary_home_assistant_knows_is_gone_is_skipped_at_once(hass):
    entry, ids, calls, patches, notifier = await _rung(hass)
    reg = dr.async_get(hass)
    reg.async_update_device(ids["Tab Test"], disabled_by=dr.DeviceEntryDisabler.USER)
    await _post(hass, _envelope("ring"))
    # no wait: the next panel of the list is first in the order
    assert notifier.panel_instruction(ids["Ipad Test"])["stream"] == "auto"
    assert notifier.panel_instruction(ids["M23 Test"])["stream"] == "standby"
    assert notifier.panel_instruction(ids["Tab Test"]) is None
    for p in patches:
        p.stop()


async def test_a_primary_removed_from_home_assistant_is_skipped_too(hass):
    entry, ids, calls, patches, notifier = await _rung(hass)
    dr.async_get(hass).async_remove_device(ids["Tab Test"])
    await _post(hass, _envelope("ring"))
    assert notifier.panel_instruction(ids["M23 Test"])["stream"] == "standby"
    assert notifier.panel_instruction(ids["Ipad Test"])["stream"] == "auto"
    for p in patches:
        p.stop()


async def test_the_primary_does_not_show_up_and_a_waiting_panel_is_told_to_load(hass):
    entry, ids, calls, patches, notifier = await _rung(hass)
    await _post(hass, _envelope("ring"))
    # the third panel's page is there (it asked), the primary's is not
    assert notifier.panel_instruction(ids["M23 Test"])["stream"] == "standby"
    got = _listen(notifier, ids, "M23 Test")
    assert [m["stream"] for m in got["M23 Test"]] == ["standby"]
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=GRACE + 1))
    await hass.async_block_till_done()
    assert [m["stream"] for m in got["M23 Test"]] == ["standby", "auto"]     # pushed, not polled
    # the primary wakes late: it is NOT given a second video
    assert notifier.panel_instruction(ids["Tab Test"])["stream"] == "standby"
    assert notifier.panel_instruction(ids["M23 Test"])["stream"] == "auto"
    for p in patches:
        p.stop()


async def test_a_primary_already_listening_keeps_the_role_at_the_ring(hass):
    """Its card was on screen before the ring: no page 'opens', so nothing would report in."""
    entry, ids, calls, patches, notifier = await _rung(hass)
    got = _listen(notifier, ids, "Ipad Test", "Tab Test")          # the secondary subscribed first
    await _post(hass, _envelope("ring"))
    assert [m["stream"] for m in got["Tab Test"]] == ["auto"]
    assert [m["stream"] for m in got["Ipad Test"]] == ["standby"]
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=GRACE + 1))
    await hass.async_block_till_done()
    assert [m["stream"] for m in got["Ipad Test"]] == ["standby"]  # nobody is promoted over it
    for p in patches:
        p.stop()


async def test_answered_tells_every_panel_to_give_the_video_back(hass):
    entry, ids, calls, patches, notifier = await _rung(hass)
    got = _listen(notifier, ids, "Tab Test", "Ipad Test", "M23 Test")
    await _post(hass, _envelope("ring"))
    await _post(hass, _envelope("call_answered", by="Somebody"))
    for name, msgs in got.items():
        assert msgs[-1] == {**msgs[-1], "call_id": CALL, "phase": "answered", "stream": "release"}, name
    # a panel that wakes up just after: told about THAT call, never to load by itself
    late = notifier.panel_instruction(ids["Tab Test"])
    assert late["phase"] == "answered" and late["stream"] == "release"
    # ...and later it is just a page somebody opened
    notifier.calls[CALL].resolved_at -= 31
    assert notifier.panel_instruction(ids["Tab Test"]) is None
    for p in patches:
        p.stop()


async def test_missed_and_declined_leave_the_video_alone(hass):
    entry, ids, calls, patches, notifier = await _rung(hass)
    got = _listen(notifier, ids, "Tab Test", "Ipad Test")
    for ev, phase in (("call_missed", "missed"), ("call_declined", "declined")):
        call_id = f"{phase}-0000-4333-8444-555555555555"
        await _post(hass, _envelope("ring", call_id=call_id))
        await _post(hass, _envelope(ev, call_id=call_id))
        for msgs in got.values():
            assert (msgs[-1]["phase"], msgs[-1]["stream"], msgs[-1]["call_id"]) == (phase, "keep", call_id)
    for p in patches:
        p.stop()


async def test_a_resolution_of_an_earlier_call_is_never_told_over_the_current_ring(hass):
    entry, ids, calls, patches, notifier = await _rung(hass)
    await _post(hass, _envelope("ring"))
    got = _listen(notifier, ids, "Tab Test", "Ipad Test")
    await _post(hass, _envelope("ring", call_id=CALL_B))               # two rings in a row
    assert got["Tab Test"][-1]["call_id"] == CALL_B and got["Tab Test"][-1]["stream"] == "auto"
    before = {n: len(m) for n, m in got.items()}
    await _post(hass, _envelope("call_missed"))                        # the FIRST call, late
    assert {n: len(m) for n, m in got.items()} == before
    assert notifier.panel_instruction(ids["Ipad Test"]) == {
        **notifier.panel_instruction(ids["Ipad Test"]), "call_id": CALL_B, "phase": "ringing",
        "stream": "standby"}
    for p in patches:
        p.stop()


async def test_no_resolution_the_panels_are_told_the_ring_is_over(hass):
    """A firmware before 0.101.3: no call_answered / call_missed ever comes."""
    entry, ids, calls, patches, notifier = await _rung(hass)
    got = _listen(notifier, ids, "Tab Test", "Ipad Test")
    await _post(hass, _envelope("ring"))
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=RING_SAFETY_S + 1))
    await hass.async_block_till_done()
    for msgs in got.values():
        assert (msgs[-1]["phase"], msgs[-1]["stream"]) == ("ended", "keep")   # never an invented outcome
    assert notifier.panel_instruction(ids["Ipad Test"]) is None
    for p in patches:
        p.stop()


# ---- the websocket: the role travels with the page's identity --------------------------------------

async def test_the_call_page_is_told_its_role_and_only_a_picked_panel_listens(hass, hass_ws_client):
    entry, ids, calls, patches, notifier = await _rung(hass)
    kiosk = await hass.auth.async_create_user("Kiosk")
    hall = await hass.auth.async_create_user("Hall")
    _with_panel_identity(hass, ids, kiosk.id, name="Tab Test")
    _with_panel_identity(hass, ids, hall.id, name="M23 Test", model="SM-M236B")
    websocket_api.async_register_websocket_commands(hass)
    await _post(hass, _envelope("ring"))

    async def _page(user, client_id):
        rt = await hass.auth.async_create_refresh_token(user, client_id=client_id)
        ws = await hass_ws_client(hass, access_token=hass.auth.async_create_access_token(rt))
        await ws.send_json({"id": 1, "type": "ig_doorbell/get_connection_info", "device_id": DEVICE_ID})
        r = await ws.receive_json()
        assert r["success"], r
        return ws, r["result"]

    # a secondary panel's page, first to open: the still picture, and it should listen
    ws_hall, info = await _page(hall, ANDROID)
    assert info["panel_sub"] is True and info["panel_call"]["stream"] == "standby"
    # the primary's page
    _ws, info = await _page(kiosk, ANDROID)
    assert info["panel_sub"] is True and info["panel_call"]["stream"] == "auto"
    assert info["panel_call"]["call_id"] == CALL
    # the same user in a desktop browser: not a panel - no role, nothing to listen to
    ws_pc, info = await _page(kiosk, BROWSER)
    assert info["panel_sub"] is False and info["panel_call"] is None
    # both subscribe; only the panel is ever sent anything
    for ws in (ws_hall, ws_pc):
        await ws.send_json({"id": 2, "type": "ig_doorbell/subscribe_panel_call", "device_id": DEVICE_ID})
        assert (await ws.receive_json())["success"]
    first = await ws_hall.receive_json()
    assert first["event"]["stream"] == "standby"
    await _post(hass, _envelope("call_answered"))
    assert (await ws_hall.receive_json())["event"]["stream"] == "release"
    assert len(notifier.panel_subs) == 1                       # the browser was never registered
    for p in patches:
        p.stop()


# ---- the iPad: taken to the call page in place, like an Android panel -------------------------------

async def _ipad_ring(hass, page):
    entry, ids, calls, patches = await _setup(hass, lambda ids: {CONF_NOTIFY_PANELS: [ids["Ipad Test"]]})
    user = await hass.auth.async_create_user("Kitchen")
    _with_panel_identity(hass, ids, user.id, name="Ipad Test", model="iPad13,2")
    ipad = await _login(hass, user, IOS)
    nav = call_page_nav.async_get(hass)
    got = []
    if page:
        def _send(payload):
            got.append(payload)
            if page == "ack":
                nav.async_ack(payload["token"], user.id, ipad)
        nav.async_subscribe(user.id, ipad, _send)
    with patch.object(call_page_nav, "ACK_LIVE_S", 0.3), patch.object(call_page_nav, "ACK_RECENT_S", 0.3):
        await _post(hass, _envelope("ring"))
    msgs = [c.data["message"] for c in calls["Ipad Test"]]
    for p in patches:
        p.stop()
    return msgs, got


async def test_an_ipad_showing_home_assistant_is_taken_to_the_call_page_in_place(hass):
    msgs, got = await _ipad_ring(hass, "ack")
    assert got and got[0]["url"] == PAGE                      # its own page was asked to navigate
    # and never an Android command: iOS has none
    assert not [m for m in msgs if m.startswith("command_")]
    assert "Someone is at the door" in msgs                   # the notification, as always


async def test_an_ipad_with_no_page_only_gets_its_notification(hass):
    msgs, _got = await _ipad_ring(hass, None)
    assert msgs == ["Someone is at the door"]


async def test_an_ipad_whose_page_does_not_answer_only_gets_its_notification(hass):
    msgs, got = await _ipad_ring(hass, "silent")              # asleep, or behind another app
    assert got and msgs == ["Someone is at the door"]
